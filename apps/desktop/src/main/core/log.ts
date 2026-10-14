import fs from 'node:fs';
import path from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';

const KEEP_FILES = 7;

class Logger {
  private stream: fs.WriteStream | null = null;
  private dir = '';
  filePath = '';

  init(dir: string): void {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    this.filePath = path.join(dir, `wicaby-${day}.log`);
    this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
    this.prune();
  }

  private prune(): void {
    try {
      const files = fs
        .readdirSync(this.dir)
        .filter((f) => /^wicaby-\d{4}-\d{2}-\d{2}\.log$/.test(f))
        .sort()
        .reverse();
      for (const old of files.slice(KEEP_FILES)) fs.rmSync(path.join(this.dir, old), { force: true });
    } catch {
      // Pruning is best effort.
    }
  }

  private write(level: Level, scope: string, message: string, extra?: unknown): void {
    // One entry per line: a message (renderer-supplied ones included) cannot forge extra entries.
    let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${oneLine(message)}`;
    if (extra !== undefined) {
      const detail = extra instanceof Error ? (extra.stack ?? extra.message) : safeJson(extra);
      line += ` ${detail}`;
    }
    line = redact(line);
    this.stream?.write(line + '\n');
    if (level === 'error') console.error(line);
    else if (process.env.WICABY_DEV_URL) console.log(line);
  }

  // For a message written right before app.exit(), which does not wait for the stream.
  // Entries still queued in the stream may land after it.
  errorSync(scope: string, message: string): void {
    const line = redact(`${new Date().toISOString()} ERROR [${scope}] ${oneLine(message)}`);
    console.error(line);
    try {
      if (this.filePath) fs.appendFileSync(this.filePath, line + '\n');
    } catch {
      // Best effort: the process is about to exit anyway.
    }
  }

  scope(name: string) {
    return {
      debug: (m: string, e?: unknown) => this.write('debug', name, m, e),
      info: (m: string, e?: unknown) => this.write('info', name, m, e),
      warn: (m: string, e?: unknown) => this.write('warn', name, m, e),
      error: (m: string, e?: unknown) => this.write('error', name, m, e),
    };
  }
}

// Credentials never reach the log file: query/header tokens (plain, quoted, JSON-escaped or
// percent-encoded), the MediaBrowser Authorization header, JSON secret fields and Emby's
// /Auth/Keys/<key> routes. Server query names and routes are case-insensitive, so are these.
// A quoted value runs to its matching (same escape depth) closing quote, or to the end of
// the line: an unterminated or oddly escaped value is over-redacted, never leaked.

// JSON fields, escaped JSON included (a JSON string serialized again): "AccessToken":"S",
// \"Pw\":\"S\", {"X-Emby-Authorization":"MediaBrowser ..."}.
const JSON_SECRET =
  /(?<!\\)(?<esc>\\*)"(?<key>[\w-]*(?:api_?key|token|password|pw|secret|authorization))\k<esc>"\s*:\s*\k<esc>"[\s\S]*?(?:(?<!\\)\k<esc>"|$)/gi;
// Names that only ever introduce a credential: any separator, whitespace alone included.
const STRONG_KEYS = String.raw`api[_-]?key|x-emby-token|x-mediabrowser-token|access[_-]?token`;
// Ordinary words ("stored token rejected"): only an explicit =, : or a tab introduces a value.
const SEP = String.raw`\s*(?:[=:]|%3D|%253D)\s*`;
const VALUE = String.raw`(?:(?<esc>\\*)(?<q>["'])[\s\S]*?(?:(?<!\\)\k<esc>\k<q>|$)|(?:(?!%26|%2526)[^&\s"'])+)`;
const STRONG_PAIR = new RegExp(String.raw`(?<key>${STRONG_KEYS})(?<sep>${SEP}|\s+)${VALUE}`, 'gi');
// "Authorization: <known scheme> <credential>": the scheme stays readable, the credential is masked.
const SCHEMES = String.raw`MediaBrowser|Emby|Bearer|Basic|Digest`;
const AUTH_SCHEME = new RegExp(String.raw`(?<head>authorization${SEP}(?:${SCHEMES})\s+)(?![\w-]+\s*=)(?:\\*["'])?[^\s,&"'\\]+`, 'gi');
const TOKEN_PAIR = new RegExp(String.raw`(?<key>token)(?<sep>${SEP}|\t+)${VALUE}`, 'gi');
// A scheme word followed by its parameters (MediaBrowser Token="...") or by a credential
// already masked stays readable; anything else after the key is masked.
const AUTH_PAIR = new RegExp(
  String.raw`(?<key>authorization)(?<sep>${SEP}|\t+)(?!(?:${SCHEMES})\s+(?:[\w-]+\s*=|\*\*\*))${VALUE}`,
  'gi',
);
const AUTH_KEYS = /(?<pre>(?:\/|%2F)Auth(?:\/|%2F)Keys(?:\/|%2F))(?:(?!%2F|%3F|%26)[^/\s"'?&])+/gi;

// IPTV (Xtream) addresses carry the account in the query or the path: get.php?username=U&password=P,
// /live/U/P/1.ts. Both are masked wherever an address reaches a line (an mpv error naming the stream).
const QUERY_ACCOUNT = /([?&](?:password|passwd|pwd|pass|username|user)=)[^&\s"'#]+/gi;
const XTREAM_PATH = /(\/(?:live|movie|series|timeshift)\/)[^/\s"'?#]+\/[^/\s"'?#]+\//gi;

type Groups = Record<string, string | undefined>;

function maskPair(...args: unknown[]): string {
  const g = args[args.length - 1] as Groups;
  const quote = g.q === undefined ? '' : `${g.esc ?? ''}${g.q}`;
  return `${g.key}${g.sep}${quote}***${quote}`;
}

export function redact(text: string): string {
  return text
    .replace(JSON_SECRET, (...args) => {
      const g = args[args.length - 1] as Groups;
      const esc = g.esc ?? '';
      return `${esc}"${g.key}${esc}":${esc}"***${esc}"`;
    })
    .replace(AUTH_KEYS, '$<pre>***')
    .replace(/(Bearer\s+)[^&\s"'\\]+/gi, '$1***')
    .replace(AUTH_SCHEME, '$<head>***')
    .replace(STRONG_PAIR, maskPair)
    .replace(TOKEN_PAIR, maskPair)
    .replace(AUTH_PAIR, maskPair)
    .replace(QUERY_ACCOUNT, '$1***')
    .replace(XTREAM_PATH, '$1***/***/');
}

export function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const logger = new Logger();
export type ScopedLog = ReturnType<Logger['scope']>;
