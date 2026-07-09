/**
 * src/ui/terminal.js
 *
 * Wraps xterm.js and provides a bash-like shell that dispatches compiler
 * commands to the compiler worker.
 *
 * Supported commands:
 *   g++ <file> [-std=c++NN] [-O<n>] [-o <out>] [flags…]
 *   ./a.out  |  ./out  |  ./<name>     – run the last compiled binary
 *   clear                              – clear the screen
 *   echo <text>                        – print text
 *   ls                                 – list virtual files
 *   mkdir [-p] <dir>                   – create workspace directories
 *   cat <file>                         – print file content
 *   pwd                                – print working directory
 *   help                               – list available commands
 */

'use strict';

import * as xtermPkg from '@xterm/xterm';
import * as fitAddonPkg from '@xterm/addon-fit';
import * as webLinksAddonPkg from '@xterm/addon-web-links';

import {
  parseGxxArgs,
  resolveWorkspacePath,
  resolveRunTarget,
  isRejectedSource,
  normalizeOverlayPath,
} from './build-request.mjs';
import { validateNewDirectoryPath } from './workspace-fs.mjs';

function moduleExports(pkg) {
  return Object.prototype.hasOwnProperty.call(pkg, 'default') ? pkg['default'] : pkg;
}

const { Terminal } = moduleExports(xtermPkg);
const { FitAddon } = moduleExports(fitAddonPkg);
const { WebLinksAddon } = moduleExports(webLinksAddonPkg);

// ── Colour helpers ────────────────────────────────────────────────────────────
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
};

const CRLF   = '\r\n';

/** Maximum number of commands retained in shell history. */
const MAX_HISTORY_SIZE = 200;
const TAB_COMMANDS = ['g++ ', 'g++ main.cpp', './a.out', 'clear', 'echo ', 'ls', 'cd ', 'mkdir ', 'cat ', 'pwd', 'git ', 'help'];

// ── State ─────────────────────────────────────────────────────────────────────

let term     = null;
let fitAddon = null;

/** Current line being typed */
let inputBuffer = '';
/** History of commands entered */
const history    = [];
let   historyIdx = -1;

/** Virtual file store: filename → content */
const vfs = new Map();

/** True while the compiler is working – all keyboard input is ignored. */
let busy = false;

/**
 * Workspace-relative path of the last successfully built artifact (e.g. 'a.out'
 * or a `-o custom-name`). Used to validate `./name` runs. A failed build never
 * overwrites it, so the last good binary stays runnable.
 * @type {string|null}
 */
let lastBuiltArtifactPath = null;

/** True while a compiled program is executing – input is routed to stdin. */
let running = false;

/** Resolve function set when waiting for run output to complete */
let runDone = null;

let workspaceName = null;
let workspaceEntries = [];
let workspaceDirs = new Set(['/']);
let workspaceFiles = new Set();
let workspaceCwd = '/';
let workspaceGit = { isRepo: false, branch: null, remotes: [] };
let _readWorkspaceFile = null;
let _onMkdir = null;
let initialPromptShown = false;

// ── Interactive stdin (SharedArrayBuffer + Atomics) ───────────────────────────

/**
 * SAB layout used for interactive stdin:
 *   Int32[0]  – state:  0 = waiting, 1 = data ready, -1 = EOF
 *   Int32[1]  – length: byte count in data section
 *   Uint8[8…] – data:   up to SAB_DATA_BYTES bytes
 */
const SAB_HEADER_BYTES = 8;
const SAB_DATA_BYTES   = 4096;

let _sabControl    = null;   // Int32Array view of current SAB
let _sabData       = null;   // Uint8Array  view of current SAB data section
let _pendingChunks = [];     // queue of Uint8Array chunks waiting to be sent
let _flushActive   = false;  // prevents concurrent _doFlush invocations

function _initSAB(sab) {
  _sabControl    = new Int32Array(sab);
  _sabData       = new Uint8Array(sab, SAB_HEADER_BYTES);
  _pendingChunks = [];
  _flushActive   = false;
}

function _clearSAB() {
  _sabControl    = null;
  _sabData       = null;
  _pendingChunks = [];
  _flushActive   = false;
}

/**
 * Enqueue a line of text (without the trailing newline) for delivery to stdin.
 * The '\n' is appended automatically.  Lines longer than SAB_DATA_BYTES are
 * split into multiple chunks so no data is lost.
 */
