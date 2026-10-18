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
}

interface Persisted {
  server: Server | null; // the primary server
  session: Session | null; // the signed-in account
  profiles: Session[]; // accounts this TV remembers, for "Who's watching?" (TP-10)
  onboarded: boolean;
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

export function signIn(session: Session): void {
  prefs.session = session;
  prefs.profiles = [session, ...prefs.profiles.filter((p) => !(p.server.id === session.server.id && p.userId === session.userId))];
  persist();
}

// Switch user keeps the profile (and its token) for the picker; sign out forgets it.
export function signOut(forget: boolean): void {
  const s = prefs.session;
  if (s && forget) prefs.profiles = prefs.profiles.filter((p) => !(p.server.id === s.server.id && p.userId === s.userId));
  prefs.session = null;
  persist();
}

export function apiFor(server: Server, session?: Session | null): Api {
  return new Api(server.address, server.kind, session?.token, session?.userId);
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
