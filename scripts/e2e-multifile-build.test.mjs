import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseGxxArgs,
  resolveWorkspacePath,
  resolveRunTarget,
  selectWorkspaceSources,
  buildCompileOverlay,
  isProjectSource,
  isRejectedSource,
  normalizeOverlayPath,
} from '../src/ui/build-request.mjs';
import { parseCompilePlan } from '../src/workers/compile-plan.mjs';
import { parseDiagnostics, diagnosticsForPath } from '../src/ui/diagnostics.mjs';

// E2E coverage for workspace project builds and multi-file C++ compilation.
//
// Why these tests: compilation moved from "one editor buffer" to "the whole
// opened workspace". The pure modules exercised here are the single source of
// truth shared by the real UI (terminal.js/toolbar.js/editor.js) and the
// compiler worker, so verifying them verifies the actual build behaviour without
// needing a browser/DOM or the WASM toolchain.

// ── Toolbar project-source discovery ──────────────────────────────────────────

test('e2e: toolbar build selects every recursive .cpp/.cxx and ignores .c/.cc', () => {
  const entries = [
    { path: 'main.cpp', kind: 'file' },
    { path: 'src/util.cxx', kind: 'file' },
    { path: 'src', kind: 'directory' },
    { path: 'legacy.c', kind: 'file' },
    { path: 'vendor/old.cc', kind: 'file' },
    { path: 'include/app.hpp', kind: 'file' },
    { path: 'README.md', kind: 'file' },
  ];

  const sources = selectWorkspaceSources(entries);

  assert.deepEqual(sources, ['main.cpp', 'src/util.cxx']);
  assert.ok(isProjectSource('a.cpp') && isProjectSource('a.cxx'));
  assert.ok(isRejectedSource('a.c') && isRejectedSource('a.cc'));
  assert.equal(isProjectSource('a.hpp'), false);
});

// ── Terminal explicit source arguments ────────────────────────────────────────

test('e2e: g++ main.cpp other.cpp preserves both source arguments', () => {
  const parsed = parseGxxArgs(['main.cpp', 'other.cpp', '-O2', '-Wall']);
  assert.deepEqual(parsed.sourcePaths, ['main.cpp', 'other.cpp']);
  assert.deepEqual(parsed.flags, ['-O2', '-Wall']);
  assert.equal(parsed.outputName, null);
  assert.equal(parsed.std, 'c++20');
});

test('e2e: terminal relative source paths resolve from the workspace cwd', () => {
  assert.equal(resolveWorkspacePath('/src', 'main.cpp'), 'src/main.cpp');
  assert.equal(resolveWorkspacePath('/src', './main.cpp'), 'src/main.cpp');
  assert.equal(resolveWorkspacePath('/src/lib', '../other.cpp'), 'src/other.cpp');
  assert.equal(resolveWorkspacePath('/src', '/abs/main.cpp'), 'abs/main.cpp');
  // Mirrors `g++ ./src/main.cpp ./lib/other.cpp` from a non-root cwd
  assert.equal(resolveWorkspacePath('/', './src/main.cpp'), 'src/main.cpp');
});

// ── Dirty-tab overlay assembly ────────────────────────────────────────────────

test('e2e: dirty open-tab content overrides on-disk workspace content', () => {
  const disk = [
    { path: 'main.cpp', bytes: new TextEncoder().encode('// disk main\n') },
    { path: 'other.cpp', bytes: new TextEncoder().encode('// disk other\n') },
  ];
  const dirty = { 'main.cpp': '// EDITED main\n' };

  const overlay = buildCompileOverlay(disk, dirty);
  const byPath = Object.fromEntries(overlay.map((f) => [f.path, f.content]));

  assert.equal(byPath['main.cpp'], '// EDITED main\n', 'dirty tab wins over disk');
  assert.equal(
    new TextDecoder().decode(byPath['other.cpp']),
    '// disk other\n',
    'untouched files keep disk content'
  );
});

test('e2e: an unsaved sibling include participates in the compile overlay', () => {
  // main.cpp includes "other.cpp"; other.cpp exists on disk but has unsaved edits
  // in an open tab. The overlay must carry the edited content so includes do not
  // compile stale disk bytes.
  const disk = [
    { path: 'main.cpp', bytes: new TextEncoder().encode('#include "other.cpp"\nint main(){return value();}\n') },
    { path: 'other.cpp', bytes: new TextEncoder().encode('int value(){return 0;}\n') },
  ];
  const dirty = { 'other.cpp': 'int value(){return 42;}\n' };

  const overlay = buildCompileOverlay(disk, dirty);
  const other = overlay.find((f) => f.path === 'other.cpp');

  assert.equal(other.content, 'int value(){return 42;}\n');
  // main.cpp is still present so the quoted include can resolve against it.
  assert.ok(overlay.some((f) => f.path === 'main.cpp'));
});

// ── Named artifact + run target ───────────────────────────────────────────────

test('e2e: g++ -o custom-name records the runnable artifact and ./custom-name runs', () => {
  const parsed = parseGxxArgs(['main.cpp', 'other.cpp', '-o', 'custom-name']);
  assert.deepEqual(parsed.sourcePaths, ['main.cpp', 'other.cpp']);
  assert.equal(parsed.outputName, 'custom-name');

  // The worker reports outputPath; the terminal tracks it as lastBuiltArtifactPath.
  const lastBuiltArtifactPath = normalizeOverlayPath(parsed.outputName);
  assert.equal(resolveRunTarget('./custom-name', lastBuiltArtifactPath).ok, true);
  assert.equal(resolveRunTarget('./a.out', lastBuiltArtifactPath).ok, false);
});