function _sendStdinLine(line) {
  const bytes = new TextEncoder().encode(line + '\n');
  for (let offset = 0; offset < bytes.length; offset += SAB_DATA_BYTES) {
    _pendingChunks.push(bytes.subarray(offset, offset + SAB_DATA_BYTES));
  }
  _flushStdin();
}

/** Signal EOF on stdin (Ctrl+D on an empty line, or Ctrl+C). */
function _sendStdinEOF() {
  _pendingChunks.push(null); // null sentinel = EOF
  _flushStdin();
}

function _flushStdin() {
  if (_flushActive || _pendingChunks.length === 0 || !_sabControl) return;
  _flushActive = true;
  _doFlush();
}

/**
 * Async loop that drains _pendingChunks into the SAB one chunk at a time,
 * using Atomics.waitAsync to yield until the worker has consumed each chunk
 * before sending the next.
 */
async function _doFlush() {
  while (_pendingChunks.length > 0 && _sabControl) {
    // Wait until the worker has consumed the previous chunk (state returns to 0)
    const state = Atomics.load(_sabControl, 0);
    if (state !== 0) {
      const { async, value } = Atomics.waitAsync(_sabControl, 0, state);
      if (async) await value;
      continue; // re-check state after waking
    }

    const chunk = _pendingChunks.shift();
    if (chunk === null) {
      // EOF
      Atomics.store(_sabControl, 0, -1);
      Atomics.notify(_sabControl, 0);
    } else {
      const len = Math.min(chunk.length, SAB_DATA_BYTES);
      _sabData.set(chunk.subarray(0, len));
      Atomics.store(_sabControl, 1, len);
      Atomics.store(_sabControl, 0, 1);
      Atomics.notify(_sabControl, 0);
    }
  }
  _flushActive = false;
}

// Set from outside: callbacks to compile and run
let _onCompile = null;
let _onRun     = null;
let _onStopRun = null;
let _onRunStateChange = null;
let _getSource = null;  // () => string  – returns current editor source

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create and mount the terminal inside `container`.
 *
 * @param {HTMLElement} container
 * @param {{
 *   onCompile: (request:{sourcePaths:(string[]|null), flags:string[], std:string, outputName:(string|null), cwd:string}) => void,
 *   onRun:     (sharedBuffer:SharedArrayBuffer) => void,
 *   onStopRun?: () => void,
 *   onRunStateChange?: (running:boolean) => void,
 *   getSource: () => string,
 *   readWorkspaceFile?: (path:string) => Promise<string|null>,
 *   onMkdir?: (request:{path:string, parents:boolean}) => Promise<object>,
 * }} callbacks
 */
export function createTerminal(container, { onCompile, onRun, onStopRun, onRunStateChange, getSource, readWorkspaceFile, onMkdir }) {
  _onCompile = onCompile;
  _onRun     = onRun;
  _onStopRun = onStopRun || null;
  _onRunStateChange = onRunStateChange || null;
  _getSource = getSource;
  _readWorkspaceFile = readWorkspaceFile || null;
  _onMkdir = onMkdir || null;
  initialPromptShown = false;
  busy = true;

  term = new Terminal({
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
    fontSize: 13,
    lineHeight: 1.4,
    theme: {
      background:   '#11111b',
      foreground:   '#cdd6f4',
      cursor:       '#f5c2e7',
      cursorAccent: '#1e1e2e',
      black:        '#45475a',
      red:          '#f38ba8',
      green:        '#a6e3a1',
      yellow:       '#f9e2af',
      blue:         '#89b4fa',
      magenta:      '#cba6f7',
      cyan:         '#89dceb',
      white:        '#bac2de',
      brightBlack:  '#585b70',
      brightRed:    '#f38ba8',
      brightGreen:  '#a6e3a1',
      brightYellow: '#f9e2af',
      brightBlue:   '#89b4fa',
      brightMagenta:'#cba6f7',
      brightCyan:   '#89dceb',
      brightWhite:  '#a6adc8',
    },
    cursorBlink: true,
    scrollback: 5000,
    convertEol: false,
  });

  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());

  term.open(container);
  fitAddon.fit();

  // Welcome banner
  term.write(
    `${C.cyan}${C.bold}browser.cpp${C.reset} – C++20 WASM terminal${CRLF}` +
    `${C.dim}Type ${C.reset}${C.bold}help${C.reset}${C.dim} for available commands.${C.reset}${CRLF}${CRLF}`
  );

  term.onKey(handleKey);

  return term;
}

