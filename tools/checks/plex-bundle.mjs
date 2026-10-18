// Shared by the Plex checks: bundles the desktop main-process modules they drive (ConnectionManager with its plex.tv
// client and PlexClient, CredentialVault) for plain Node, with Electron stubbed as a dev build (so
// WICABY_PLEXTV_BASE points plex.tv at the mock). The vault's OS encryption is a reversible test transform (never a
// real key); i18n falls back to the message keys.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const desktop = path.resolve(import.meta.dirname, '..', '..', 'apps', 'desktop', 'src');

export const electronStub = {
  name: 'electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `
        export const app = { isReady: () => false, isPackaged: false, getLocale: () => 'en', getPath: () => '' };
        export const net = { fetch: (...a) => globalThis.fetch(...a), request: () => { throw new Error('electron net is not available in checks'); } };
        const xor = (b) => Buffer.from(b.map((c) => c ^ 0x5a));
        export const safeStorage = {
          isEncryptionAvailable: () => true,
          encryptString: (t) => Buffer.concat([Buffer.from('v10'), xor(Buffer.from(t, 'utf8'))]),
          decryptString: (b) => xor(b.subarray(3)).toString('utf8'),
          getSelectedStorageBackend: () => 'test',
        };
        export default { app, net, safeStorage };
      `,
    }));
  },
};

// Every socket the checks open (fetch, WebSocket, http) must stay on loopback: anything else is refused before a
// byte leaves and recorded here, and each check asserts this list is empty at the end (a probe the app swallows
// would otherwise go unnoticed).
export const refused = [];
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+|localhost)$/;
{
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...a) {
    let o = a[0];
    if (Array.isArray(o)) o = o[0];
    // connect(options) / connect(port, host) / connect(path): a pipe path is local.
    const h = o && typeof o === 'object' ? (o.path ? undefined : (o.host ?? 'localhost')) : typeof o === 'string' ? undefined : typeof a[1] === 'string' ? a[1] : 'localhost';
    if (h !== undefined && !LOOPBACK.test(String(h).replace(/^\[|\]$/g, ''))) {
      refused.push(String(h));
      throw new Error(`GUARD: non-loopback connect to ${h}`);
    }
    return connect.apply(this, a);
  };
}

export async function bundlePlex() {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-plex-bundle-')), 'plex.mjs');
  await build({
    stdin: {
      contents: [
        "export { ConnectionManager } from './main/connection/connection-manager';",
        "export { PlexClient } from './main/connection/plex-client';",
        "export { CredentialVault } from './main/core/vault';",
        "export { rankConnections } from './shared/plex/connections';",
        // Live TV through the Plex adapter (plex-livetv-check): the renderer's request builders and normalisers.
        "export * as liveDialect from './shared/livetv/dialect';",
        "export { normalizeChannel, normalizeProgram } from './shared/livetv/model';",
        "export { buildOverlay, normalizeTimers } from './shared/livetv/timers';",
        "export { pickPlay } from './main/livetv/live-session';",
      ].join('\n'),
      resolveDir: desktop,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    logLevel: 'error',
    plugins: [electronStub],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  return import(pathToFileURL(out).href);
}

export const identity = { client: 'Wicaby', version: '0.0.0-check', deviceId: 'check-device', deviceName: 'check' };

// The main-process logger and the mock print to the console: quiet while fn runs.
export async function quiet(fn) {
  if (process.env.PLEX_VERBOSE) return fn();
  const saved = [console.log, console.warn, console.error, console.info, console.debug];
  console.log = console.warn = console.error = console.info = console.debug = () => {};
  try {
    return await fn();
  } finally {
    [console.log, console.warn, console.error, console.info, console.debug] = saved;
  }
}
