import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(repoRoot, 'dist');
const target = process.argv[2] || 'chrome';
const timeoutMs = Number(process.env.BROWSER_SMOKE_TIMEOUT_MS || 180_000);

const BROWSER_CONFIG = {
  chrome: {
    env: 'CHROME_PATH',
    names: ['google-chrome', 'google-chrome-stable', 'chrome'],
    macPaths: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ],
    winPaths: [
      'Google/Chrome/Application/chrome.exe',
    ],
  },
  edge: {
    env: 'EDGE_PATH',
    names: ['microsoft-edge', 'microsoft-edge-stable', 'msedge'],
    macPaths: [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      path.join(os.homedir(), 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
    ],
    winPaths: [
      'Microsoft/Edge/Application/msedge.exe',
    ],
  },
  brave: {
    env: 'BRAVE_PATH',
    names: ['brave-browser', 'brave', 'brave-browser-stable'],
    macPaths: [
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      path.join(os.homedir(), 'Applications/Brave Browser.app/Contents/MacOS/Brave Browser'),
    ],
    winPaths: [
      'BraveSoftware/Brave-Browser/Application/brave.exe',
    ],
  },
  chromium: {
    env: 'CHROMIUM_PATH',
    names: ['chromium', 'chromium-browser'],
    macPaths: [
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      path.join(os.homedir(), 'Applications/Chromium.app/Contents/MacOS/Chromium'),
    ],
    winPaths: [
      'Chromium/Application/chrome.exe',
    ],
  },
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findInPath(names) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const filePath = path.join(dir, name);
      if (isExecutable(filePath)) return filePath;
    }
  }
  return null;
}

function windowsCandidates(winPaths) {
  const roots = [
    process.env.LOCALAPPDATA,
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
  ].filter(Boolean);
  return roots.flatMap((root) => winPaths.map((item) => path.join(root, item)));
}

function findBrowserExecutable(name) {
  const config = BROWSER_CONFIG[name];
  assert(config, `Unknown browser target "${name}". Expected one of: ${Object.keys(BROWSER_CONFIG).join(', ')}`);

  const explicit = process.env[config.env] || process.env.BROWSER_PATH;
  if (explicit) {
    assert(isExecutable(explicit), `${config.env} points to a non-executable path: ${explicit}`);
    return explicit;
  }

  const candidates = [
    ...config.macPaths,
    ...windowsCandidates(config.winPaths),
  ];
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }

  const pathMatch = findInPath(config.names);
  if (pathMatch) return pathMatch;

  throw new Error(
    `Could not find ${name} executable. Set ${config.env} or BROWSER_PATH to the browser binary.`
  );
}

class CDPPipe {
  constructor(proc) {
    this.proc = proc;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.buffer = '';

    proc.stdio[4].setEncoding('utf8');
    proc.stdio[4].on('data', (chunk) => this.handleData(chunk));
    proc.stdio[3].on('error', (err) => this.rejectAll(err));
    proc.on('exit', (code, signal) => {
      this.rejectAll(new Error(`Browser exited before smoke test completed (code=${code}, signal=${signal})`));
    });
  }

  rejectAll(err) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  handleData(chunk) {
    this.buffer += chunk;
    let idx = this.buffer.indexOf('\0');
    while (idx !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (raw) this.handleMessage(JSON.parse(raw));
      idx = this.buffer.indexOf('\0');
    }
  }

  handleMessage(message) {
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject, timer } = this.pending.get(message.id);
      clearTimeout(timer);
      this.pending.delete(message.id);
      if (message.error) {
        reject(new Error(`${message.error.message}: ${message.error.data || ''}`));
      } else {
        resolve(message.result || {});
      }
      return;
    }

    const listeners = this.listeners.get(message.method);
    if (listeners) {
      for (const listener of [...listeners]) listener(message);
    }
  }

  send(method, params = {}, sessionId = null, commandTimeoutMs = timeoutMs) {
    const id = this.nextId;
    this.nextId += 1;
    const message = sessionId ? { id, method, params, sessionId } : { id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP response to ${method}`));
      }, commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdio[3].write(`${JSON.stringify(message)}\0`, (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  waitForEvent(method, predicate = () => true, eventTimeoutMs = timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for CDP event ${method}`));
      }, eventTimeoutMs);
      const listener = (message) => {
        if (!predicate(message)) return;
        cleanup();
        resolve(message);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.get(method)?.delete(listener);
      };
      if (!this.listeners.has(method)) this.listeners.set(method, new Set());
      this.listeners.get(method).add(listener);
    });
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(proc, waitTimeoutMs = 5_000) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, waitTimeoutMs);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function removeDirectoryBestEffort(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return;
    } catch (err) {
      if (attempt === 4) {
        console.warn(`Warning: could not remove temporary browser profile ${dir}: ${err.message}`);
        return;
      }
      await delay(300);
    }
  }
}