/** Resize the terminal to fill its container (call after layout changes). */
export function fitTerminal() {
  fitAddon?.fit();
}

/** Clear the terminal screen. */
export function clearTerminal() {
  term?.clear();
  if (!initialPromptShown) return;
  writePrompt();
}

/** Write the first shell prompt after compiler startup has reached a terminal state. */
export function showInitialPrompt() {
  if (initialPromptShown) return;
  initialPromptShown = true;
  busy = false;
  writePrompt();
}

/**
 * Start executing the last compiled binary with interactive stdin support.
 *
 * Creates a SharedArrayBuffer for stdin coordination, enters stdin-capture
 * mode, and dispatches the run request to the compiler worker via _onRun.
 * Can be called from the terminal command line (`./a.out`) or directly from
 * the toolbar Run button.
 */
export function startRun() {
  if (!term) return;
  if (running) return; // already running

  if (!lastBuiltArtifactPath) {
    term.write(`${C.red}No binary found. Compile first with:  g++ main.cpp${C.reset}${CRLF}`);
    writePrompt();
    return;
  }

  if (typeof SharedArrayBuffer === 'undefined') {
    term.write(
      `${C.red}Interactive stdin requires SharedArrayBuffer, which is unavailable ` +
      `in this context.  The page must be served with Cross-Origin-Opener-Policy: ` +
      `same-origin and Cross-Origin-Embedder-Policy: require-corp headers.${C.reset}${CRLF}`
    );
    writePrompt();
    return;
  }

  const sab = new SharedArrayBuffer(SAB_HEADER_BYTES + SAB_DATA_BYTES);
  _initSAB(sab);
  setRunState(true);
  inputBuffer = ''; // clear any partial command line
  term.write(CRLF);
  _onRun?.(sab);
}

/**
 * Stop the currently running program. This is intentionally separate from EOF:
 * CPU-bound WASM cannot observe stdin EOF, so the main thread terminates the
 * worker via _onStopRun after terminal state has been reset.
 *
 * @param {{ echoCtrlC?: boolean }} [options]
 * @returns {boolean} true when a running program was stopped
 */
export function stopRun({ echoCtrlC = false } = {}) {
  if (!running) return false;

  if (echoCtrlC) {
    term?.write('^C' + CRLF);
  } else {
    term?.write(CRLF);
  }
  inputBuffer = '';
  _clearSAB();
  setRunState(false);
  busy = false;
  runDone?.();
  runDone = null;
  term?.write(`${C.yellow}Process interrupted.${C.reset}${CRLF}`);
  writePrompt();
  _onStopRun?.();
  return true;
}

// ── Output helpers called by toolbar.js / app.js ─────────────────────────────

/** Write stdout text from the running program. */
export function writeStdout(text) {
  term?.write(text.replace(/\n/g, CRLF));
}

/** Write stderr text from the compiler or running program. */
export function writeStderr(text) {
  term?.write(`${C.red}${text.replace(/\n/g, CRLF)}${C.reset}`);
}

/**
 * Called when the compiler finishes.
 * @param {{ success:boolean, diagnostics:string, outputPath?:(string|null) }} result
 */
export function onCompileResult({ success, diagnostics, outputPath }) {
  if (diagnostics) {
    const col = success ? C.yellow : C.red;
    term?.write(`${col}${diagnostics.replace(/\n/g, CRLF)}${C.reset}${CRLF}`);
  }
  if (success) {
    // A successful build updates the runnable artifact. Failed builds leave the
    // previous artifact intact so `./name` keeps working.
    lastBuiltArtifactPath = normalizeOverlayPath(outputPath || 'a.out') || 'a.out';
    vfs.set(`/${lastBuiltArtifactPath}`, '<binary>');
    term?.write(`${C.green}Compilation successful.${C.reset}${CRLF}`);
  } else {
    term?.write(`${C.red}Compilation failed.${C.reset}${CRLF}`);
  }
  busy = false;
  writePrompt();
}

/**
 * Called when the program finishes running.
 * @param {{ exitCode:number }} result
 */
export function onRunResult({ exitCode }) {
  if (exitCode !== 0) {
    term?.write(`${CRLF}${C.yellow}Process exited with code ${exitCode}.${C.reset}${CRLF}`);
  }
  setRunState(false);
  busy = false;
  _clearSAB();
  runDone?.();
  runDone = null;
  writePrompt();
}

/** Print an informational message to the terminal. */
export function printInfo(msg) {
  term?.write(`${C.blue}${msg.replace(/\n/g, CRLF)}${C.reset}${CRLF}`);
}

