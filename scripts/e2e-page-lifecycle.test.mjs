import test from 'node:test';
import assert from 'node:assert/strict';

test('e2e: page unload only terminates the worker synchronously', async () => {
  const { registerPageUnload } = await import('../src/ui/page-lifecycle.mjs');
  const listeners = new Map();
  const events = [];
  const target = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
  };
  const worker = {
    terminate() {
      events.push('terminate');
    },
  };

  registerPageUnload(target, worker);
  const result = listeners.get('beforeunload')();

  assert.equal(result, undefined);
  assert.deepEqual(events, ['terminate']);
});
