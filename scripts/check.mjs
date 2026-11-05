import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await check(file);
    else if (/\.(m?js)$/.test(file)) {
      const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(result.status || 1);
    } else if (file.endsWith('.json')) {
      JSON.parse(await readFile(file, 'utf8'));
    }
  }
}

await check('apps');
await check('scripts');
await check('tests');
const config = spawnSync(process.execPath, ['--check', 'playwright.config.js'], { stdio: 'inherit' });
if (config.status !== 0) process.exit(config.status || 1);
console.log('JavaScript syntax and JSON checks passed.');
