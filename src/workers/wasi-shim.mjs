'use strict';

const SAB_HEADER_BYTES = 8;

const WASI_ERRNO_SUCCESS = 0;
const WASI_ERRNO_BADF = 8;
const WASI_ERRNO_EXIST = 20;
const WASI_ERRNO_INVAL = 28;
const WASI_ERRNO_NOENT = 44;
const WASI_ERRNO_SPIPE = 70;

const WASI_FDFLAG_APPEND = 1;
const VFS_PREOPEN_FD = 3;

function normVfsPath(p) {
  const parts = [];
  for (const seg of String(p || '').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join('/');
}

function createWritableFile(path, data, flags = 0) {
  return {
    type: 'file',
    path,
    data,
    cursor: (flags & WASI_FDFLAG_APPEND) !== 0 ? data.length : 0,
    dirty: false,
    created: false,
    flags: flags >>> 0,
  };
}

export function createWasiRuntime({
  stdin = { mode: 'none' },
  onStdout = () => {},
  onStderr = () => {},
}) {
  let memory = null;
  let runVfs = new Map();
  let runVfsDirty = new Set();
  let runVfsDeletes = new Set();
  let runFds = new Map();
  let runNextFd = 4;
  const stdinMode = stdin?.mode || 'none';
  let sharedBuffer = null;
  let sabControl = null;
  const stdinQueue = [];
  const messageStdinChunks = [];
  let messageStdinChunkIndex = 0;
  let messageStdinChunkOffset = 0;
  let stdinEnded = false;
  const stdinWaiters = [];

  if (stdinMode === 'interactive') {
    if (
      typeof SharedArrayBuffer === 'undefined' ||
      !(stdin.sharedBuffer instanceof SharedArrayBuffer)
    ) {
      throw new TypeError('Interactive stdin requires a SharedArrayBuffer.');
    }
    sharedBuffer = stdin.sharedBuffer;
    sabControl = new Int32Array(sharedBuffer);
  } else if (stdinMode !== 'none' && stdinMode !== 'interactive-message') {
    throw new TypeError(`Unsupported stdin mode: ${String(stdinMode)}`);
  }

  function wakeStdinWaiters() {
    for (const resolve of stdinWaiters.splice(0)) resolve();
  }

  function pushStdin(bytes) {
    if (stdinMode !== 'interactive-message') return false;
    if (stdinEnded) return false;
    if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) {
      throw new TypeError('Message stdin requires Uint8Array or ArrayBuffer bytes.');
    }
    const chunk = new Uint8Array(bytes).slice();
    if (chunk.byteLength === 0) return false;
    messageStdinChunks.push(chunk);
    wakeStdinWaiters();
    return true;
  }

  function endStdin() {
    if (stdinMode !== 'interactive-message') return false;
    if (stdinEnded) return false;
    stdinEnded = true;
    wakeStdinWaiters();
    return true;
  }

  function cancelStdin() {
    if (stdinMode !== 'interactive-message') return false;
    stdinEnded = true;
    messageStdinChunks.length = 0;
    messageStdinChunkIndex = 0;
    messageStdinChunkOffset = 0;
    wakeStdinWaiters();
    return true;
  }

  function waitForStdin() {
    if (messageStdinChunkIndex < messageStdinChunks.length || stdinEnded) {
      return Promise.resolve();
    }
    return new Promise((resolve) => stdinWaiters.push(resolve));
  }

  function drainMessageStdin(base, len) {
    let copied = 0;
    while (copied < len && messageStdinChunkIndex < messageStdinChunks.length) {
      const chunk = messageStdinChunks[messageStdinChunkIndex];
      const available = chunk.length - messageStdinChunkOffset;
      const toCopy = Math.min(len - copied, available);
      u8().set(
        chunk.subarray(messageStdinChunkOffset, messageStdinChunkOffset + toCopy),
        base + copied
      );
      copied += toCopy;
      messageStdinChunkOffset += toCopy;
      if (messageStdinChunkOffset === chunk.length) {
        messageStdinChunkIndex += 1;
        messageStdinChunkOffset = 0;
      }
    }

    if (messageStdinChunkIndex === messageStdinChunks.length) {
      messageStdinChunks.length = 0;
      messageStdinChunkIndex = 0;
    }
    return copied;
  }

  const setMemory = (m) => {
    memory = m;
  };

  const getMemoryForTesting = () => memory;

  const view = () => {
    if (!memory) throw new Error('WASI memory has not been set');
    return new DataView(memory.buffer);
  };

  const u8 = () => {
    if (!memory) throw new Error('WASI memory has not been set');
    return new Uint8Array(memory.buffer);
  };

  function iovSpans(iovsPtr, iovsLen) {
    const spans = [];
    const dv = view();
    for (let i = 0; i < iovsLen; i += 1) {
      const base = dv.getUint32(iovsPtr + (i * 8), true);
      const len = dv.getUint32(iovsPtr + (i * 8) + 4, true);
      spans.push({ base, len });
    }
    return spans;
  }

  function initRunVfs(vfsFiles = []) {
    runVfs = new Map();
    runVfsDirty = new Set();
    runVfsDeletes = new Set();
    runFds = new Map();
    runNextFd = 4;
    runFds.set(VFS_PREOPEN_FD, { type: 'preopen' });

    for (const { path, bytes } of vfsFiles || []) {
      const key = normVfsPath(path);
      if (key) runVfs.set(key, new Uint8Array(bytes));
    }
  }

  function flushRunFds() {
    for (const file of runFds.values()) {
      if (file.type === 'file' && (file.dirty || file.created)) {
        runVfs.set(file.path, file.data);
        runVfsDirty.add(file.path);
        file.created = false;
      }
    }
  }

  function getDirtyVfsFiles() {
    const result = [];
    for (const path of runVfsDirty) {
      if (runVfs.has(path)) {
        result.push({ path, bytes: runVfs.get(path) });
      }
    }
    return result;
  }

  function getDeletedVfsFiles() {
    return [...runVfsDeletes].filter((path) => !runVfs.has(path));
  }

  function applyAppendMode(file) {
    if ((file.flags & WASI_FDFLAG_APPEND) !== 0) {
      file.cursor = file.data.length;
    }
  }

  function writeToFile(file, base, len) {
    applyAppendMode(file);
    const needed = file.cursor + len;
    if (needed > file.data.length) {
      const grown = new Uint8Array(needed);
      grown.set(file.data);
      file.data = grown;
    }
    file.data.set(u8().subarray(base, base + len), file.cursor);
    file.cursor += len;
    file.dirty = true;
  }

  const wasi = {
    _setMemory: setMemory,

    fd_write(fd, iovsPtr, iovsLen, nwrittenPtr) {
      const spans = iovSpans(iovsPtr, iovsLen);
      let total = 0;

      for (const { base, len } of spans) {
        if (fd === 1 || fd === 2) {
          const text = new TextDecoder().decode(u8().subarray(base, base + len));
          if (fd === 1) onStdout(text);
          else onStderr(text);
        } else {
          const file = runFds.get(fd);
          if (!file || file.type !== 'file') {
            view().setUint32(nwrittenPtr, total, true);
            return WASI_ERRNO_BADF;
          }
          writeToFile(file, base, len);
        }
        total += len;
      }
      view().setUint32(nwrittenPtr, total, true);
      return WASI_ERRNO_SUCCESS;
    },

    fd_read(fd, iovsPtr, iovsLen, nreadPtr) {
      if (fd > 2) {
        const file = runFds.get(fd);
        if (!file || file.type !== 'file') {
          view().setUint32(nreadPtr, 0, true);
          return WASI_ERRNO_BADF;
        }
        const spans = iovSpans(iovsPtr, iovsLen);
        let total = 0;
        for (const { base, len } of spans) {
          const avail = file.data.length - file.cursor;
          if (avail <= 0) break;
          const toRead = Math.min(len, avail);
          u8().set(file.data.subarray(file.cursor, file.cursor + toRead), base);
          file.cursor += toRead;
          total += toRead;
        }
        view().setUint32(nreadPtr, total, true);
        return WASI_ERRNO_SUCCESS;
      }

      if (fd !== 0) {
        view().setUint32(nreadPtr, 0, true);
        return WASI_ERRNO_BADF;
      }

      const spans = iovSpans(iovsPtr, iovsLen);
      let total = 0;

      if (stdinMode === 'none') {
        view().setUint32(nreadPtr, 0, true);
        return WASI_ERRNO_SUCCESS;
      }

      for (const { base, len } of spans) {
        if (stdinQueue.length === 0) {
          if (Atomics.load(sabControl, 0) === 0) {
            Atomics.wait(sabControl, 0, 0);
          }

          const state = Atomics.load(sabControl, 0);
          if (state === -1) {
            Atomics.store(sabControl, 0, 0);
            Atomics.notify(sabControl, 0);
            break;
          }

          const dataLen = Atomics.load(sabControl, 1);
          const chunk = new Uint8Array(sharedBuffer, SAB_HEADER_BYTES, dataLen).slice();
          Array.prototype.push.apply(stdinQueue, chunk);

          Atomics.store(sabControl, 0, 0);
          Atomics.notify(sabControl, 0);
        }

        if (stdinQueue.length === 0) break;

        const toRead = Math.min(len, stdinQueue.length);
        for (let i = 0; i < toRead; i += 1) u8()[base + i] = stdinQueue.shift();
        total += toRead;
      }

      view().setUint32(nreadPtr, total, true);
      return WASI_ERRNO_SUCCESS;
    },

    proc_exit(code) {
      throw { __wasi_exit__: true, code };
    },

    environ_sizes_get(countPtr, bufSizePtr) {
      view().setUint32(countPtr, 0, true);
      view().setUint32(bufSizePtr, 0, true);
      return WASI_ERRNO_SUCCESS;
    },

    environ_get() {
      return WASI_ERRNO_SUCCESS;
    },

    args_sizes_get(argcPtr, argvBufSizePtr) {
      const arg0 = './a.out\0';
      view().setUint32(argcPtr, 1, true);
      view().setUint32(argvBufSizePtr, arg0.length, true);
      return WASI_ERRNO_SUCCESS;
    },

    args_get(argvPtr, argvBufPtr) {
      const arg0 = new TextEncoder().encode('./a.out\0');
      u8().set(arg0, argvBufPtr);
      view().setUint32(argvPtr, argvBufPtr, true);
      return WASI_ERRNO_SUCCESS;
    },

    fd_close(fd) {
      if (fd <= 2) return WASI_ERRNO_SUCCESS;
      const file = runFds.get(fd);
      if (!file) return WASI_ERRNO_BADF;
      if (file.type === 'file' && (file.dirty || file.created)) {
        runVfs.set(file.path, file.data);
        runVfsDirty.add(file.path);
        file.created = false;
      }
      runFds.delete(fd);
      return WASI_ERRNO_SUCCESS;
    },

    fd_seek(fd, offset, whence, newoffsetPtr) {
      const file = runFds.get(fd);
      if (!file || file.type !== 'file') return WASI_ERRNO_SPIPE;
      const SEEK_SET = 0;
      const SEEK_CUR = 1;
      const SEEK_END = 2;
      const off = Number(offset);
      let newPos;
      if (whence === SEEK_SET) newPos = off;
      else if (whence === SEEK_CUR) newPos = file.cursor + off;
      else if (whence === SEEK_END) newPos = file.data.length + off;
      else return WASI_ERRNO_INVAL;
      if (newPos < 0) return WASI_ERRNO_INVAL;
      file.cursor = newPos;
      view().setBigUint64(newoffsetPtr, BigInt(newPos), true);
      return WASI_ERRNO_SUCCESS;
    },

    fd_fdstat_get(fd, statPtr) {
      const dv = view();
      let filetype;
      let flags = 0;
      if (fd <= 2) {
        filetype = 2;
      } else {
        const file = runFds.get(fd);
        if (!file) return WASI_ERRNO_BADF;
        filetype = file.type === 'preopen' ? 3 : 4;
        flags = file.flags || 0;
      }
      dv.setUint8(statPtr, filetype);
      dv.setUint8(statPtr + 1, 0);
      dv.setUint16(statPtr + 2, flags & 0xFFFF, true);
      dv.setBigUint64(statPtr + 8, 0xFFFFFFFFFFFFFFFFn, true);
      dv.setBigUint64(statPtr + 16, 0xFFFFFFFFFFFFFFFFn, true);
      return WASI_ERRNO_SUCCESS;
    },

    fd_fdstat_set_flags(fd, flags) {
      const file = runFds.get(fd);
      if (!file || file.type !== 'file') return WASI_ERRNO_BADF;
      file.flags = Number(flags) >>> 0;
      applyAppendMode(file);
      return WASI_ERRNO_SUCCESS;
    },

    clock_time_get(_id, _precision, timePtr) {
      const ns = BigInt(Date.now()) * 1000000n;
      view().setBigUint64(timePtr, ns, true);
      return WASI_ERRNO_SUCCESS;
    },

    random_get(bufPtr, bufLen) {
      const buf = u8().subarray(bufPtr, bufPtr + bufLen);
      globalThis.crypto.getRandomValues(buf);
      return WASI_ERRNO_SUCCESS;
    },

    fd_prestat_get(fd, bufPtr) {
      if (fd === VFS_PREOPEN_FD) {
        view().setUint8(bufPtr, 0);
        view().setUint32(bufPtr + 4, 1, true);
        return WASI_ERRNO_SUCCESS;
      }
      return WASI_ERRNO_BADF;
    },

    fd_prestat_dir_name(fd, pathPtr) {
      if (fd === VFS_PREOPEN_FD) {
        u8()[pathPtr] = 46;
        return WASI_ERRNO_SUCCESS;
      }
      return WASI_ERRNO_BADF;
    },

    path_open(dirFd, _dirflags, pathPtr, pathLen, oflags,
      fsRightsBase, _fsRightsInheriting, fdflags, openedFdPtr) {
      if (dirFd !== VFS_PREOPEN_FD && !runFds.has(dirFd)) return WASI_ERRNO_BADF;

      const rawPath = new TextDecoder().decode(u8().subarray(pathPtr, pathPtr + pathLen));
      const path = normVfsPath(rawPath);

      const OFLAGS_CREAT = 0x0001;
      const OFLAGS_EXCL = 0x0004;
      const OFLAGS_TRUNC = 0x0008;
      const RIGHTS_FD_WRITE = 1n << 6n;

      const creat = !!(oflags & OFLAGS_CREAT);
      const excl = !!(oflags & OFLAGS_EXCL);
      const trunc = !!(oflags & OFLAGS_TRUNC);
      const wantsWrite = (BigInt(fsRightsBase) & RIGHTS_FD_WRITE) !== 0n;

      if (excl && runVfs.has(path)) return WASI_ERRNO_EXIST;

      let initialData;
      if (runVfs.has(path)) {
        initialData = trunc ? new Uint8Array(0) : new Uint8Array(runVfs.get(path));
      } else if (creat || wantsWrite) {
        initialData = new Uint8Array(0);
        runVfsDeletes.delete(path);
      } else {
        return WASI_ERRNO_NOENT;
      }

      const newFd = runNextFd++;
      const file = createWritableFile(path, initialData, Number(fdflags));
      file.created = (creat || wantsWrite) && !runVfs.has(path);
      runFds.set(newFd, file);
      view().setUint32(openedFdPtr, newFd, true);
      return WASI_ERRNO_SUCCESS;
    },

    path_unlink_file(dirFd, pathPtr, pathLen) {
      if (dirFd !== VFS_PREOPEN_FD && !runFds.has(dirFd)) return WASI_ERRNO_BADF;

      const rawPath = new TextDecoder().decode(u8().subarray(pathPtr, pathPtr + pathLen));
      const path = normVfsPath(rawPath);
      if (!runVfs.has(path)) return WASI_ERRNO_NOENT;

      runVfs.delete(path);
      runVfsDirty.delete(path);
      runVfsDeletes.add(path);
      return WASI_ERRNO_SUCCESS;
    },

    path_create_directory() {
      return WASI_ERRNO_SUCCESS;
    },

    path_filestat_get(_fd, _flags, pathPtr, pathLen, statPtr) {
      const rawPath = new TextDecoder().decode(u8().subarray(pathPtr, pathPtr + pathLen));
      const path = normVfsPath(rawPath);
      if (!runVfs.has(path)) return WASI_ERRNO_NOENT;
      const fileData = runVfs.get(path);
      const dv = view();
      dv.setBigUint64(statPtr, 0n, true);
      dv.setBigUint64(statPtr + 8, 0n, true);
      dv.setUint8(statPtr + 16, 4);
      dv.setBigUint64(statPtr + 24, 1n, true);
      dv.setBigUint64(statPtr + 32, BigInt(fileData.length), true);
      dv.setBigUint64(statPtr + 40, 0n, true);
      dv.setBigUint64(statPtr + 48, 0n, true);
      dv.setBigUint64(statPtr + 56, 0n, true);
      return WASI_ERRNO_SUCCESS;
    },
  };

  if (stdinMode === 'interactive-message') {
    const fdReadSync = wasi.fd_read.bind(wasi);
    wasi.fd_read = async (fd, iovsPtr, iovsLen, nreadPtr) => {
      if (fd !== 0) return fdReadSync(fd, iovsPtr, iovsLen, nreadPtr);

      const spans = iovSpans(iovsPtr, iovsLen);
      if (spans.every(({ len }) => len === 0)) {
        view().setUint32(nreadPtr, 0, true);
        return WASI_ERRNO_SUCCESS;
      }

      await waitForStdin();
      let total = 0;

      for (const { base, len } of spans) {
        const copied = drainMessageStdin(base, len);
        total += copied;
        if (copied < len) break;
      }

      view().setUint32(nreadPtr, total, true);
      return WASI_ERRNO_SUCCESS;
    };
  }

  return {
    wasi,
    setMemory,
    getMemoryForTesting,
    initRunVfs,
    flushRunFds,
    getDirtyVfsFiles,
    getDeletedVfsFiles,
    pushStdin,
    endStdin,
    cancelStdin,
  };
}
