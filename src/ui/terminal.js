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
 *   cat <file>                         – print file content
 *   pwd                                – print working directory
 *   help                               – list available commands
 */

'use strict';

import { Terminal } from '@xterm/xterm';
import { FitAddon }      from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

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

const PROMPT = `${C.green}${C.bold}browser.cpp${C.reset}${C.dim}:~$ ${C.reset}`;
const CRLF   = '\r\n';

/** Maximum number of commands retained in shell history. */
const MAX_HISTORY_SIZE = 200;

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

/** True while a compiled program is executing – input is routed to stdin. */
let running = false;

/** Resolve function set when waiting for run output to complete */
let runDone = null;

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
 * The '\n' is appended automatically.
 */
function _sendStdinLine(line) {
  const bytes = new TextEncoder().encode(line + '\n');
  _pendingChunks.push(bytes);
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
let _getSource = null;  // () => string  – returns current editor source

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create and mount the terminal inside `container`.
 *
 * @param {HTMLElement} container
 * @param {{
 *   onCompile: (source:string, flags:string[], std:string) => void,
 *   onRun:     (sharedBuffer:SharedArrayBuffer) => void,
 *   getSource: () => string,
 * }} callbacks
 */
export function createTerminal(container, { onCompile, onRun, getSource }) {
  _onCompile = onCompile;
  _onRun     = onRun;
  _getSource = getSource;

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
  writePrompt();

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

  if (!vfs.has('/a.out')) {
    term.write(`${C.red}No binary found. Compile first with:  g++ main.cpp${C.reset}${CRLF}`);
    writePrompt();
    return;
  }

  if (typeof SharedArrayBuffer === 'undefined') {
    term.write(
      `${C.red}Interactive stdin requires SharedArrayBuffer, which is not available ` +
      `in this context.${C.reset}${CRLF}`
    );
    writePrompt();
    return;
  }

  const sab = new SharedArrayBuffer(SAB_HEADER_BYTES + SAB_DATA_BYTES);
  _initSAB(sab);
  running     = true;
  inputBuffer = ''; // clear any partial command line
  term.write(CRLF);
  _onRun?.(sab);
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
 * @param {{ success:boolean, diagnostics:string }} result
 */
export function onCompileResult({ success, diagnostics }) {
  if (diagnostics) {
    const col = success ? C.yellow : C.red;
    term?.write(`${col}${diagnostics.replace(/\n/g, CRLF)}${C.reset}${CRLF}`);
  }
  if (success) {
    term?.write(`${C.green}Compilation successful.${C.reset}${CRLF}`);
    vfs.set('/a.out', '<binary>');
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
  running  = false;
  busy     = false;
  _clearSAB();
  runDone?.();
  runDone = null;
  writePrompt();
}

/** Print an informational message to the terminal. */
export function printInfo(msg) {
  term?.write(`${C.blue}${msg.replace(/\n/g, CRLF)}${C.reset}${CRLF}`);
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
      executeCommand(cmd);
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
    const cmds = ['g++ ', 'g++ main.cpp', './a.out', 'clear', 'echo ', 'ls', 'cat ', 'pwd', 'help'];
    const matches = cmds.filter((c) => c.startsWith(inputBuffer));
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
 * Ctrl+D on an empty line signals EOF; Ctrl+C sends EOF and clears the line.
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

  // Ctrl+C – interrupt: clear the current line and send EOF
  if (domEvent.ctrlKey && code === 'c') {
    term.write('^C' + CRLF);
    inputBuffer = '';
    _sendStdinEOF();
    return;
  }

  // Printable characters
  if (!domEvent.ctrlKey && !domEvent.altKey && key.length === 1) {
    inputBuffer += key;
    term.write(key);
  }
}

// ── Command dispatcher ────────────────────────────────────────────────────────

function executeCommand(cmdLine) {
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
    case 'cat':
      cmdCat(args);
      break;
    case 'pwd':
      term.write(`/home/user${CRLF}`);
      writePrompt();
      break;
    case 'help':
      cmdHelp();
      break;
    default:
      // Detect ./exe invocations
      if (cmd.startsWith('./')) {
        cmdRun(args);
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
  // Parse: [flags] [source.cpp] [-std=c++NN] [-o outname]
  let std      = 'c++20';
  let outName  = 'a.out';
  const extra  = [];

  // Extract -std= and -o flags; collect the rest as extra flags
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a.startsWith('-std=')) {
      std = a.slice(5);
    } else if (a === '-std' && args[i + 1]) {
      std = args[++i];
    } else if (a === '-o' && args[i + 1]) {
      outName = args[++i];
    } else if (a.startsWith('-o') && a.length > 2) {
      outName = a.slice(2);
    } else if (!a.startsWith('-')) {
      // source file – ignored; we always compile the current editor content
    } else {
      extra.push(a);
    }
    i++;
  }

  const source = _getSource ? _getSource() : '';
  if (!source.trim()) {
    term.write(`${C.red}Nothing to compile – editor is empty.${C.reset}${CRLF}`);
    writePrompt();
    return;
  }

  term.write(`${C.dim}Compiling with -std=${std}…${C.reset}${CRLF}`);
  busy = true;
  _onCompile?.(source, extra, std);
}

function cmdRun(args) {
  startRun();
}

function cmdLs() {
  // Show virtual files (mirrors the editor tabs + compiled binary)
  const files = ['main.cpp', ...vfs.keys()].filter(
    (f, i, a) => a.indexOf(f) === i
  );
  term.write(
    files.map((f) => `${C.blue}${f}${C.reset}`).join('  ') + CRLF
  );
  writePrompt();
}

function cmdCat(args) {
  if (!args[0]) {
    term.write(`${C.red}Usage: cat <file>${C.reset}${CRLF}`);
  } else if (args[0] === 'main.cpp' || args[0] === './main.cpp') {
    const src = _getSource?.() || '';
    term.write(src.replace(/\n/g, CRLF) + CRLF);
  } else {
    term.write(`${C.red}cat: ${args[0]}: No such file${C.reset}${CRLF}`);
  }
  writePrompt();
}

function cmdHelp() {
  term.write(
    `${C.bold}Available commands:${C.reset}${CRLF}` +
    `  ${C.green}g++ [flags] [file] [-std=c++NN] [-o out]${C.reset}  Compile the editor's source${CRLF}` +
    `  ${C.green}./a.out${C.reset}                                    Run the last compiled binary${CRLF}` +
    `  ${C.dim}  While running: type input and press Enter; Ctrl+D (empty line) = EOF${C.reset}${CRLF}` +
    `  ${C.green}clear${C.reset}                                      Clear the terminal${CRLF}` +
    `  ${C.green}echo <text>${C.reset}                                Print text${CRLF}` +
    `  ${C.green}ls${C.reset}                                         List virtual files${CRLF}` +
    `  ${C.green}cat <file>${C.reset}                                 Print file contents${CRLF}` +
    `  ${C.green}pwd${C.reset}                                        Print working directory${CRLF}` +
    `  ${C.green}help${C.reset}                                       Show this message${CRLF}` +
    CRLF
  );
  writePrompt();
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function writePrompt() {
  term?.write(PROMPT);
}

function clearInputLine() {
  // Erase everything the user has typed on the current line
  term.write('\r' + PROMPT + ' '.repeat(inputBuffer.length) + '\r' + PROMPT);
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