/** Update terminal workspace context for ls/cd/pwd/git commands. */
export function setWorkspace(workspace) {
  if (!workspace) {
    workspaceName = null;
    workspaceEntries = [];
    workspaceDirs = new Set(['/']);
    workspaceFiles = new Set();
    workspaceCwd = '/';
    workspaceGit = { isRepo: false, branch: null, remotes: [] };
    return;
  }

  workspaceCwd = '/';
  indexWorkspace(workspace);
}

/**
 * Refresh the terminal's workspace index after an incremental mutation (file
 * created in the Explorer, persisted compile artifact, or runtime `fstream`
 * write) so `ls`/`cat`/`cd` see new files immediately. Unlike {@link setWorkspace}
 * this preserves the current working directory when it still exists.
 */
export function refreshWorkspace(workspace) {
  if (!workspace) return;
  const previousCwd = workspaceCwd;
  indexWorkspace(workspace);
  workspaceCwd = workspaceDirs.has(previousCwd) ? previousCwd : '/';
}

/** Rebuild dir/file lookups from a workspace snapshot. */
function indexWorkspace(workspace) {
  workspaceName = workspace.name || null;
  workspaceEntries = Array.isArray(workspace.entries) ? workspace.entries : [];
  workspaceDirs = new Set(['/']);
  workspaceFiles = new Set();
  workspaceGit = workspace.git || { isRepo: false, branch: null, remotes: [] };

  for (const entry of workspaceEntries) {
    const fullPath = `/${normalizePath(entry.path)}`;
    if (!entry.path) continue;
    if (entry.kind === 'directory') {
      workspaceDirs.add(fullPath);
    } else if (entry.kind === 'file') {
      workspaceFiles.add(fullPath);
      const parent = fullPath.slice(0, fullPath.lastIndexOf('/')) || '/';
      workspaceDirs.add(parent);
    }
  }
}

// ── Key handler ───────────────────────────────────────────────────────────────

function handleKey({ key, domEvent }) {
  if (busy) return; // ignore during compilation

  // While a program is executing, route keystrokes to stdin instead of the shell
  if (running) {
    handleStdinKey(key, domEvent);
    return;
  }

  const code = domEvent.key;

  if (code === 'Enter') {
    term.write(CRLF);
    const cmd = inputBuffer.trim();
    inputBuffer = '';
    historyIdx  = -1;
    if (cmd) {
      history.unshift(cmd);
      if (history.length > MAX_HISTORY_SIZE) history.pop();
      void executeCommand(cmd);
    } else {
      writePrompt();
    }
    return;
  }

  if (code === 'Backspace') {
    if (inputBuffer.length > 0) {
      inputBuffer = inputBuffer.slice(0, -1);
      term.write('\b \b');
    }
    return;
  }

  if (code === 'ArrowUp') {
    if (historyIdx < history.length - 1) {
      clearInputLine();
      historyIdx++;
      inputBuffer = history[historyIdx];
      term.write(inputBuffer);
    }
    return;
  }

  if (code === 'ArrowDown') {
    clearInputLine();
    if (historyIdx > 0) {
      historyIdx--;
      inputBuffer = history[historyIdx];
    } else {
      historyIdx  = -1;
      inputBuffer = '';
    }
    term.write(inputBuffer);
    return;
  }

  if (code === 'Tab') {
    domEvent.preventDefault();
    // Basic tab-completion for known commands
    const matches = TAB_COMMANDS.filter((c) => c.startsWith(inputBuffer));
    if (matches.length === 1) {
      const extra = matches[0].slice(inputBuffer.length);
      inputBuffer += extra;
      term.write(extra);
    } else if (matches.length > 1) {
      term.write(CRLF);
      term.write(matches.join('  ') + CRLF);
      writePrompt();
      term.write(inputBuffer);
    }
    return;
  }

  // Ctrl+C – interrupt / clear line
  if (domEvent.ctrlKey && code === 'c') {
    term.write('^C' + CRLF);
    inputBuffer = '';
    historyIdx  = -1;
    writePrompt();
    return;
  }

  // Ctrl+L – clear screen
  if (domEvent.ctrlKey && code === 'l') {
    term.clear();
    writePrompt();
    term.write(inputBuffer);
    return;
  }

  // Printable characters
  if (!domEvent.ctrlKey && !domEvent.altKey && key.length === 1) {
    inputBuffer += key;
    term.write(key);
  }
}

