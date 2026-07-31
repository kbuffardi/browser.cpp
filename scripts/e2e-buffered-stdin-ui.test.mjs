import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('e2e: buffered stdin dialog has accessible controls and status feedback', async () => {
  const html = await readFile('src/ui/index.html', 'utf8');
  const dialog = html.match(/<dialog id="buffered-stdin-dialog"[\s\S]*?<\/dialog>/)?.[0];

  assert.ok(dialog, 'buffered stdin dialog markup should exist');
  assert.match(dialog, /aria-labelledby="buffered-stdin-title"/);
  assert.match(dialog, /<label for="buffered-stdin-input"/);
  assert.match(dialog, /<textarea[\s\S]*id="buffered-stdin-input"[\s\S]*aria-describedby="buffered-stdin-feedback"/);
  assert.match(dialog, /id="buffered-stdin-feedback"[\s\S]*aria-live="polite"/);
  assert.match(dialog, /<button[^>]*id="buffered-stdin-cancel"/);
  assert.match(dialog, /<button[^>]*id="buffered-stdin-run"/);
});

test('e2e: buffered stdin dialog styles remain usable in narrow extension windows', async () => {
  const css = await readFile('src/ui/styles.css', 'utf8');

  assert.match(css, /#buffered-stdin-dialog\s*\{[\s\S]*width:\s*min\(/);
  assert.match(css, /#buffered-stdin-input\s*\{[\s\S]*resize:\s*vertical/);
  assert.match(css, /buffered-stdin-feedback/);
});