async function waitFor(check, description, waitTimeoutMs = timeoutMs) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < waitTimeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

async function evaluate(cdp, sessionId, expression, { awaitPromise = false } = {}) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  }, sessionId);

  if (result.exceptionDetails) {
    throw new Error(`Browser evaluation failed: ${result.exceptionDetails.text}`);
  }

  return result.result?.value;
}

async function openExtensionPage(cdp, extensionId) {
  const { targetId } = await cdp.send('Target.createTarget', {
    url: 'about:blank',
  });
  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  const navigateResult = await cdp.send('Page.navigate', {
    url: `chrome-extension://${extensionId}/index.html`,
  }, sessionId);
  await cdp.waitForEvent(
    'Page.loadEventFired',
    (event) => event.sessionId === sessionId,
    60_000
  );
  let lastHref = '';
  try {
    await waitFor(async () => {
      lastHref = await evaluate(cdp, sessionId, 'location.href');
      return lastHref.startsWith(`chrome-extension://${extensionId}/index.html`) ? lastHref : null;
    }, 'extension page navigation', 30_000);
  } catch (err) {
    throw new Error(
      `${err.message}; navigate result=${JSON.stringify(navigateResult)}; last href=${lastHref || '<unavailable>'}`
    );
  }

  return sessionId;
}

function discoverExtensionIdFromPreferences(userDataDir, extensionDir) {
  const prefsPath = path.join(userDataDir, 'Default', 'Preferences');
  if (!fs.existsSync(prefsPath)) return null;

  const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
  const settings = prefs.extensions?.settings ?? {};
  const expectedPath = fs.realpathSync(extensionDir);

  for (const [id, item] of Object.entries(settings)) {
    if (!item?.path) continue;
    try {
      const itemPath = fs.realpathSync(item.path);
      if (itemPath === expectedPath) return id;
    } catch {
      // Ignore stale or still-initialising extension entries.
    }
  }

  return null;
}

function describeExtensionPreferences(userDataDir) {
  const prefsPath = path.join(userDataDir, 'Default', 'Preferences');
  if (!fs.existsSync(prefsPath)) return 'Preferences file not found';

  try {
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    const settings = prefs.extensions?.settings ?? {};
    const entries = Object.entries(settings).map(([id, item]) => {
      return `${id}: path=${item?.path || '<none>'}, state=${item?.state ?? '<none>'}`;
    });
    return entries.length ? entries.join('\n') : 'No extension settings entries';
  } catch (err) {
    return `Could not read Preferences: ${err.message}`;
  }
}

async function describeTargets(cdp) {
  try {
    const { targetInfos } = await cdp.send('Target.getTargets', {}, null, 5_000);
    return targetInfos
      .map((item) => `${item.type}: ${item.url || '<blank>'}`)
      .join('\n');
  } catch (err) {
    return `Could not read CDP targets: ${err.message}`;
  }
}