// ── Stdin key handler (active while a program is running) ─────────────────────

/**
 * Handle a keystroke while a WASM program is executing.
 * Characters are echoed to the terminal and buffered in inputBuffer;
 * pressing Enter submits the line to the program's stdin.
 * Ctrl+D on an empty line signals EOF; Ctrl+C interrupts the program.
 */
function handleStdinKey(key, domEvent) {
  const code = domEvent.key;

  if (code === 'Enter') {
    term.write(CRLF);
    const line = inputBuffer;
    inputBuffer = '';
    _sendStdinLine(line);
    return;
  }

  if (code === 'Backspace') {
    if (inputBuffer.length > 0) {
      inputBuffer = inputBuffer.slice(0, -1);
      term.write('\b \b');
    }
    return;
  }

  // Ctrl+D – EOF (only when the input line is empty, matching real terminal behaviour)
  if (domEvent.ctrlKey && code === 'd') {
    if (inputBuffer.length === 0) {
      _sendStdinEOF();
    }
    return;
  }

  // Ctrl+C – interrupt the running program
  if (domEvent.ctrlKey && code === 'c') {
    stopRun({ echoCtrlC: true });
    return;
  }

  // Printable characters
  if (!domEvent.ctrlKey && !domEvent.altKey && key.length === 1) {
    inputBuffer += key;
    term.write(key);
  }
}

// ── Command dispatcher ────────────────────────────────────────────────────────

async function executeCommand(cmdLine) {
  const parts = tokenise(cmdLine);
  if (!parts.length) { writePrompt(); return; }

  const [cmd, ...args] = parts;

  switch (cmd) {
    case 'g++':
    case 'clang++':
      cmdGxx(args);
      break;
    case 'clear':
      term.clear();
      writePrompt();
      break;
    case 'echo':
      term.write(args.join(' ').replace(/\n/g, CRLF) + CRLF);
      writePrompt();
      break;
    case 'ls':
      cmdLs(args);
      break;
    case 'cd':
      cmdCd(args);
      break;
    case 'mkdir':
      await cmdMkdir(args);
      break;
    case 'cat':
      await cmdCat(args);
      break;
    case 'pwd':
      term.write(`${pwdPath()}${CRLF}`);
      writePrompt();
      break;
    case 'git':
      cmdGit(args);
      writePrompt();
      break;
    case 'ssh':
      term.write(
        `${C.yellow}SSH uses your device keys in your native terminal. Open this folder locally and run git there for SSH auth to GitHub.${C.reset}${CRLF}`
      );
      writePrompt();
      break;
    case 'help':
      cmdHelp();
      break;
    default:
      // Detect ./exe invocations
      if (cmd.startsWith('./')) {
        cmdRun(cmd);
      } else {
        term.write(
          `${C.red}bash: ${cmd}: command not found${C.reset}${CRLF}` +
          `${C.dim}Type ${C.reset}help${C.dim} for available commands.${C.reset}${CRLF}`
        );
        writePrompt();
      }
  }
}

// ── Individual command handlers ───────────────────────────────────────────────

function cmdGxx(args) {
  const { std, outputName, flags, sourcePaths } = parseGxxArgs(args);

  // MVP policy: reject `.c`/`.cc` explicit inputs rather than compiling silently.
  const rejected = sourcePaths.filter(isRejectedSource);
  if (rejected.length) {
    term.write(
      `${C.red}g++: ${rejected.join(', ')}: .c/.cc sources are not supported in this MVP ` +
      `(only .cpp and .cxx).${C.reset}${CRLF}`
    );
    writePrompt();
    return;
  }

  // No explicit sources → compile the single editor buffer (works with or
  // without an open folder), preserving legacy behaviour.
  if (sourcePaths.length === 0) {
    const source = _getSource ? _getSource() : '';
    if (!source.trim()) {
      term.write(`${C.red}Nothing to compile – editor is empty.${C.reset}${CRLF}`);
      writePrompt();
      return;
    }
    term.write(`${C.dim}Compiling with -std=${std}…${C.reset}${CRLF}`);
    busy = true;
    _onCompile?.({ sourcePaths: null, flags, std, outputName, cwd: workspaceCwd });
    return;
  }

  // Explicit source files require an open folder when more than one is given.
  if (!workspaceName && sourcePaths.length > 1) {
    term.write(
      `${C.red}g++: multiple source files require an opened folder. Open a folder first.${C.reset}${CRLF}`
    );
    writePrompt();
    return;
  }

  const resolved = sourcePaths.map((p) => resolveWorkspacePath(workspaceCwd, p));
  term.write(`${C.dim}Compiling ${resolved.join(' ')} with -std=${std}…${C.reset}${CRLF}`);
  busy = true;
  _onCompile?.({ sourcePaths: resolved, flags, std, outputName, cwd: workspaceCwd });
}