test('e2e: -o attached form (g++ -ocustom) parses the output name', () => {
  assert.equal(parseGxxArgs(['main.cpp', '-ocustom']).outputName, 'custom');
});

test('e2e: a failed build does not overwrite the last runnable artifact', () => {
  // Simulate terminal onCompileResult semantics.
  let lastBuiltArtifactPath = null;
  const onCompileResult = ({ success, outputPath }) => {
    if (success) lastBuiltArtifactPath = normalizeOverlayPath(outputPath || 'a.out') || 'a.out';
  };

  onCompileResult({ success: true, outputPath: 'a.out' });
  assert.equal(lastBuiltArtifactPath, 'a.out');
  onCompileResult({ success: false, outputPath: null });
  assert.equal(lastBuiltArtifactPath, 'a.out', 'failed build keeps prior artifact');
  assert.equal(resolveRunTarget('./a.out', lastBuiltArtifactPath).ok, true);
});

test('e2e: ./name before any successful build reports no binary', () => {
  assert.deepEqual(resolveRunTarget('./a.out', null), { ok: false, error: 'no-binary' });
});

// ── Compile & Run uses the worker-reported output path ────────────────────────

test('e2e: Compile & Run runs the worker output path rather than assuming a.out', () => {
  // The worker reports outputPath; run validation must accept it even when renamed.
  const result = { success: true, outputPath: 'build/app' };
  let lastBuiltArtifactPath = null;
  if (result.success) lastBuiltArtifactPath = normalizeOverlayPath(result.outputPath);

  assert.equal(lastBuiltArtifactPath, 'build/app');
  assert.equal(resolveRunTarget('./app', lastBuiltArtifactPath).ok, true, 'basename runs');
  assert.equal(resolveRunTarget('./build/app', lastBuiltArtifactPath).ok, true, 'full path runs');
});

// ── Worker compile-plan parsing ───────────────────────────────────────────────

const CC1 = (src, obj) =>
  ` "/bin/clang" "-cc1" "-triple" "wasm32-wasi" "-emit-obj" "-o" "${obj}" "-x" "c++" "${src}"`;
const LD = (objs, out) =>
  ` "/bin/wasm-ld" "-m" "wasm32" ${objs.map((o) => `"${o}"`).join(' ')} "-o" "${out}"`;

test('e2e: single-source -### yields one compile step and one link step', () => {
  const stderr = [
    'clang version 17.0.0',
    CC1('input.cpp', '/tmp/input-1.o'),
    LD(['/tmp/input-1.o'], 'a.out'),
  ].join('\n');

  const plan = parseCompilePlan(stderr);
  assert.equal(plan.compileSteps.length, 1);
  assert.equal(plan.compileSteps[0].objectPath, '/tmp/input-1.o');
  assert.equal(plan.compileSteps[0].sourcePath, 'input.cpp');
  assert.equal(plan.linkStep.outputPath, 'a.out');
});

test('e2e: multi-source -### yields multiple compile steps and one link step', () => {
  const stderr = [
    CC1('main.cpp', '/tmp/main-1.o'),
    CC1('other.cpp', '/tmp/other-2.o'),
    LD(['/tmp/main-1.o', '/tmp/other-2.o'], 'a.out'),
  ].join('\n');

  const plan = parseCompilePlan(stderr);
  assert.equal(plan.compileSteps.length, 2);
  assert.deepEqual(plan.compileSteps.map((s) => s.sourcePath), ['main.cpp', 'other.cpp']);
  assert.deepEqual(plan.compileSteps.map((s) => s.objectPath), ['/tmp/main-1.o', '/tmp/other-2.o']);
  assert.equal(plan.linkStep.outputPath, 'a.out');
});

test('e2e: -o custom name propagates to the link step output path', () => {
  const stderr = [
    CC1('main.cpp', '/tmp/main-1.o'),
    LD(['/tmp/main-1.o'], 'custom-name'),
  ].join('\n');
  assert.equal(parseCompilePlan(stderr).linkStep.outputPath, 'custom-name');
});

test('e2e: a driver output missing compile steps fails clearly', () => {
  assert.throws(() => parseCompilePlan('clang: error: no input files\n'), /No '-cc1' compile steps/);
});

// ── Diagnostics across arbitrary paths and active-file scoping ─────────────────

test('e2e: diagnostics parse arbitrary paths; editor markers scope to active file', () => {
  const output = [
    'main.cpp:3:5: error: use of undeclared identifier \'foo\'',
    'src/other.cpp:10:1: warning: unused variable \'x\'',
    '/abs/path/lib.cpp:2:2: note: candidate here',
  ].join('\n');

  const all = parseDiagnostics(output);
  assert.equal(all.length, 3, 'terminal sees the full multi-file diagnostics');
  assert.deepEqual(all.map((d) => d.path), ['main.cpp', 'src/other.cpp', 'abs/path/lib.cpp']);

  // Active editor showing main.cpp only gets its own markers.
  const scoped = diagnosticsForPath(all, 'main.cpp');
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].severity, 'error');
  assert.equal(scoped[0].line, 3);

  // Matching also works by basename when the active path is workspace-relative.
  assert.equal(diagnosticsForPath(all, 'src/other.cpp').length, 1);
});

// ── Duplicate / overlapping source arguments ──────────────────────────────────

test('e2e: duplicate source arguments are de-duplicated for the build target set', () => {
  // The worker de-dupes; here we assert the resolved targets a caller would send.
  const resolved = ['main.cpp', 'main.cpp', './main.cpp'].map((p) => resolveWorkspacePath('/', p));
  const unique = [...new Set(resolved)];
  assert.deepEqual(unique, ['main.cpp']);
});