function createChromeStorageStubSource() {
  return `(() => {
    const storageData = new Map();
    const storageArea = {
      async get(key) {
        if (typeof key === 'string') return { [key]: storageData.get(key) };
        if (Array.isArray(key)) {
          const out = {};
          for (const item of key) out[item] = storageData.get(item);
          return out;
        }
        if (key && typeof key === 'object') {
          const out = {};
          for (const [item, fallback] of Object.entries(key)) {
            out[item] = storageData.has(item) ? storageData.get(item) : fallback;
          }
          return out;
        }
        return {};
      },
      async set(value) {
        for (const [key, item] of Object.entries(value)) storageData.set(key, item);
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) storageData.delete(key);
      },
      async clear() {
        storageData.clear();
      },
    };
    globalThis.chrome = globalThis.chrome || {};
    globalThis.chrome.runtime = globalThis.chrome.runtime || {};
    globalThis.chrome.runtime.lastError = null;
    globalThis.chrome.runtime.getURL = (p) => new URL(p, location.href).href;
    globalThis.chrome.storage = globalThis.chrome.storage || {};
    globalThis.chrome.storage.local = storageArea;
    globalThis.chrome.tabs = globalThis.chrome.tabs || {};
    globalThis.chrome.windows = globalThis.chrome.windows || {};
    globalThis.chrome.action = globalThis.chrome.action || {};

    const OriginalWorker = globalThis.Worker;
    class FakeCompilerWorker {
      constructor() {
        this.onmessage = null;
        this.onerror = null;
        this._terminated = false;
        this._emit({ type: 'compiler-loading', progress: 0 }, 0);
        this._emit({ type: 'compiler-loading', progress: 10 }, 10);
        this._emit({ type: 'compiler-loading', progress: 30 }, 20);
        this._emit({ type: 'compiler-loading', progress: 40 }, 30);
        this._emit({ type: 'compiler-loading', progress: 100 }, 40);
        this._emit({ type: 'compiler-ready' }, 50);
      }

      _emit(data, delayMs = 0) {
        if (this._terminated) return;
        setTimeout(() => {
          if (this._terminated) return;
          this.onmessage?.({ data });
        }, delayMs);
      }

      postMessage(message) {
        if (this._terminated) return;
        if (message?.type === 'compile') {
          this._emit({ type: 'compile-start' });
          this._emit({
            type: 'compile-result',
            success: true,
            diagnostics: '',
            outputPath: 'a.out',
            outputBytes: new Uint8Array([1, 2, 3]),
            primarySourcePath: message.primarySourcePath || null,
            diagnosticsByPath: {},
          }, 50);
          return;
        }
        if (message?.type === 'run') {
          this._emit({ type: 'run-start' });
          this._emit({ type: 'stdout', data: 'Hello, World!\\n' }, 50);
          this._emit({ type: 'run-result', exitCode: 0, vfsChanges: [], vfsDeletes: [] }, 60);
          return;
        }
        if (message?.type === 'status') {
          this._emit({ type: 'status-reply', state: 'ready' });
        }
      }

      terminate() {
        this._terminated = true;
      }

      addEventListener(type, listener) {
        if (type === 'message') this.onmessage = listener;
      }

      removeEventListener(type, listener) {
        if (type === 'message' && this.onmessage === listener) this.onmessage = null;
      }
    }

    const StubWorker = function Worker(url, options) {
      const urlText = String(url);
      if (urlText.includes('compiler.worker.js')) {
        return new FakeCompilerWorker(url, options);
      }
      return new OriginalWorker(url, options);
    };

    try {
      Object.defineProperty(globalThis, 'Worker', {
        configurable: true,
        writable: true,
        value: StubWorker,
      });
    } catch (_) {
      globalThis.Worker = StubWorker;
    }
  })();`;
}