function cmdRun(cmd) {
  const { ok, error } = resolveRunTarget(cmd, lastBuiltArtifactPath);
  if (!ok) {
    if (error === 'no-binary') {
      term.write(`${C.red}No binary found. Compile first with:  g++ main.cpp${C.reset}${CRLF}`);
    } else {
      term.write(`${C.red}bash: ${cmd}: No such file or directory${C.reset}${CRLF}`);
    }
    writePrompt();
    return;
  }
  startRun();
}

function cmdLs(args = []) {
  if (!workspaceName) {
    const files = ['main.cpp', ...vfs.keys()].filter(
      (f, i, a) => a.indexOf(f) === i
    );
    term.write(
      files.map((f) => `${C.blue}${f}${C.reset}`).join('  ') + CRLF
    );
    writePrompt();
    return;
  }

  const recursive = args.includes('-R');
  const pathArg = args.find((a) => a !== '-R') || '.';
  const target = resolvePath(pathArg);
  if (!workspaceDirs.has(target)) {
    term.write(`${C.red}ls: cannot access '${pathArg}': No such directory${C.reset}${CRLF}`);
    writePrompt();
    return;
  }

  if (recursive) {
    const dirs = [...workspaceDirs].sort((a, b) => a.localeCompare(b));
    for (const dir of dirs) {
      if (!dir.startsWith(target)) continue;
      term.write(`${displayDir(dir)}:${CRLF}`);
      const entries = listDirEntries(dir);
      if (entries.length) {
        term.write(entries.map(formatEntry).join('  ') + CRLF);
      }
      term.write(CRLF);
    }
    writePrompt();
    return;
  }

  const entries = listDirEntries(target);
  if (entries.length) {
    term.write(entries.map(formatEntry).join('  ') + CRLF);
  } else {
    term.write(CRLF);
  }
  writePrompt();
}

function cmdCd(args) {
  if (!workspaceName) {
    term.write(`${C.red}cd: no folder opened${C.reset}${CRLF}`);
    writePrompt();
    return;
  }

  const targetArg = args[0] || '/';
  const target = resolvePath(targetArg);
  if (!workspaceDirs.has(target)) {
    term.write(`${C.red}cd: ${targetArg}: No such directory${C.reset}${CRLF}`);
    writePrompt();
    return;
  }
  workspaceCwd = target;
  writePrompt();
}

async function cmdCat(args) {
  if (!args[0]) {
    term.write(`${C.red}Usage: cat <file>${C.reset}${CRLF}`);
    writePrompt();
    return;
  }

  if (workspaceName) {
    const path = resolvePath(args[0]);
    if (!workspaceFiles.has(path)) {
      term.write(`${C.red}cat: ${args[0]}: No such file${C.reset}${CRLF}`);
      writePrompt();
      return;
    }
    const content = await _readWorkspaceFile?.(normalizePath(path));
    if (content == null) {
      term.write(`${C.red}cat: ${args[0]}: Could not read file${C.reset}${CRLF}`);
    } else {
      term.write(content.replace(/\n/g, CRLF) + CRLF);
    }
    writePrompt();
    return;
  }

  if (args[0] === 'main.cpp' || args[0] === './main.cpp') {
    const src = _getSource?.() || '';
    term.write(src.replace(/\n/g, CRLF) + CRLF);
  } else {
    term.write(`${C.red}cat: ${args[0]}: No such file${C.reset}${CRLF}`);
  }
  writePrompt();
}

async function cmdMkdir(args) {
  if (!workspaceName) {
    term.write(`${C.red}mkdir: no folder opened${C.reset}${CRLF}`);
    writePrompt();
    return;
  }

  const parsed = parseMkdirArgs(args);
  if (!parsed.ok) {
    const message = parsed.error === 'unknown-option'
      ? `mkdir: ${parsed.option}: unsupported option`
      : 'Usage: mkdir [-p] <dir>';
    term.write(`${C.red}${message}${C.reset}${CRLF}`);
    writePrompt();
    return;
  }

  const resolvedPath = normalizePath(resolvePath(parsed.pathArg));
  const validated = validateNewDirectoryPath(resolvedPath);
  if (!validated.ok) {
    term.write(`${C.red}${formatMkdirValidationError(validated)}${C.reset}${CRLF}`);
    writePrompt();
    return;
  }

  const result = await _onMkdir?.({
    path: validated.path,
    parents: parsed.parents,
  });

  if (!result?.ok) {
    term.write(`${C.red}${formatMkdirFilesystemError(result, parsed.pathArg)}${C.reset}${CRLF}`);
    writePrompt();
    return;
  }

  writePrompt();
}

