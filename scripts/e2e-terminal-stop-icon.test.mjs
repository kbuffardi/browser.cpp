import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const indexHtmlPath = resolve('src/ui/index.html');

function extractStopButtonMarkup(html) {
  const match = html.match(/<button id="btn-stop-run"[\s\S]*?<\/button>/);
  assert.ok(match, 'stop button markup should exist');
  return match[0];
}

test('e2e: stop button uses the alert-octagon svg instead of the square stop icon', async () => {
  const html = await readFile(indexHtmlPath, 'utf8');
  const markup = extractStopButtonMarkup(html);

  assert.match(markup, /class="terminal-stop-icon"/);
  assert.match(markup, /<svg[\s\S]*aria-hidden="true"[\s\S]*focusable="false"/);
  assert.match(markup, /<path d="M14\.897 1a4 4 0 0 1 2\.664 1\.016/);
  assert.doesNotMatch(markup, /codicon-debug-stop/);
});