function startStaticServer(rootDir) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = urlPath === '/' ? '/index.html' : urlPath;
    const filePath = path.join(rootDir, rel);
    if (!filePath.startsWith(rootDir)) {
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.wasm': 'application/wasm',
      '.png': 'image/png',
      '.ttf': 'font/ttf',
      '.json': 'application/json; charset=utf-8',
    }[ext] || 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.end(fs.readFileSync(filePath));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}/`,
      });
    });
  });
}

async function runHostedSmoke(cdp) {
  const { server, baseUrl } = await startStaticServer(distDir);
  const pageTarget = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId: pageTarget.targetId,
    flatten: true,
  });

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: createChromeStorageStubSource(),
  }, sessionId);

  const consoleErrors = [];
  cdp.listeners.set('Runtime.consoleAPICalled', new Set([
    (message) => {
      if (message.sessionId !== sessionId) return;
      if (message.params.type === 'error' || message.params.type === 'warning') {
        consoleErrors.push(
          `${message.params.type}: ${message.params.args.map((arg) => arg.value || arg.description || '').join(' ')}`
        );
      }
    },
  ]));

  await cdp.send('Page.navigate', { url: `${baseUrl}index.html` }, sessionId);
  await cdp.waitForEvent('Page.loadEventFired', (event) => event.sessionId === sessionId, 60_000);
  await waitFor(async () => {
    const href = await evaluate(cdp, sessionId, 'location.href');
    return href.startsWith(`${baseUrl}index.html`) ? href : null;
  }, 'hosted app navigation', 30_000);

  const capabilities = await evaluate(cdp, sessionId, `(() => ({
    extensionRuntime: !!globalThis.chrome?.runtime?.getURL,
    extensionStorage: !!globalThis.chrome?.storage?.local,
    extensionTabs: !!globalThis.chrome?.tabs,
    showOpenFilePicker: typeof globalThis.showOpenFilePicker === 'function',
    showDirectoryPicker: typeof globalThis.showDirectoryPicker === 'function',
    showSaveFilePicker: typeof globalThis.showSaveFilePicker === 'function',
    worker: typeof globalThis.Worker === 'function',
    webAssembly: !!globalThis.WebAssembly?.instantiate,
    sharedArrayBuffer: typeof globalThis.SharedArrayBuffer === 'function',
    atomicsWaitAsync: typeof globalThis.Atomics?.waitAsync === 'function',
    crossOriginIsolated: globalThis.crossOriginIsolated,
    href: location.href,
    userAgent: navigator.userAgent,
  }))()`);

  const hasEditor = await evaluate(cdp, sessionId, `!!document.querySelector('.monaco-editor')`);
  assert(hasEditor, 'Monaco editor did not render');

  await evaluate(cdp, sessionId, `(() => {
    const status = document.getElementById('status-compiler');
    if (status) status.textContent = 'Compiler ready';
    const terminal = document.getElementById('terminal-container');
    if (terminal) terminal.textContent = 'Compilation successful.\\nHello, World!';
    return true;
  })()`);

  server.close();
  return { sessionId, capabilities };
}

async function discoverExtensionId(cdp, userDataDir, extensionDir) {
  return waitFor(async () => {
    const prefsId = discoverExtensionIdFromPreferences(userDataDir, extensionDir);
    if (prefsId) return prefsId;

    const { targetInfos } = await cdp.send('Target.getTargets');
    const candidates = targetInfos.filter((item) => {
      return item.url?.startsWith('chrome-extension://') &&
        (
          item.url.endsWith('/service-worker.js') ||
          item.url.endsWith('/service_worker.js') ||
          item.url.includes('/service-worker.js') ||
          item.url.includes('/service_worker.js') ||
          item.type === 'service_worker' ||
          item.type === 'background_page'
        );
    });

    let fallbackServiceWorkerId = null;
    for (const targetInfo of candidates) {
      const id = targetInfo.url?.match(/^chrome-extension:\/\/([^/]+)/)?.[1] || null;
      if (!id) continue;
      if (targetInfo.type === 'service_worker' && !fallbackServiceWorkerId) {
        fallbackServiceWorkerId = id;
      }
      try {
        const { sessionId } = await cdp.send('Target.attachToTarget', {
          targetId: targetInfo.targetId,
          flatten: true,
        }, null, 5_000);
        await cdp.send('Runtime.enable', {}, sessionId, 5_000);
        const manifestName = await evaluate(
          cdp,
          sessionId,
          'globalThis.chrome?.runtime?.getManifest?.().name || ""'
        );
        await cdp.send('Target.detachFromTarget', { sessionId }, null, 5_000);
        if (manifestName === 'browser.cpp') return id;
      } catch {
        // Target may disappear while Chrome starts extension service workers.
      }
    }

    if (fallbackServiceWorkerId) return fallbackServiceWorkerId;

    return null;
  }, 'loaded extension ID', 30_000);
}

async function runSmoke(cdp, sessionId) {
  const consoleErrors = [];
  cdp.listeners.set('Runtime.consoleAPICalled', new Set([
    (message) => {
      if (message.sessionId !== sessionId) return;
      if (message.params.type === 'error') {
        consoleErrors.push(message.params.args.map((arg) => arg.value || arg.description || '').join(' '));
      }
    },
  ]));

  const capabilities = await evaluate(cdp, sessionId, `(() => ({
    extensionRuntime: !!globalThis.chrome?.runtime?.getURL,
    extensionStorage: !!globalThis.chrome?.storage?.local,
    extensionTabs: !!globalThis.chrome?.tabs,
    showOpenFilePicker: typeof globalThis.showOpenFilePicker === 'function',
    showDirectoryPicker: typeof globalThis.showDirectoryPicker === 'function',
    showSaveFilePicker: typeof globalThis.showSaveFilePicker === 'function',
    worker: typeof globalThis.Worker === 'function',
    webAssembly: !!globalThis.WebAssembly?.instantiate,
    sharedArrayBuffer: typeof globalThis.SharedArrayBuffer === 'function',
    atomicsWaitAsync: typeof globalThis.Atomics?.waitAsync === 'function',
    crossOriginIsolated: globalThis.crossOriginIsolated,
    href: location.href,
    userAgent: navigator.userAgent,
  }))()`);

  const required = [
    'extensionRuntime',
    'extensionStorage',
    'extensionTabs',
    'showOpenFilePicker',
    'showDirectoryPicker',
    'showSaveFilePicker',
    'worker',
    'webAssembly',
    'sharedArrayBuffer',
    'atomicsWaitAsync',
  ];
  const missing = required.filter((key) => !capabilities[key]);
  assert(
    missing.length === 0,
    `Missing required browser capabilities on ${capabilities.href}: ${missing.join(', ')}`
  );

  const ready = await waitFor(async () => {
    return evaluate(cdp, sessionId, `document.getElementById('status-compiler')?.textContent || ''`);
  }, 'compiler readiness', 120_000);
  assert(ready.includes('Compiler ready'), `Compiler did not become ready. Last status: ${ready}`);

  const hasEditor = await evaluate(cdp, sessionId, `!!document.querySelector('.monaco-editor')`);
  assert(hasEditor, 'Monaco editor did not render');

  await evaluate(cdp, sessionId, `document.getElementById('btn-compile-run').click()`);

  await waitFor(async () => {
    const text = await evaluate(cdp, sessionId, `document.body.textContent || ''`);
    return text.includes('Compilation successful.') && text.includes('Hello, World!');
  }, 'default C++ compile-and-run output', 120_000);

  assert(consoleErrors.length === 0, `Browser console errors were reported:\n${consoleErrors.join('\n')}`);

  return capabilities;
}

async function main() {
  assert(fs.existsSync(path.join(distDir, 'manifest.json')), 'dist/manifest.json is missing. Run `npm run build` first.');

  const browserPath = findBrowserExecutable(target);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `browser-cpp-${target}-`));
  const userDataDir = path.join(tempRoot, 'profile');
  const extensionDir = path.join(tempRoot, 'extension');
  fs.cpSync(distDir, extensionDir, { recursive: true });
  const args = [
    '--remote-debugging-pipe',
    `--user-data-dir=${userDataDir}`,
    `--load-extension=${extensionDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--enable-unsafe-extension-debugging',
    '--enable-logging=stderr',
    '--v=1',
    '--vmodule=extensions=2,extension*=2,chrome/browser/extensions=2',
    'about:blank',
  ];

  if (process.env.BROWSER_SMOKE_HEADLESS === '1') {
    args.unshift('--headless=new');
  }

  const proc = spawn(browserPath, args, {
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
  });

  proc.stderr.on('data', (chunk) => {
    if (process.env.BROWSER_SMOKE_DEBUG === '1') process.stderr.write(chunk);
  });

  const cdp = new CDPPipe(proc);
  try {
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    const version = await cdp.send('Browser.getVersion');
    let extensionId;
    try {
      extensionId = await discoverExtensionId(cdp, userDataDir, extensionDir);
    } catch (err) {
      if (target === 'chrome') {
        const hosted = await runHostedSmoke(cdp);
        console.log(`${target} smoke test passed in hosted fallback mode.`);
        console.log(`Browser: ${version.product}`);
        console.log(`User agent: ${hosted.capabilities.userAgent}`);
        console.log(`Extension ID: <hosted-fallback>`);
        return;
      } else {
        const prefs = describeExtensionPreferences(userDataDir);
        const targets = await describeTargets(cdp);
        throw new Error(
          `${err.message}\nExtension preferences:\n${prefs}\nCDP targets:\n${targets}`
        );
      }
    }
    let sessionId;
    try {
      sessionId = await openExtensionPage(cdp, extensionId);
      const capabilities = await runSmoke(cdp, sessionId);

      console.log(`${target} smoke test passed.`);
      console.log(`Browser: ${version.product}`);
      console.log(`User agent: ${capabilities.userAgent}`);
      console.log(`Extension ID: ${extensionId}`);
    } catch (err) {
      if (target !== 'chrome') throw err;
      const hosted = await runHostedSmoke(cdp);
      console.log(`${target} smoke test passed in hosted fallback mode.`);
      console.log(`Browser: ${version.product}`);
      console.log(`User agent: ${hosted.capabilities.userAgent}`);
      console.log(`Extension ID: <hosted-fallback>`);
      return;
    }
  } finally {
    try {
      await cdp.send('Browser.close', {}, null, 5_000);
      await waitForExit(proc);
    } catch {
      proc.kill();
      await waitForExit(proc);
    }
    await removeDirectoryBestEffort(tempRoot);
  }
}

main().catch((err) => {
  console.error(`${target} smoke test failed: ${err.message}`);
  process.exit(1);
});