function cmdGit(args) {
  if (!workspaceName) {
    term.write(`${C.red}git: open a folder first (Ctrl+O)${C.reset}${CRLF}`);
    return;
  }
  if (!workspaceGit?.isRepo) {
    term.write(`${C.red}fatal: not a git repository${C.reset}${CRLF}`);
    return;
  }

  const sub = args[0] || 'status';
  if (sub === 'status') {
    const branch = workspaceGit.branch || 'unknown';
    term.write(`On branch ${branch}${CRLF}`);
    term.write(`${C.yellow}Working-tree state is unavailable in this browser terminal.${C.reset}${CRLF}`);
    return;
  }

  if (sub === 'branch') {
    term.write(`* ${workspaceGit.branch || 'unknown'}${CRLF}`);
    return;
  }

  if (sub === 'remote' && args[1] === '-v') {
    if (!workspaceGit.remotes?.length) {
      term.write(`(no remotes configured)${CRLF}`);
      return;
    }
    for (const remote of workspaceGit.remotes) {
      term.write(`origin\t${remote} (fetch)${CRLF}`);
      term.write(`origin\t${remote} (push)${CRLF}`);
    }
    return;
  }

  term.write(
    `${C.yellow}Supported git commands: status, branch, remote -v.${C.reset}${CRLF}` +
    `${C.dim}Full git porcelain/plumbing commands are not yet available in this browser terminal.${C.reset}${CRLF}`
  );
}

