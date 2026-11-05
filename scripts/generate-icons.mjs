import { copyFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const source = fileURLToPath(new URL('assets/brand/icon.png', root));
const extension = new URL('apps/extension/icons/', root);
const mobile = new URL('apps/mobile/assets/', root);

// Packaging only: keep the supplied artwork and alpha, changing only resolution.
if (process.platform !== 'darwin') {
  throw new Error('Icon regeneration uses macOS sips. Prebuilt icons are checked in; normal development does not need this command.');
}
await Promise.all([mkdir(extension, { recursive: true }), mkdir(mobile, { recursive: true })]);
for (const size of [16, 32, 48, 128]) {
  const output = fileURLToPath(new URL(`icon-${size}.png`, extension));
  const result = spawnSync('sips', ['-z', String(size), String(size), source, '--out', output], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
for (const size of [32, 128]) {
  await copyFile(new URL(`icon-${size}.png`, extension), new URL(`icon-${size}.png`, mobile));
}
const result = spawnSync('sips', ['-z', '180', '180', source, '--out', fileURLToPath(new URL('apple-touch-icon.png', mobile))], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
