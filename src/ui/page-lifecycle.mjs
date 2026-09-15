'use strict';

/** Register synchronous page teardown without starting asynchronous storage work. */
export function registerPageUnload(target, worker) {
  target.addEventListener('beforeunload', () => {
    worker.terminate();
  });
}
