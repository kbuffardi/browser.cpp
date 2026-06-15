/**
 * src/workers/compile-plan.mjs
 *
 * Pure parser that turns `clang++ -###` driver output into an explicit,
 * multi-translation-unit compile plan. Kept browser-free so the compiler worker
 * and the Node E2E suite share one implementation.
 *
 * Why: the previous pipeline only read the *first* `-cc1` subcommand and one
 * linker line, which models a single translation unit. Project builds need every
 * `-cc1` step (one per source file) compiled in its own fresh Clang instance,
 * then all produced objects linked together in one `wasm-ld` step.
 */

'use strict';

/** Extract the quoted argv from a `-###` subcommand line, dropping argv[0]. */
function parseSubcommand(line) {
  const matches = line.match(/"((?:[^"\\]|\\.)*)"/g);
  if (!matches || matches.length < 2) return null;
  return matches.map((s) => s.slice(1, -1).replace(/\\(.)/g, '$1')).slice(1);
}

/** Value following the first `-o` flag in an argv array, or null. */
function outputOf(args) {
  const i = args.indexOf('-o');
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

/**
 * Best-effort identification of the translation-unit source in a `-cc1` argv.
 * The driver places the input source last; we also skip obvious flag values.
 */
function sourceOf(args) {
  for (let i = args.length - 1; i >= 0; i--) {
    const a = args[i];
    if (!a || a.startsWith('-')) continue;
    const prev = args[i - 1];
    if (prev === '-o' || prev === '-x' || prev === '-main-file-name') continue;
    return a;
  }
  return null;
}

/**
 * Parse the driver's `-###` stderr into a compile plan.
 *
 * @param {string} stderr – combined `clang++ -###` driver output
 * @returns {{
 *   compileSteps: Array<{ args:string[], objectPath:string, sourcePath:(string|null) }>,
 *   linkStep: { args:string[], outputPath:string }
 * }}
 */
export function parseCompilePlan(stderr) {
  const lines = String(stderr || '').split('\n');
  const compileSteps = [];
  let linkStep = null;

  for (const line of lines) {
    if (!line.includes('"')) continue;
    const args = parseSubcommand(line);
    if (!args) continue;

    if (args.includes('-cc1')) {
      const objectPath = outputOf(args);
      if (!objectPath) continue;
      compileSteps.push({ args, objectPath, sourcePath: sourceOf(args) });
    } else if (line.includes('wasm-ld') || args.some((a) => a.includes('wasm-ld'))) {
      linkStep = { args, outputPath: outputOf(args) || 'a.out' };
    }
  }

  if (compileSteps.length === 0) {
    throw new Error(`No '-cc1' compile steps found in driver output:\n${stderr}`);
  }
  if (!linkStep) {
    throw new Error(`No 'wasm-ld' link step found in driver output:\n${stderr}`);
  }

  return { compileSteps, linkStep };
}
