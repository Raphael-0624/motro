import { copyFile, mkdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const target = new URL('apps/extension/vendor/', root);
await mkdir(target, { recursive: true });
await copyFile(new URL('node_modules/qrcode-generator/dist/qrcode.mjs', root), new URL('qrcode.mjs', target));
console.log('Synced qrcode-generator. Keep vendor/THIRD_PARTY_LICENSES.txt with this file.');
