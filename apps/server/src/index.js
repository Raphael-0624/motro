import { networkInterfaces } from 'node:os';
import { createMotroServer } from './server.js';
import { versions } from './version.js';

const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 3030);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');

const addresses = Object.values(networkInterfaces()).flat()
  .filter((item) => item && item.family === 'IPv4' && !item.internal)
  .map((item) => item.address);
const publicUrl = process.env.PUBLIC_URL;
if (publicUrl && !['http:', 'https:'].includes(new URL(publicUrl).protocol)) {
  throw new Error('PUBLIC_URL must use http:// or https://');
}
const mobileUrls = publicUrl ? [new URL(publicUrl).origin]
  : [...new Set(addresses)].map((address) => `http://${address}:${port}`);
const allowedHosts = ['localhost', '127.0.0.1', '[::1]', ...addresses];
if (publicUrl) allowedHosts.push(new URL(publicUrl).hostname);
const extensionIds = process.env.EXTENSION_IDS?.split(',').map((id) => id.trim()).filter(Boolean);
const app = createMotroServer({ mobileUrls, allowedHosts, extensionIds, dataDirectory: process.env.DATA_DIR || undefined });

app.server.listen(port, host, () => {
  console.log(`\nMotro v${versions.version} is running: http://localhost:${port}`);
  for (const url of mobileUrls) console.log(`Phone URL: ${url}`);
  console.log('Load apps/extension as an unpacked Chrome/Edge extension.\n');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => { await app.close(); process.exit(0); });
}
