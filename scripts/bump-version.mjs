import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const paths = ['package.json', 'apps/server/package.json', 'apps/mobile/package.json', 'apps/extension/package.json', 'apps/extension/manifest.json'];
const entries = await Promise.all(paths.map(async (path) => ({ path, data: JSON.parse(await readFile(new URL(path, root), 'utf8')) })));
const current = entries[0].data.version;
const lockPath = new URL('package-lock.json', root);
const lock = JSON.parse(await readFile(lockPath, 'utf8'));
const lockEntries = ['', 'apps/server', 'apps/mobile', 'apps/extension'];
if (!/^\d+\.\d+\.\d+$/.test(current) || entries.some(({ data }) => data.version !== current)
  || lock.version !== current || lockEntries.some((path) => lock.packages[path]?.version !== current)) {
  throw new Error('Version mismatch: root, workspaces, extension manifest and lockfile must agree.');
}
const kind = process.argv[2] || 'patch';
if (kind === '--check') {
  console.log(`All Motro components use v${current}.`);
} else {
  const index = ['major', 'minor', 'patch'].indexOf(kind);
  if (index < 0) throw new Error('Usage: npm run version:bump -- [patch|minor|major]');
  const parts = current.split('.').map(Number);
  parts[index]++;
  for (let i = index + 1; i < parts.length; i++) parts[i] = 0;
  const version = parts.join('.');
  for (const { path, data } of entries) {
    data.version = version;
    await writeFile(fileURLToPath(new URL(path, root)), JSON.stringify(data, null, 2) + '\n');
  }
  lock.version = version;
  for (const path of lockEntries) lock.packages[path].version = version;
  await writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n');
  console.log(`Motro ${current} -> ${version}. Commit all version files together.`);
}
