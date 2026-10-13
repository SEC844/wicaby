// Shared by the file sources checks: bundles the desktop main-process modules they drive (FileSources, FilesClient,
// the backends, the relay, ConnectionManager, CredentialVault) for plain Node, with Electron stubbed. The vault's
// OS encryption is a reversible test transform (never a real key); i18n falls back to the message keys.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const desktop = path.resolve(import.meta.dirname, '..', '..', 'apps', 'desktop', 'src');

const electronStub = {
  name: 'electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `
        export const app = { isReady: () => false, isPackaged: true, getLocale: () => 'en', getPath: () => '' };
        export const net = { fetch: (...a) => globalThis.fetch(...a), request: () => { throw new Error('electron net is not available in checks'); } };
        const xor = (b) => Buffer.from(b.map((c) => c ^ 0x5a));
        export const safeStorage = {
          isEncryptionAvailable: () => true,
          encryptString: (t) => Buffer.concat([Buffer.from('v10'), xor(Buffer.from(t, 'utf8'))]),
          decryptString: (b) => xor(b.subarray(3)).toString('utf8'),
          getSelectedStorageBackend: () => 'test',
        };
        export const powerSaveBlocker = { start: () => 0, stop: () => undefined };
        export default { app, net, safeStorage };
      `,
    }));
  },
};

export async function bundleFiles() {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-files-bundle-')), 'files.mjs');
  await build({
    stdin: {
      contents: [
        "export { FileSources } from './main/files/sources';",
        "export { FilesClient } from './main/files/files-client';",
        "export { LocalBackend } from './main/files/backend-local';",
        "export { WebDavBackend } from './main/files/backend-webdav';",
        "export { FilesError } from './main/files/backend';",
        "export { LoopbackRelay } from './main/files/loopback';",
        "export { ProgressStore } from './main/files/progress';",
        "export { ConnectionManager } from './main/connection/connection-manager';",
        "export { CredentialVault } from './main/core/vault';",
        "export { logger } from './main/core/log';",
        "export { encodeId, decodeId, ROOT_ID } from './shared/files/ids';",
        "export { uncPath, parseSourceUrl } from './shared/files/urls';",
        "export { buildQuery, encodeName, parsePacket, servicesOf, discover } from './main/files/mdns';",
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

// A SessionHost that records what FileSources hands the ConnectionManager.
export function fakeHost() {
  const sessions = new Map();
  return {
    sessions,
    putLocal: (info, client, status) => sessions.set(info.id, { info, client, status }),
    dropLocal: (id) => sessions.delete(id),
  };
}

// Quiet the main-process logger (it writes to the console when not initialised).
export async function quiet(fn) {
  const saved = [console.log, console.warn, console.error, console.info, console.debug];
  console.log = console.warn = console.error = console.info = console.debug = () => {};
  try {
    return await fn();
  } finally {
    [console.log, console.warn, console.error, console.info, console.debug] = saved;
  }
}