function cmdHelp() {
  term.write(
    `${C.bold}Available commands:${C.reset}${CRLF}` +
    `  ${C.green}g++ [flags] [file] [-std=c++NN] [-o out]${C.reset}  Compile the editor's source${CRLF}` +
    `  ${C.green}./a.out${C.reset}                                    Run the last compiled binary${CRLF}` +
    `  ${C.dim}  While running: type input and press Enter; Ctrl+D (empty line) = EOF${C.reset}${CRLF}` +
    `  ${C.green}clear${C.reset}                                      Clear the terminal${CRLF}` +
    `  ${C.green}echo <text>${C.reset}                                Print text${CRLF}` +
    `  ${C.green}ls [-R] [dir]${C.reset}                              List files/folders in the opened folder${CRLF}` +
    `  ${C.green}cd [dir]${C.reset}                                   Change folder in the opened workspace${CRLF}` +
    `  ${C.green}mkdir [-p] <dir>${C.reset}                            Create workspace directories${CRLF}` +
    `  ${C.green}cat <file>${C.reset}                                 Print file contents${CRLF}` +
    `  ${C.green}pwd${C.reset}                                        Print current working directory${CRLF}` +
    `  ${C.green}git <cmd>${C.reset}                                  Basic git info for opened repo${CRLF}` +
    `  ${C.green}help${C.reset}                                       Show this message${CRLF}` +
    CRLF
  );
  writePrompt();
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function writePrompt() {
  term?.write(`${C.green}${C.bold}browser.cpp${C.reset}${C.dim}:${promptPath()}$ ${C.reset}`);
}

function setRunState(nextRunning) {
  if (running === nextRunning) return;
  running = nextRunning;
  _onRunStateChange?.(running);
}

export function __setTerminalTestHarness({
  term: terminalInstance,
  lastBuiltArtifactPath: artifactPath = null,
  onCompile = null,
  onRun = null,
  onStopRun = null,
  onRunStateChange = null,
  getSource = () => '',
  readWorkspaceFile = null,
  onMkdir = null,
} = {}) {
  term = terminalInstance || null;
  fitAddon = null;
  _onCompile = onCompile;
  _onRun = onRun;
  _onStopRun = onStopRun;
  _onRunStateChange = onRunStateChange;
  _getSource = getSource;
  _readWorkspaceFile = readWorkspaceFile;
  _onMkdir = onMkdir;
  lastBuiltArtifactPath = artifactPath;
  inputBuffer = '';
  history.length = 0;
  historyIdx = -1;
  busy = false;
  running = false;
  runDone = null;
  initialPromptShown = false;
  _clearSAB();
}

export function __handleTerminalKeyForTesting(key, domEvent) {
  handleKey({ key, domEvent });
}

export async function __executeTerminalCommandForTesting(cmdLine) {
  await executeCommand(cmdLine);
}

export function __getTerminalStateForTesting() {
  return {
    running,
    busy,
    inputBuffer,
    pendingChunks: _pendingChunks.length,
  };
}

function clearInputLine() {
  // Erase everything the user has typed on the current line
  const prompt = `${C.green}${C.bold}browser.cpp${C.reset}${C.dim}:${promptPath()}$ ${C.reset}`;
  term.write('\r' + prompt + ' '.repeat(inputBuffer.length) + '\r' + prompt);
}

/**
 * Shell-like tokeniser: splits on whitespace, respects "double" and 'single' quotes.
 * @param {string} line
 * @returns {string[]}
 */
function tokenise(line) {
  const tokens = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  for (const ch of line) {
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"'  && !inSingle) { inDouble = !inDouble; continue; }
    if (ch === ' '  && !inSingle && !inDouble) {
      if (cur) { tokens.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function parseMkdirArgs(args) {
  let parents = false;
  const paths = [];

  for (const arg of args) {
    if (arg === '-p') {
      parents = true;
      continue;
    }
    if (arg.startsWith('-')) {
      return { ok: false, error: 'unknown-option', option: arg };
    }
    paths.push(arg);
  }

  if (paths.length !== 1) {
    return { ok: false, error: 'usage' };
  }

  return { ok: true, parents, pathArg: paths[0] };
}

function formatMkdirValidationError(result) {
  if (result.error === 'invalid-name') {
    const chars = (result.unsupportedChars || []).map((ch) => (ch === ' ' ? "' '" : ch));
    const verb = chars.length === 1 ? 'is' : 'are';
    return `${chars.join(', ')} ${verb} not supported in folder names. Use only letters, numbers, hyphens, and underscores.`;
  }

  if (result.error === 'name-too-long') {
    return `Keep folder names short, such as: ${result.truncated || ''}`;
  }

  if (result.error === 'empty') {
    return 'Usage: mkdir [-p] <dir>';
  }

  return 'mkdir: cannot create directory: invalid path';
}

function formatMkdirFilesystemError(result, displayPath) {
  const path = displayPath || result?.path || '';
  switch (result?.error) {
    case 'missing-parent':
      return `mkdir: cannot create directory '${path}': No such file or directory`;
    case 'exists':
      return `mkdir: cannot create directory '${path}': File exists`;
    case 'not-writable':
    case 'permission-denied':
      return `mkdir: cannot create directory '${path}': Permission denied`;
    case 'no-workspace':
      return 'mkdir: no folder opened';
    default:
      return `mkdir: cannot create directory '${path}'`;
  }
}

function promptPath() {
  if (!workspaceName || workspaceCwd === '/') return '~';
  return `~${workspaceCwd}`;
}

function pwdPath() {
  if (!workspaceName) return '/home/user';
  return `/home/user/${workspaceName}${workspaceCwd === '/' ? '' : workspaceCwd}`;
}

function resolvePath(input) {
  if (!workspaceName) return '/';
  const raw = String(input || '.').trim();
  const absolute = raw.startsWith('/');
  const parts = [];
  const source = absolute
    ? raw.split('/')
    : [...workspaceCwd.split('/'), ...raw.split('/')];
  for (const part of source) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return '/' + parts.join('/');
}

function listDirEntries(dirPath) {
  const out = [];
  for (const dir of workspaceDirs) {
    if (dir === dirPath) continue;
    if (parentDir(dir) === dirPath) {
      out.push({ kind: 'directory', name: baseName(dir) });
    }
  }
  for (const file of workspaceFiles) {
    if (parentDir(file) === dirPath) {
      out.push({ kind: 'file', name: baseName(file) });
    }
  }
  return out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function parentDir(path) {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

function baseName(path) {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? path : path.slice(idx + 1);
}

function displayDir(path) {
  if (!workspaceName || path === '/') return '.';
  return path.slice(1) || '.';
}

function formatEntry(entry) {
  if (entry.kind === 'directory') {
    return `${C.blue}${entry.name}/${C.reset}`;
  }
  return entry.name;
}

function normalizePath(path) {
  return String(path || '').replace(/^\/+/, '');
}
