import root from '../../../package.json' with { type: 'json' };
import server from '../package.json' with { type: 'json' };
import mobile from '../../mobile/package.json' with { type: 'json' };
import extension from '../../extension/manifest.json' with { type: 'json' };
export const versions = Object.freeze({
  version: root.version,
  server: server.version,
  mobile: mobile.version,
  extension: extension.version,
});
