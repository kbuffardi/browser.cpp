/**
 * Compiler flags and runtime imports for the opt-in Memory Debug Mode.
 *
 * Clang can instrument wasm32-wasi programs for UndefinedBehaviorSanitizer,
 * but the browsercc sysroot does not ship compiler-rt's UBSan handlers. The
 * worker supplies the fatal handlers as WebAssembly imports, reads Clang's
 * source-location metadata from linear memory, reports the failure, and stops
 * the program. libc++ debug hardening separately covers checked container
 * operations such as vector::operator[].
 *
 * UBSan interface reference:
 * https://clang.llvm.org/docs/UndefinedBehaviorSanitizer.html
 */

'use strict';

const UBSAN_PREFIX = '__ubsan_handle_';
const UBSAN_ABORT_SUFFIX = '_abort';
const MAX_SOURCE_PATH_BYTES = 4096;
const MEMORY_DEBUG_EXIT_CODE = 134;

const HANDLER_LABELS = Object.freeze({
  type_mismatch_v1: 'type mismatch',
  alignment_assumption: 'alignment assumption failed',
  add_overflow: 'addition overflow',
  sub_overflow: 'subtraction overflow',
  mul_overflow: 'multiplication overflow',
  negate_overflow: 'negation overflow',
  divrem_overflow: 'division or remainder overflow',
  shift_out_of_bounds: 'shift out of bounds',
  out_of_bounds: 'out-of-bounds access',
  builtin_unreachable: 'unreachable code executed',
  missing_return: 'missing return value',
  vla_bound_not_positive: 'variable-length array bound is not positive',
  float_cast_overflow: 'floating-point cast overflow',
  load_invalid_value: 'invalid value loaded',
  invalid_builtin: 'invalid compiler builtin argument',
  function_type_mismatch: 'function type mismatch',
  implicit_conversion: 'invalid implicit conversion',
  nonnull_arg: 'null passed to a non-null argument',
  nonnull_return: 'null returned from a non-null function',
  nullability_arg: 'nullability argument violation',
  nullability_return: 'nullability return violation',
  pointer_overflow: 'pointer overflow',
});

export class MemoryDebugRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MemoryDebugRuntimeError';
    this.exitCode = MEMORY_DEBUG_EXIT_CODE;
    this.__memory_debug_exit__ = true;
  }
}

/** Return the centrally managed compile/link profile for Memory Debug Mode. */
export function memoryDebugFlags(enabled) {
  if (!enabled) return [];
  return [
    '-g',
    '-fsanitize=undefined',
    '-fno-sanitize-recover=all',
    '-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_DEBUG',
    '-Wl,--allow-undefined',
  ];
}

export function isMemoryDebugRuntimeError(error) {
  return Boolean(error?.__memory_debug_exit__);
}

function handlerKind(name) {
  const withoutPrefix = name.startsWith(UBSAN_PREFIX)
    ? name.slice(UBSAN_PREFIX.length)
    : name;
  return withoutPrefix.endsWith(UBSAN_ABORT_SUFFIX)
    ? withoutPrefix.slice(0, -UBSAN_ABORT_SUFFIX.length)
    : withoutPrefix;
}

function handlerLabel(name) {
  const kind = handlerKind(name);
  return HANDLER_LABELS[kind] || kind.replaceAll('_', ' ');
}

function readCString(memory, pointer) {
  if (!memory?.buffer || !Number.isInteger(pointer) || pointer <= 0) return '';
  const bytes = new Uint8Array(memory.buffer);
  if (pointer >= bytes.length) return '';
  const limit = Math.min(bytes.length, pointer + MAX_SOURCE_PATH_BYTES);
  let end = pointer;
  while (end < limit && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(pointer, end));
}

/**
 * Read the SourceLocation prefix used by UBSan's handler metadata on wasm32:
 * `{ const char *filename; uint32_t line; uint32_t column; }`.
 */
function readSourceLocation(memory, dataPointer) {
  if (!memory?.buffer || !Number.isInteger(dataPointer) || dataPointer <= 0) return null;
  if (dataPointer + 12 > memory.buffer.byteLength) return null;
  const view = new DataView(memory.buffer);
  const filenamePointer = view.getUint32(dataPointer, true);
  const line = view.getUint32(dataPointer + 4, true);
  const column = view.getUint32(dataPointer + 8, true);
  const filename = readCString(memory, filenamePointer);
  if (!filename || line === 0) return null;
  return { filename, line, column };
}

function formatDiagnostic(name, location) {
  const prefix = location
    ? `${location.filename}:${location.line}:${location.column}`
    : 'Memory Debug Mode';
  return `${prefix}: runtime error: ${handlerLabel(name)}\n`;
}

function isSupportedHandlerImport(descriptor) {
  return descriptor.kind === 'function' && descriptor.name.startsWith(UBSAN_PREFIX);
}

/**
 * Return unresolved imports that are not WASI functions or UBSan handlers.
 * Memory Debug Mode uses `--allow-undefined` only because wasm-ld has no UBSan
 * runtime to resolve; validating the finished module keeps ordinary missing
 * user symbols as link failures instead of silently importing them.
 */
export function unsupportedMemoryDebugImports(module) {
  return WebAssembly.Module.imports(module).filter((descriptor) => (
    descriptor.module !== 'wasi_snapshot_preview1' && !isSupportedHandlerImport(descriptor)
  ));
}

/**
 * Build only the import namespaces and fatal handlers required by a compiled
 * module. `getMemory` is deferred because the WebAssembly instance does not
 * exist until after its imports have been constructed.
 */
export function createMemoryDebugImports({ module, getMemory, onStderr = () => {} }) {
  const imports = {};
  for (const descriptor of WebAssembly.Module.imports(module)) {
    if (!isSupportedHandlerImport(descriptor)) continue;
    const namespace = (imports[descriptor.module] ||= {});
    namespace[descriptor.name] = (dataPointer) => {
      const diagnostic = formatDiagnostic(
        descriptor.name,
        readSourceLocation(getMemory?.(), Number(dataPointer))
      );
      onStderr(diagnostic);
      throw new MemoryDebugRuntimeError(diagnostic.trim());
    };
  }
  return imports;
}
