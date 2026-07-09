import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

export default {
  sourceDir: path.join(repoRoot, 'dist-firefox'),
  artifactsDir: path.join(repoRoot, 'release', 'firefox-webext'),
};
