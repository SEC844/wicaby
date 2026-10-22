// Servers and signed-in accounts, persisted on the TV (the Android app's Prefs: server, session, saved profiles).
import { Api, type ServerKind } from './api';
import { load, save } from './storage';

export interface Server {
  id: string;
  name: string;
  address: string;
  kind: ServerKind;
}

export interface Session {
  server: Server;
  userId: string;
  userName: string;
  token: string;
  // A saved profile's other servers (TP-06), back with it when it signs in again.
  extras?: Session[];
}

interface Persisted {
  server: Server | null; // the primary server
  session: Session | null; // the signed-in account
  profiles: Session[]; // accounts this TV remembers, for "Who's watching?" (TP-10)
  onboarded: boolean;
  // TP-06: the other servers signed in at once (one account each), merged into Home and Search.
  extras?: Session[];
}

export const prefs = $state<Persisted>(load<Persisted>('session', { server: null, session: null, profiles: [], onboarded: false }));

function persist(): void {
  save('session', $state.snapshot(prefs));
}

export function setServer(server: Server): void {
  prefs.server = server;
  prefs.onboarded = true;
  persist();
}

const same = (a: Session, b: Session) => a.server.id === b.server.id && a.userId === b.userId;

// The other servers belong to the profile signed in: each profile gets its own back, none inherits another's.
export function signIn(session: Session): void {
  const saved = prefs.profiles.find((p) => same(p, session));
  const { extras, ...account } = session;
  prefs.session = account;
  prefs.extras = extras ?? saved?.extras ?? [];
  prefs.profiles = [{ ...account, extras: prefs.extras }, ...prefs.profiles.filter((p) => !same(p, session))];
  persist();
}

// The signed-in profile's entry follows its other servers.
function keepExtras(): void {
  const s = prefs.session;
  if (s) prefs.profiles = prefs.profiles.map((p) => (same(p, s) ? { ...p, extras: prefs.extras ?? [] } : p));
  persist();
}

export function addExtra(session: Session): void {
  prefs.extras = [...(prefs.extras ?? []).filter((e) => e.server.id !== session.server.id), session];
  keepExtras();
}

// Not revoked on the server: the token may serve elsewhere (Android removeAccount).
export function removeExtra(serverId: string): void {
  prefs.extras = (prefs.extras ?? []).filter((e) => e.server.id !== serverId);
  keepExtras();
}

// Switch user keeps the profile (its token and its other servers) for the picker. Sign out revokes the token on the
// server (/Sessions/Logout) and forgets the profile with its other servers.
export function signOut(forget: boolean): void {
  const s = prefs.session;
  if (s && !forget) keepExtras();
  if (s && forget) {
    void apiFor(s.server, s).request('POST', '/Sessions/Logout').catch(() => {});
    prefs.profiles = prefs.profiles.filter((p) => !same(p, s));
  }
  prefs.session = null;
  prefs.extras = [];
  persist();
}

export function apiFor(server: Server, session?: Session | null): Api {
  const a = new Api(server.address, server.kind, session?.token, session?.userId);
  a.serverId = server.id;
  return a;
}

// The signed-in account's client; null while signed out.
let cached: { key: string; api: Api } | null = null;
export function api(): Api | null {
  const s = prefs.session;
  if (!s) return null;
  const key = `${s.server.id}/${s.userId}/${s.token}`;
  if (cached?.key !== key) cached = { key, api: apiFor(s.server, s) };
  return cached.api;
}

// Every signed-in server's client, the primary first (extras that duplicate it left out).
const extraCache = new Map<string, Api>();
export function apis(): Api[] {
  const main = api();
  if (!main) return [];
  const out = [main];
  for (const e of prefs.extras ?? []) {
    if (e.server.id === prefs.session?.server.id) continue;
    const key = `${e.server.id}/${e.userId}/${e.token}`;
    let a = extraCache.get(key);
    if (!a) extraCache.set(key, (a = apiFor(e.server, e)));
    out.push(a);
  }
  return out;
}

// The client of the server an item or route names; the primary when it names none (or one no longer signed in).
export function apiOf(serverId?: string | null): Api | null {
  const main = api();
  if (!serverId || serverId === prefs.session?.server.id) return main;
  const e = (prefs.extras ?? []).find((x) => x.server.id === serverId);
  return e ? (apis().find((a) => a.address === e.server.address && a.userId === e.userId) ?? main) : main;
}

export const isMulti = (): boolean => (prefs.extras ?? []).some((e) => e.server.id !== prefs.session?.server.id);

// A server's name by id, for the server badge on merged rows.
export function serverName(serverId?: string): string | undefined {
  if (!serverId) return undefined;
  if (serverId === prefs.session?.server.id) return prefs.session.server.name;
  return (prefs.extras ?? []).find((e) => e.server.id === serverId)?.server.name;
}
