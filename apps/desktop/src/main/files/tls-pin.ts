// TLS for WebDAV sources (file-sources-spec §7.3): normal CA validation, or a per-source pin of the leaf
// certificate's SHA-256. A pinned connection is handed to the HTTP client only after the handshake, once the
// fingerprint matched: on a mismatch the socket is destroyed before any request byte is written.
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

export type TlsPolicy = { mode: 'verify' } | { mode: 'pin'; sha256: string; subject: string; notAfter: string } | { mode: 'insecure-http' };

export interface PeerCert {
  sha256: string;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
}

export class PinMismatch extends Error {
  constructor(readonly cert: PeerCert) {
    super('certificate changed');
  }
}

// 'AB:CD:…' and 'abcd…' compare equal.
export const sameFingerprint = (a: string, b: string): boolean => a.replace(/:/g, '').toLowerCase() === b.replace(/:/g, '').toLowerCase();

function describe(c: tls.PeerCertificate): PeerCert {
  const name = (x: Record<string, unknown> | undefined) =>
    x
      ? Object.entries(x)
          .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('+') : String(v)}`)
          .join(', ')
      : '';
  return { sha256: c.fingerprint256 ?? '', subject: name(c.subject as unknown as Record<string, unknown>), issuer: name(c.issuer as unknown as Record<string, unknown>), validFrom: c.valid_from ?? '', validTo: c.valid_to ?? '' };
}

// Errors where the certificate itself was not trusted (offer the pin), not a network failure.
export function isCertError(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? '';
  return /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ALTNAME|ERR_TLS_CERT/i.test(code);
}

// The leaf certificate a server presents, without sending anything over the connection.
export function peekCertificate(host: string, port: number, timeoutMs = 5000): Promise<PeerCert> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false });
    const timer = setTimeout(() => s.destroy(new Error('timeout')), timeoutMs);
    s.once('secureConnect', () => {
      clearTimeout(timer);
      const cert = describe(s.getPeerCertificate());
      s.destroy();
      resolve(cert);
    });
    s.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// One agent per source: pinned sources never share connections (or trust) with anything else.
export function agentFor(policy: TlsPolicy | undefined): https.Agent {
  if (policy?.mode !== 'pin') return new https.Agent({ keepAlive: true, maxSockets: 4 });
  const pin = policy.sha256;
  const agent = new https.Agent({ keepAlive: true, maxSockets: 4, rejectUnauthorized: false });
  // The callback form lets the agent wait for the handshake before writing the request.
  (agent as unknown as { createConnection: unknown }).createConnection = (opts: tls.ConnectionOptions, cb: (err: Error | null, s?: tls.TLSSocket) => void) => {
    const s = tls.connect({ ...opts, rejectUnauthorized: false });
    const fail = (err: Error) => {
      s.destroy();
      cb(err);
    };
    s.once('error', fail);
    s.once('secureConnect', () => {
      s.removeListener('error', fail);
      const cert = describe(s.getPeerCertificate());
      if (!sameFingerprint(cert.sha256, pin)) return fail(new PinMismatch(cert));
      cb(null, s);
    });
    return undefined;
  };
  return agent;
}
