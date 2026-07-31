'use strict';

export function supportsJspi(root = globalThis) {
  return typeof root.WebAssembly?.Suspending === 'function' &&
    typeof root.WebAssembly?.promising === 'function';
}

function requireJspi(root) {
  if (!supportsJspi(root)) {
    throw new Error('JSPI is unavailable in this worker runtime.');
  }
}

export function createWasiImports(wasi, root = globalThis) {
  requireJspi(root);
  return {
    ...wasi,
    fd_read: new root.WebAssembly.Suspending(wasi.fd_read),
  };
}

export async function invokeWasiStart(instance, root = globalThis) {
  requireJspi(root);
  const promisingStart = root.WebAssembly.promising(instance.exports._start);
  return promisingStart();
}

export function createStdinSessionRouter(onInactiveMessage = () => {}) {
  let active = null;

  return {
    activate(sessionId, runtime) {
      active = { sessionId, runtime };
    },

    clear(runtime) {
      if (!runtime || active?.runtime === runtime) active = null;
    },

    route(message) {
      if (message.sessionId !== active?.sessionId) {
        onInactiveMessage('Ignored stdin message for an inactive session.');
        return false;
      }
      const accepted = message.type === 'stdin-data'
        ? active.runtime.pushStdin(message.bytes)
        : active.runtime.endStdin();
      if (!accepted) {
        onInactiveMessage('Ignored stdin message after EOF.');
        return false;
      }
      return true;
    },
  };
}
