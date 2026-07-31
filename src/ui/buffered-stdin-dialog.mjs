'use strict';

import { BUFFERED_STDIN_MAX_BYTES } from '../workers/run-request.mjs';

export function requestBufferedStdin() {
  const dialog = document.getElementById('buffered-stdin-dialog');
  const input = document.getElementById('buffered-stdin-input');
  const feedback = document.getElementById('buffered-stdin-feedback');
  const runButton = document.getElementById('buffered-stdin-run');
  const cancelButton = document.getElementById('buffered-stdin-cancel');

  if (!dialog || !input || !feedback || !runButton || !cancelButton) {
    throw new Error('Buffered stdin dialog is unavailable.');
  }

  const previouslyFocused = document.activeElement;
  input.value = '';
  input.removeAttribute('aria-invalid');
  feedback.classList.remove('is-error');

  return new Promise((resolve) => {
    let settled = false;

    const updateFeedback = () => {
      const byteLength = new TextEncoder().encode(input.value).byteLength;
      feedback.textContent =
        `${byteLength.toLocaleString()} / ${BUFFERED_STDIN_MAX_BYTES.toLocaleString()} bytes`;
      feedback.classList.remove('is-error');
      input.removeAttribute('aria-invalid');
      return byteLength;
    };

    const cleanup = () => {
      input.removeEventListener('input', updateFeedback);
      runButton.removeEventListener('click', submit);
      cancelButton.removeEventListener('click', cancel);
      dialog.removeEventListener('cancel', cancel);
      dialog.removeEventListener('close', cancel);
    };

    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (dialog.open) dialog.close();
      previouslyFocused?.focus?.();
      resolve(value);
    };

    const submit = () => {
      const byteLength = updateFeedback();
      if (byteLength > BUFFERED_STDIN_MAX_BYTES) {
        feedback.textContent =
          `Input is too large. Keep pre-supplied stdin at or below ${BUFFERED_STDIN_MAX_BYTES.toLocaleString()} bytes.`;
        feedback.classList.add('is-error');
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      finish(input.value);
    };

    const cancel = (event) => {
      event?.preventDefault?.();
      finish(null);
    };

    input.addEventListener('input', updateFeedback);
    runButton.addEventListener('click', submit);
    cancelButton.addEventListener('click', cancel);
    dialog.addEventListener('cancel', cancel);
    dialog.addEventListener('close', cancel);

    updateFeedback();
    dialog.showModal();
    input.focus();
  });
}
