<script lang="ts">
  import { kindLabel as sharedKindLabel } from '../../shared/server-caps';
  import FileSourceSheet from '../components/FileSourceSheet.svelte';
  import IptvSourceSheet from '../components/IptvSourceSheet.svelte';
  import { onMount, tick, untrack } from 'svelte';
  import { fade, fly, slide } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import type {
    DiscoveredServer,
    FileSourceInfo,
    IptvSourceInfo,
    MeshProvider,
    PlexAccount,
    PlexLinkPin,
    ServerInfo,
    ServerSession,
    SessionState,
    VpnPeer,
    VpnStatus,
  } from '../../shared/contract';
  import Icon from '../components/Icon.svelte';
  import Toggle from '../components/Toggle.svelte';
  import Sheet from '../components/Sheet.svelte';
  import Segmented from '../components/Segmented.svelte';
  import { shownVpn, vpnStateLabel } from '../components/ConnectionList.svelte';
  import { qrPath } from '../lib/qr';
  import VpnPanel from '../components/VpnPanel.svelte';
  import { w } from '../lib/bridge';
  import { plainHttpToPublic } from '../lib/address';
  import { web } from '../lib/platform';
  import { immich, watchImmichSources } from '../lib/photos/immich.svelte';
  import { fmt, t, tParts } from '../lib/i18n.svelte';
  import { navigate } from '../lib/router.svelte';
  import { errorMessage, onlineSessions, session, toast } from '../lib/stores.svelte';
  import { dur } from '../lib/motion';

  // The first-run setup (routes/welcome/Where.svelte) shows one part of this page at a time and takes the
  // server once it answers, instead of this page navigating: `section` picks the part, `onready` gets the server.
  let {
    section,
    onready,
    onbyaddress,
  }: {
    section?: 'lan' | 'vpn' | 'public';
    onready?: (server: ServerInfo, status: ServerSession['status']) => void;
    // VPN part: "Add by Address" when the network has no other device.
    onbyaddress?: () => void;
  } = $props();

  let embedEl = $state<HTMLDivElement>();
  let saved = $state<ServerInfo[]>([]);
  let files = $state<FileSourceInfo[]>([]);
  let iptv = $state<IptvSourceInfo[]>([]);
  let loaded = $state(false);
  // The skeleton only shows when the list takes longer than a blink.
  let slow = $state(false);
  let found = $state<DiscoveredServer[]>([]);
  let scanning = $state(false);
  let address = $state('');
  let busy = $state<string | null>(null);
  let unreachable = $state<ServerInfo | null>(null);
  let mode = $state<'address' | 'connect'>('address');
  let connectUser = $state('');
  let connectPass = $state('');
  // Inline under the field (sources spec §3.1): what went wrong with the form, never a toast.
  let formError = $state('');
  let howOpen = $state(false);
  // Plex (plex-spec §5.6): the linked accounts, and the code being linked.
  let plexAccounts = $state<PlexAccount[]>([]);
  let plexPin = $state<(PlexLinkPin & { expired?: boolean }) | null>(null);
  let plexTimer: ReturnType<typeof setTimeout> | undefined;
  // False once the page is gone: a poll or wake retry that resolves later does nothing.
  let alive = true;
  const plexQr = $derived(plexPin ? qrPath(plexPin.url) : null);
  // Hidden Plex servers stay stored (and listed in their account's sheet), out of the list.
  const shown = $derived(saved.filter((s) => !s.plex?.hidden));

  // The add sheet: a type picker, then one form at a time.
  type Step = 'pick' | 'server' | 'plex' | 'navidrome' | 'photos' | 'remote';
  let addOpen = $state(false);
  let step = $state<Step>('pick');
  let stepEl = $state<HTMLDivElement>();
  let fileSheet = $state<'files' | 'photos' | null>(null);
  let iptvSheet = $state(false);
  let plexSheet = $state<string | null>(null);
  // Every removal that loses something (progress, a link, a photo library) asks first, in one sheet.
  let confirming = $state<{ body: string; action: string; run: () => Promise<void> } | null>(null);
  let menuFor = $state<string | null>(null);
  let menuEl = $state<HTMLDivElement>();
  let vpn = $state<VpnStatus[]>([]);
  let peers = $state<VpnPeer[] | null>(null);

  // Already signed in somewhere: this page adds servers instead of choosing one.
  const signedIn = $derived(onlineSessions().length > 0);
  const stateOf = (id: string) => session.value.sessions.find((s) => s.server.id === id);


  async function connect(e: SubmitEvent) {
    e.preventDefault();
    if (!connectUser.trim() || !connectPass) {
      formError = t('sources.connect.required');
      return;
    }
    busy = 'connect';
    unreachable = null;
    formError = '';
    try {
      const servers = await w.servers.embyConnect(connectUser.trim(), connectPass);
      connectPass = '';
      await refreshSaved();
      if (servers.length === 0) {
        toast('info', t('onboarding.servers.connect.none'));
      } else if (servers.length === 1) {
        afterSelect(await w.servers.select(servers[0].id), servers[0]);
      } else {
        addOpen = false;
        toast('success', t('onboarding.servers.connect.added', { count: servers.length }));
      }
    } catch (err) {
      formError = errorMessage(err);
    } finally {
      busy = null;
    }
  }

  const fresh = $derived(found.filter((f) => !saved.some((s) => s.id === f.id)));

  async function refreshSaved() {
    try {
      [saved, plexAccounts, files, iptv] = await Promise.all([w.servers.list(), w.servers.plexAccounts(), w.files.list().catch(() => []), w.iptv.list().catch(() => [])]);
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      loaded = true;
    }
  }

  async function scan() {
    if (scanning) return;
    scanning = true;
    try {
      // Keep the searching state up long enough to read as a scan.
      const [list] = await Promise.all([w.servers.discover(), new Promise((r) => setTimeout(r, 1200))]);
      found = list;
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      scanning = false;
    }
  }

  // The aggregate state stays signed in while another server is; what matters is this server's session.
  function afterSelect(state: SessionState, server: ServerInfo) {
    const s = state.sessions.find((x) => x.server.id === server.id);
    if (onready) {
      if (s?.status === 'offline') toast('error', t('onboarding.servers.unreachable.title', { name: server.name }));
      else if (s) onready(server, s.status);
      return;
    }
    addOpen = false;
    if (s?.status === 'signed-in') navigate('/home', { replace: true });
    else if (s?.status === 'server-selected') navigate(`/login/${server.id}`, { replace: true });
    else if (s?.status === 'offline') {
      unreachable = s.server;
      void tick().then(() => document.querySelector<HTMLElement>(`[data-row="${CSS.escape(server.id)}"]`)?.focus());
    }
  }

  async function select(server: ServerInfo) {
    if (stateOf(server.id)?.status === 'signed-in') return navigate('/home');
    busy = server.id;
    unreachable = null;
    try {
      afterSelect(await w.servers.select(server.id), server);
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      busy = null;
      void refreshSaved();
    }
  }

  async function addAndSelect(input: string, key: string) {
    const value = input.trim();
    if (!value) return;
    busy = key;
    unreachable = null;
    formError = '';
    try {
      const server = await w.servers.add(value);
      await refreshSaved();
      afterSelect(await w.servers.select(server.id), server);
    } catch (err) {
      // The typed address: the error goes under its field.
      if (key === 'manual') formError = errorMessage(err);
      else toast('error', errorMessage(err));
    } finally {
      busy = null;
    }
  }

  function submitAddress(e: SubmitEvent) {
    e.preventDefault();
    if (!address.trim()) {
      formError = t('sources.address.required');
      (e.currentTarget as HTMLFormElement).querySelector('input')?.focus();
      return;
    }
    void addAndSelect(address, 'manual');
  }

  // Link with a code: the code and its QR code, then a poll every 2 s until plex.tv says it was entered.
  async function plexLink() {
    clearTimeout(plexTimer);
    busy = 'plex';
    try {
      plexPin = await w.servers.plexLink();
      plexTimer = setTimeout(plexPoll, 2000);
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      busy = null;
    }
  }

  async function plexPoll() {
    if (!plexPin || plexPin.expired) return;
    try {
      const r = await w.servers.plexPoll();
      if (!plexPin || !alive) return;
      if (r.status === 'waiting') plexTimer = setTimeout(plexPoll, 2000);
      else if (r.status === 'expired') plexPin = { ...plexPin, expired: true };
      else {
        plexPin = null;
        addOpen = false;
        toast('success', t('plex.link.linked', { count: r.servers.length }));
        await refreshSaved();
        // The account's own server first: on to who is watching (or the D-3 question).
        const first = r.servers.find((s) => s.plex?.owned) ?? r.servers[0];
        if (first && !signedIn) await select(first);
      }
    } catch (err) {
      plexPin = null;
      toast('error', errorMessage(err));
    }
  }

  function plexCancel() {
    clearTimeout(plexTimer);
    plexPin = null;
  }

  function plexUnlink(account: PlexAccount) {
    confirming = {
      body: t('sources.plex.unlinkConfirm', { name: account.name }),
      action: t('plex.account.unlink'),
      run: async () => {
        await w.servers.plexUnlink(account.id);
        plexSheet = null;
        await refreshSaved();
        toast('info', t('plex.account.unlinked'));
      },
    };
  }

  function immichRemove(s: { id: string; name: string }) {
    confirming = {
      body: t('sources.immich.removeConfirm', { name: s.name }),
      action: t('common.actions.remove'),
      run: async () => {
        await w.photos.immich.remove(s.id);
        toast('info', t('sources.immich.removed'));
      },
    };
  }

  async function plexShow(server: ServerInfo, show: boolean) {
    try {
      saved = await w.servers.plexSetHidden(server.id, !show);
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  async function remove(server: ServerInfo) {
    try {
      await w.servers.remove(server.id);
      if (unreachable?.id === server.id) unreachable = null;
      await refreshSaved();
      toast('info', t('onboarding.servers.toast.removed', { name: server.name }));
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  async function signOut(server: ServerInfo) {
    try {
      await w.session.logout(server.id);
      await refreshSaved();
      toast('info', t('onboarding.servers.toast.signedOut', { name: server.name }));
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  // A file source keeps playback progress: removing it asks first, as Settings › Library does.
  function removeFiles(f: FileSourceInfo) {
    confirming = {
      body: t('files.manage.removeConfirm', { name: f.name }),
      action: t('files.manage.remove'),
      run: async () => {
        await w.files.remove(f.id);
        await refreshSaved();
        toast('info', t('files.manage.removed'));
      },
    };
  }

  // An IPTV source keeps its favourites on this computer: removing it asks first.
  function removeIptv(s: IptvSourceInfo) {
    confirming = {
      body: t('iptv.manage.removeConfirm', { name: s.name }),
      action: t('common.actions.remove'),
      run: async () => {
        await w.iptv.remove(s.id);
        await refreshSaved();
        toast('info', t('iptv.manage.removed'));
      },
    };
  }

  async function refreshIptv(s: IptvSourceInfo) {
    try {
      const info = await w.iptv.refresh(s.id);
      toast('success', t('iptv.refreshed', { count: info.channels }));
    } catch (err) {
      toast('error', errorMessage(err));
    }
    await refreshSaved();
  }

  async function confirmRun() {
    const c = confirming;
    confirming = null;
    try {
      await c?.run();
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  const WAKE_RETRY_S = 15;

  async function wake(server: ServerInfo) {
    try {
      const sent = await w.servers.wake(server.id);
      if (!sent) {
        toast('info', t('onboarding.servers.toast.wakeNoAddress'));
        return;
      }
      toast('success', t('onboarding.servers.toast.wakeSent', { seconds: WAKE_RETRY_S }));
      setTimeout(() => alive && void select(server), WAKE_RETRY_S * 1000);
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  function since(ts?: number): string {
    if (!ts) return t('onboarding.servers.since.never');
    const min = Math.round((Date.now() - ts) / 60000);
    if (min < 1) return t('onboarding.servers.since.justNow');
    if (min < 60) return t('onboarding.servers.since.minutes', { count: min });
    const h = Math.round(min / 60);
    if (h < 48) return t('onboarding.servers.since.hours', { count: h });
    return t('onboarding.servers.since.days', { count: Math.round(h / 24) });
  }

  // Brand names (shared/server-caps.ts); a file source says "Files".
  const kindLabel = (kind: string) => sharedKindLabel(kind, t('files.kind'));
  const MESH: Record<MeshProvider, string> = { tailscale: 'Tailscale', netbird: 'NetBird' };
  const host = (url: string) => url.replace(/^https?:\/\//i, '').replace(/\/$/, '');

  // ---- One list for every source (sources spec §2.1) ----
  type Dot = 'ok' | 'idle' | 'warn' | 'bad';
  type MenuItem = { label: string; danger?: boolean; run: () => void };
  interface Row {
    key: string;
    name: string;
    detail: string;
    kind: string;
    dot: Dot;
    trail: 'check' | 'chevron' | 'spin';
    open: () => void;
    menu: MenuItem[];
    // Offline servers carry their fixes on the row.
    offline?: ServerInfo;
  }

  function serverRow(server: ServerInfo): Row {
    const s = stateOf(server.id);
    const via = server.vpn === 'netbird' ? 'NetBird' : server.vpn ? 'Tailscale' : '';
    const share = server.plex && !server.plex.owned ? (server.plex.source ? t('plex.account.sharedBy', { name: server.plex.source }) : t('plex.account.shared')) : '';
    let dot: Dot = 'idle';
    let state = [server.userName, since(server.lastConnected)].filter(Boolean).join(' · ');
    let trail: Row['trail'] = 'chevron';
    if (busy === server.id || s?.status === 'connecting') {
      [dot, state, trail] = ['warn', t('onboarding.servers.status.connecting'), 'spin'];
    } else if (s?.status === 'signed-in') {
      [dot, trail] = ['ok', 'check'];
      state = s.user ? t('sources.status.signedInAs', { user: s.user.name }) : t('onboarding.servers.status.connected');
    } else if (s?.status === 'offline' || unreachable?.id === server.id) {
      dot = 'bad';
      state = server.lastConnected ? t('sources.status.offlineSince', { since: since(server.lastConnected) }) : t('common.status.offline');
    } else if (s?.status === 'server-selected') {
      [dot, state] = ['warn', t('sources.status.needsLogin')];
    }
    const on = s?.status === 'signed-in';
    const account = server.plex && plexAccounts.find((a) => a.id === server.plex?.account);
    // Only the server just tried spreads its fixes on the row; any other offline one keeps them in its menu.
    const expanded = dot === 'bad' && unreachable?.id === server.id;
    return {
      key: server.id,
      name: server.name,
      detail: [share, state, via].filter(Boolean).join(' · '),
      kind: kindLabel(server.kind),
      dot,
      trail,
      open: () => void select(server),
      menu: [
        ...(on ? [{ label: t('onboarding.servers.row.signOut'), run: () => void signOut(server) }] : []),
        ...(dot === 'bad' && !expanded
          ? [...(server.kind !== 'plex' ? [{ label: t('onboarding.servers.unreachable.wake'), run: () => void wake(server) }] : []), { label: t('common.actions.retry'), run: () => void select(server) }]
          : []),
        ...(account ? [{ label: t('sources.plex.manage'), run: () => (plexSheet = account.id) }] : []),
        { label: t('common.actions.remove'), danger: true, run: () => void remove(server) },
        ...(account ? [{ label: t('sources.plex.unlink'), danger: true, run: () => plexUnlink(account) }] : []),
      ],
      offline: expanded ? server : undefined,
    };
  }

  // A Plex account only gets a row of its own when none of its servers is in the list (all hidden).
  function plexRow(account: PlexAccount): Row {
    const hidden = saved.filter((s) => s.plex?.account === account.id && s.plex.hidden).length;
    return {
      key: `plex:${account.id}`,
      name: 'Plex',
      detail: [account.name, hidden && t('sources.plex.hidden', { count: hidden })].filter(Boolean).join(' · '),
      kind: t('sources.plex.account'),
      dot: 'idle',
      trail: 'chevron',
      open: () => (plexSheet = account.id),
      menu: [{ label: t('sources.plex.unlink'), danger: true, run: () => plexUnlink(account) }],
    };
  }

  // Files, photo libraries and Settings are closed to the guard (App.svelte) until a server is signed in: until then
  // those rows open their menu instead of a page that would bounce back here.
  const leave = (key: string, path: string) => () => (signedIn ? navigate(path) : void openMenu(key));

  function filesRow(f: FileSourceInfo): Row {
    const key = `files:${f.id}`;
    const where = [f.protocol !== 'local' && t(`files.add.protocol.${f.protocol}`), f.http ? `http://${f.display}` : f.display];
    const state = f.status === 'offline' ? t('files.manage.offline') : f.status === 'pending' ? t('files.manage.pending') : t('onboarding.servers.status.connected');
    return {
      key,
      name: f.name,
      detail: [state, ...where].filter(Boolean).join(' · '),
      kind: f.photos ? t('photos.sources.section') : t('files.kind'),
      dot: f.status === 'offline' ? 'bad' : f.status === 'pending' ? 'warn' : 'ok',
      trail: 'chevron',
      // A photo source is its own photo library; a pending one connects from Settings › Library.
      open: leave(key, f.status === 'pending' ? '/settings?pane=sources' : f.photos ? `/library/${f.id}/p.` : `/files/${f.id}/p.`),
      menu: [{ label: t('common.actions.remove'), danger: true, run: () => removeFiles(f) }],
    };
  }

  function iptvRow(s: IptvSourceInfo): Row {
    const key = `iptv:${s.id}`;
    const state = s.state === 'loading' ? t('iptv.manage.loading') : s.state === 'error' ? t('iptv.manage.error') : t('iptv.manage.channels', { count: s.channels });
    const guide = s.guideError ? t('iptv.manage.guideError') : s.guide ? t('iptv.manage.guide', { host: s.guide }) : t('iptv.manage.noGuide');
    return {
      key,
      name: s.name,
      detail: [state, s.display, guide].filter(Boolean).join(' · '),
      kind: t('iptv.manage.kind'),
      dot: s.state === 'error' ? 'bad' : s.state === 'loading' || s.guideError ? 'warn' : 'ok',
      trail: 'chevron',
      open: leave(key, '/iptv?tab=now'),
      menu: [
        { label: t('iptv.manage.refresh'), run: () => void refreshIptv(s) },
        { label: t('common.actions.remove'), danger: true, run: () => removeIptv(s) },
      ],
    };
  }

  const isOn = (s: ServerInfo) => stateOf(s.id)?.status === 'signed-in';
  const rows = $derived<Row[]>([
    // The source in use comes first, as Spotify Connect and Wi-Fi pin the active one.
    ...[...shown].sort((a, b) => Number(isOn(b)) - Number(isOn(a))).map(serverRow),
    ...plexAccounts.filter((a) => !shown.some((s) => s.plex?.account === a.id)).map(plexRow),
    ...files.map(filesRow),
    ...iptv.map(iptvRow),
    ...immich.sources.map((s): Row => {
      const key = `immich:${s.id}`;
      // Immich names a server after its address: then the row says Immich and the address goes underneath.
      const named = s.name && s.name !== host(s.url);
      return {
        key,
        name: named ? s.name : 'Immich',
        detail: host(s.url),
        kind: named ? 'Immich' : t('photos.sources.section'),
        dot: 'idle',
        trail: 'chevron',
        open: leave(key, '/settings?pane=sources'),
        menu: [{ label: t('common.actions.remove'), danger: true, run: () => immichRemove(s) }],
      };
    }),
  ]);
  const empty = $derived(loaded && rows.length === 0);

  // ---- Row menu: right-click (also the Menu key and Shift+F10), or the … button ----
  async function openMenu(key: string, e?: Event) {
    e?.preventDefault();
    menuFor = key;
    await tick();
    menuEl?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }

  function closeMenu(refocus = true) {
    const key = menuFor;
    menuFor = null;
    if (refocus && key) document.querySelector<HTMLElement>(`[data-more="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
  }

  $effect(() => {
    if (!menuFor) return;
    const down = (e: PointerEvent) => !menuEl?.contains(e.target as Node) && closeMenu(false);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'BrowserBack' || e.key === 'Backspace') {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
      }
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  });

  // ---- Remote access: one status row ----
  const mesh = $derived(shownVpn(vpn).find((v) => v.state === 'connected') ?? shownVpn(vpn)[0]);
  const meshName = (v: VpnStatus) => MESH[v.kind === 'embedded' ? (v.provider ?? 'tailscale') : v.kind];
  const meshDevice = (v: VpnStatus) => (v.state === 'connected' ? (v.selfName ?? v.selfDnsName ?? '') : '');
  const connectedMesh = $derived(vpn.find((v) => v.state === 'connected'));
  const meshKind = $derived(connectedMesh?.kind);
  const plexAccount = $derived(plexAccounts.find((a) => a.id === plexSheet));

  // The remote step lists the mesh's devices, also when the mesh comes up while the step is open.
  $effect(() => {
    const kind = meshKind;
    if (!addOpen || step !== 'remote' || !kind) return;
    untrack(() => {
      peers = null;
      w.vpn.peers(kind).then(
        (list) => (peers = list),
        (err) => (toast('error', errorMessage(err)), (peers = [])),
      );
    });
  });

  // The remote row reads like a source row: a dot for the state, the error in words.
  const meshDot = (v?: VpnStatus): Dot =>
    !v ? 'idle' : v.state === 'connected' ? 'ok' : v.state === 'error' ? 'bad' : v.state === 'connecting' || v.state === 'needs-login' ? 'warn' : 'idle';

  async function loadVpn() {
    vpn = await w.vpn.status().catch(() => vpn);
  }

  // A mesh that is set up but down: one press brings it up (as VpnPanel's Connect does), then the server is tried again.
  const meshDown = $derived(vpn.find((v) => v.state !== 'not-installed' && v.state !== 'connected' && v.state !== 'connecting'));

  async function meshConnect(v: VpnStatus, server: ServerInfo) {
    try {
      const provider = v.provider ?? 'tailscale';
      const r = await w.vpn.connect(v.kind, v.kind === 'embedded' ? { provider, managementUrl: provider === 'netbird' ? (v.managementUrl ?? '') : undefined } : undefined);
      if (r.authUrl) toast('info', t('vpn.toast.finishInBrowser', { name: meshName(v) }));
      await loadVpn();
      if (r.status.state === 'connected') void select(server);
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  // ---- The add sheet ----
  async function goStep(next: Step) {
    step = next;
    formError = '';
    // The Plex step is the code: it is asked for on arrival, as the Apple TV and Plex apps show it straight away.
    if (next === 'plex' && !plexPin && busy !== 'plex') void plexLink();
    await tick();
    (stepEl?.querySelector<HTMLElement>('[data-autofocus]') ?? stepEl?.querySelector<HTMLElement>('button:not([disabled]), input'))?.focus({ preventScroll: true });
  }

  function openAdd(next: Step = 'pick') {
    if (next === 'pick' || !found.length) void scan();
    addOpen = true;
    void goStep(next);
  }

  function closeAdd() {
    addOpen = false;
    plexCancel();
    formError = '';
    step = 'pick';
  }

  function pickType(k: 'server' | 'plex' | 'navidrome' | 'files' | 'iptv' | 'photos' | 'remote') {
    // Navidrome: the address form (no Emby Connect); its sign-in is the user name and password form.
    if (k === 'navidrome') mode = 'address';
    if (k === 'files') openFiles('files');
    else if (k === 'iptv') {
      fileFrom = addOpen ? step : null;
      closeAdd();
      iptvSheet = true;
    }
    else if (addOpen) void goStep(k);
    else openAdd(k);
  }

  // The web TV app adds Emby and Jellyfin servers only (Plex, Navidrome, file, IPTV, photo and mesh sources need the desktop's main).
  const TYPES = web ? (['server'] as const) : (['server', 'plex', 'navidrome', 'files', 'iptv', 'photos', 'remote'] as const);
  const stepTitle = $derived(step === 'pick' ? t('sources.add.button') : t(`sources.add.types.${step}.title`));
  const stepBack = () => (plexCancel(), void goStep('pick'));
  // The file sheet replaces the add sheet; its back chevron reopens the add sheet where it was left.
  let fileFrom = $state<Step | null>(null);
  function openFiles(kind: 'files' | 'photos') {
    fileFrom = addOpen ? step : null;
    closeAdd();
    fileSheet = kind;
  }

  function done() {
    navigate('/home');
  }

  onMount(() => {
    // The connecting splash unmounts this page, so an offline result lands on a fresh instance.
    if (session.value.status === 'offline' && session.value.server && !signedIn) unreachable = session.value.server;
    void refreshSaved();
    if (section !== 'vpn' && section !== 'public') void scan();
    // Opened from a card: focus goes to the part's first control.
    if (section) void tick().then(() => embedEl?.querySelector<HTMLElement>(section === 'lan' ? 'input' : 'input, button')?.focus());
    const timer = setTimeout(() => (slow = true), 150);
    let off: (() => void) | undefined;
    if (!section) {
      watchImmichSources();
      void loadVpn();
      // The embedded node pushes its changes; installed clients are asked again when the window comes back.
      off = w.vpn.embedded?.onChange?.((st) => (vpn = [...vpn.filter((v) => v.kind !== 'embedded'), st]));
      window.addEventListener('focus', loadVpn);
    }
    // The Plex poll stops with the page.
    return () => {
      alive = false;
      clearTimeout(plexTimer);
      clearTimeout(timer);
      off?.();
      window.removeEventListener('focus', loadVpn);
    };
  });
</script>

<svelte:window
  onkeydown={(e) => {
    // Done from the keyboard: an open sheet or menu takes Escape first (both stop it in the capture phase).
    if (e.key === 'Escape' && !e.defaultPrevented && !section && signedIn && !menuFor) {
      e.preventDefault();
      done();
    }
  }}
/>

{#snippet nearby()}
  <section class="group">
    <div class="group-head">
      <h2 class="label">{t('onboarding.servers.nearby.title')}</h2>
      <span class="scan-state" aria-live="polite">
        {#if scanning}
          <span class="spinner small"></span>{t('onboarding.servers.nearby.searchingShort')}
        {:else if fresh.length === 0}
          {found.length > 0 ? t('onboarding.servers.nearby.allSaved') : t('sources.nearby.none')}
        {/if}
      </span>
      <button class="icon-btn" onclick={scan} disabled={scanning} aria-label={t('common.actions.refresh')} title={t('common.actions.refresh')}>
        <Icon name="refresh" size={15} />
      </button>
    </div>
    {#if fresh.length > 0}
      <ul class="list">
        {#each fresh as server, i (server.id)}
          <li class="reveal" style:--i={Math.min(i, 12)}>
            <button class="row" onclick={() => busy === null && addAndSelect(server.address, server.id)} aria-disabled={busy !== null}>
              <span class="meta">
                <span class="name">{server.name}</span>
                <span class="sub">{kindLabel(server.kind)} · <span class="mono">{server.address}</span></span>
              </span>
              {#if busy === server.id}
                <span class="spinner"></span>
              {:else}
                <span class="text-action">{t('common.actions.add')}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/snippet}

{#snippet methods()}
  <div class="method">
    {#if section !== 'lan' && step !== 'navidrome' && !web}
      <Segmented
        value={mode}
        options={[
          { value: 'address' as const, label: t('sources.address.segment') },
          { value: 'connect' as const, label: 'Emby Connect' },
        ]}
        onchange={(v) => ((mode = v), (formError = ''))}
        label={t('onboarding.servers.method.aria')}
      />
    {/if}

    {#if mode === 'address'}
      <form class="form" novalidate in:fly={{ x: -12, duration: dur('med'), easing: cubicOut }} onsubmit={submitAddress}>
        <label class="field-label" for="source-address">{t('onboarding.servers.method.address')}</label>
        <input
          id="source-address"
          class="field"
          placeholder={step === 'navidrome' ? 'http://…:4533' : section === 'public' ? t('welcome.where.public.placeholder') : t('onboarding.servers.address.placeholder')}
          bind:value={address}
          oninput={() => (formError = '')}
          spellcheck="false"
          autocomplete="off"
          aria-invalid={formError ? 'true' : undefined}
          aria-describedby={formError ? 'source-error' : undefined}
          data-autofocus
        />
        {#if formError}<p class="error" id="source-error" role="alert">{formError}</p>{/if}
        {#if section !== 'lan' && plainHttpToPublic(address)}
          <p class="caution" role="status"><Icon name="exclamation" size={14} /> {t('welcome.where.public.insecure')}</p>
        {/if}
        <button type="button" class="disclosure" aria-expanded={howOpen} aria-controls="source-how" onclick={() => (howOpen = !howOpen)}>
          <Icon name="info" size={14} />
          {t('sources.address.howTried')}
          <span class="chev" class:up={howOpen}><Icon name="chevronDown" size={13} /></span>
        </button>
        {#if howOpen}
          <p class="hint" id="source-how" transition:slide={{ duration: dur('fast'), easing: cubicOut }}>
            {#each tParts('onboarding.servers.address.hint') as part, i (i)}{#if part.slot === 'https'}<span class="mono">https://</span>{:else if part.slot === 'http'}<span class="mono">http://…:8096</span>{:else if part.slot === 'path'}<span class="mono">/emby</span>{:else}{part.text}{/if}{/each}
          </p>
        {/if}
        <!-- Back and the close button already leave the step: the primary stands alone. -->
        <div class="actions">
          <button class="btn primary" type="submit" disabled={busy !== null}>
            {#if busy === 'manual'}<span class="spinner on-accent"></span>{:else}{t('sources.address.submit')}{/if}
          </button>
        </div>
      </form>
    {:else}
      <form class="form" novalidate in:fly={{ x: 12, duration: dur('med'), easing: cubicOut }} onsubmit={connect}>
        <label class="field-label" for="connect-user">{t('onboarding.fields.username')}</label>
        <input
          id="connect-user"
          class="field"
          placeholder={t('onboarding.servers.connect.userPlaceholder')}
          bind:value={connectUser}
          oninput={() => (formError = '')}
          autocomplete="username"
          spellcheck="false"
          aria-invalid={formError ? 'true' : undefined}
          aria-describedby={formError ? 'source-error' : 'connect-hint'}
          data-autofocus
        />
        <label class="field-label" for="connect-pass">{t('onboarding.fields.password')}</label>
        <input id="connect-pass" class="field" type="password" bind:value={connectPass} oninput={() => (formError = '')} autocomplete="current-password" aria-invalid={formError ? 'true' : undefined} />
        {#if formError}<p class="error" id="source-error" role="alert">{formError}</p>{/if}
        <p class="hint" id="connect-hint">{t('onboarding.servers.connect.hint')}</p>
        <div class="actions">
          <button class="btn primary" type="submit" disabled={busy !== null}>
            {#if busy === 'connect'}<span class="spinner on-accent"></span>{:else}{t('onboarding.servers.connect.submit')}{/if}
          </button>
        </div>
      </form>
    {/if}
  </div>
{/snippet}

<!-- Step 1 of the add sheet, also the empty page's body: what is on this network, then every kind of source. -->
{#snippet picker()}
  {@render nearby()}
  <section class="group">
    <div class="group-head"><h2 class="label">{t('sources.add.orType')}</h2></div>
    <ul class="list">
      {#each TYPES as k (k)}
        <li>
          <button class="row type" onclick={() => pickType(k)} data-type={k}>
            <span class="meta">
              <span class="name">{t(`sources.add.types.${k}.title`)}</span>
              <span class="sub">{t(`sources.add.types.${k}.body`)}</span>
            </span>
            <span class="go"><Icon name="chevronRight" size={16} /></span>
          </button>
        </li>
      {/each}
    </ul>
  </section>
{/snippet}

{#if section}
  <div class="embed" bind:this={embedEl}>
    {#if section === 'lan'}
      {@render nearby()}
      {@render methods()}
    {:else if section === 'vpn'}
      <VpnPanel disabled={busy !== null} onpick={(a, k) => addAndSelect(a, k)} {onbyaddress} />
    {:else}
      {@render methods()}
    {/if}
  </div>
{:else}
  <div class="setup">
    <div class="column">
      {#if empty}
        <div class="first" in:fade={{ duration: dur('med') }}>
          <h1 class="title-1">{t('sources.empty.title')}</h1>
          <p class="blurb">{t('sources.empty.body')}</p>
          <div class="first-body">{@render picker()}</div>
        </div>
      {:else}
        <header class="head">
          <h1 class="large-title">{t('sources.title')}</h1>
          <div class="head-actions">
            {#if signedIn}<button class="btn" onclick={done}>{t('common.actions.done')}</button>{/if}
            <button class="btn primary" onclick={() => openAdd()}><Icon name="plus" size={16} stroke={2} /> {t('sources.add.button')}</button>
          </div>
        </header>
        <p class="blurb">{t('sources.blurb')}</p>

        {#if fresh.length > 0}
          <!-- The page still scans: what it finds surfaces here, one press from the add sheet. -->
          <button class="row found" onclick={() => openAdd()} transition:slide={{ duration: dur('fast'), easing: cubicOut }}>
            <span class="found-text">{t('sources.nearby.found', { count: fresh.length })}</span>
            <span class="text-action">{t('common.actions.add')}</span>
            <span class="go"><Icon name="chevronRight" size={16} /></span>
          </button>
        {/if}

        {#if !loaded}
          {#if slow}
            <ul class="list skel" aria-label={t('common.status.loading')} aria-busy="true">
              {#each [0, 1, 2] as i (i)}<li><span class="bar"></span></li>{/each}
            </ul>
          {/if}
        {:else}
          <ul class="list sources" aria-label={t('sources.title')}>
            {#each rows as r, i (r.key)}
              <li class="reveal" class:menu-open={menuFor === r.key} style:--i={Math.min(i, 12)}>
                <button
                  class="row"
                  data-row={r.key}
                  onclick={() => busy === null && r.open()}
                  oncontextmenu={(e) => openMenu(r.key, e)}
                  aria-disabled={busy !== null}
                  title={r.detail.length > 48 ? r.detail : undefined}
                >
                  <span class="dot {r.dot}" aria-hidden="true"></span>
                  <span class="meta">
                    <span class="name">{r.name}</span>
                    {#if r.detail}<span class="sub">{r.detail}</span>{/if}
                  </span>
                  <span class="kind">{r.kind}</span>
                  <span class="go">
                    {#if r.trail === 'spin'}<span class="spinner"></span>{:else}<Icon name={r.trail === 'check' ? 'check' : 'chevronRight'} size={16} stroke={r.trail === 'check' ? 2 : 1.5} />{/if}
                  </span>
                </button>
                <button
                  class="more"
                  data-more={r.key}
                  onclick={() => (menuFor === r.key ? closeMenu() : openMenu(r.key))}
                  aria-haspopup="menu"
                  aria-expanded={menuFor === r.key}
                  aria-label={t('sources.row.menuAria', { name: r.name })}
                  title={t('common.actions.more')}
                >
                  <Icon name="ellipsis" size={16} />
                </button>
                {#if menuFor === r.key}
                  <div
                    class="menu material"
                    role="menu"
                    bind:this={menuEl}
                    onfocusout={(e) => !menuEl?.contains(e.relatedTarget as Node) && (e.relatedTarget as HTMLElement | null)?.dataset.more !== r.key && closeMenu(false)}
                  >
                    {#each r.menu as m (m.label)}
                      <button role="menuitem" class:danger={m.danger} onclick={() => (closeMenu(), m.run())}>{m.label}</button>
                    {/each}
                  </div>
                {/if}
                {#if r.offline}
                  {@const server = r.offline}
                  <div class="fixes" transition:slide={{ duration: dur('fast'), easing: cubicOut }}>
                    {#if server.kind !== 'plex'}<button class="text-btn" onclick={() => wake(server)}>{t('onboarding.servers.unreachable.wake')}</button>{/if}
                    <button class="text-btn" onclick={() => select(server)}>{t('common.actions.retry')}</button>
                    {#if !web}<button class="text-btn" onclick={() => navigate('/downloads')}>{t('sources.offline.downloads')}</button>{/if}
                    {#if meshDown}
                      {@const down = meshDown}
                      <button class="text-btn" onclick={() => meshConnect(down, server)}>{t('sources.offline.connectMesh', { name: meshName(down) })}</button>
                    {/if}
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}

        <!-- Remote access: one row with the source rows' anatomy; it opens the add sheet's remote step, which works signed out too. -->
        {#if !web}
        <button class="row remote" onclick={() => openAdd('remote')} title={mesh?.state === 'error' ? (mesh.lastError?.message ?? mesh.error) : undefined}>
          <span class="dot {meshDot(mesh)}" aria-hidden="true"></span>
          <span class="meta">
            <span class="name">{t('sources.remote.row')}</span>
            {#if mesh && mesh.state !== 'not-installed'}
              {@const device = meshDevice(mesh)}
              <span class="sub remote-value">
                <span class="nowrap">{meshName(mesh)}</span>
                {#if device}
                  <span class="nowrap">&nbsp;·&nbsp;</span>
                  <span class="device-head">{device.slice(0, -6)}</span><span class="nowrap">{device.slice(-6)}</span>
                {/if}
              </span>
            {/if}
          </span>
          <span class="kind remote-state" class:bad={mesh?.state === 'error'}>{mesh ? vpnStateLabel(mesh) : t('shell.status.vpn.off')}</span>
          <span class="go"><Icon name="chevronRight" size={16} /></span>
        </button>
        {/if}
      {/if}
    </div>
  </div>

  <Sheet open={addOpen} onclose={closeAdd} onback={step !== 'pick' ? stepBack : undefined} label={stepTitle} width={560} align="top">
    <div class="sheet-body">
      <header class="sheet-head">
        {#if step !== 'pick'}
          <button class="icon-btn back" onclick={stepBack} aria-label={t('common.actions.back')} title={t('common.actions.back')}>
            <Icon name="chevronLeft" size={18} />
          </button>
        {/if}
        <h2 class="title-3">{stepTitle}</h2>
      </header>
      {#key step}
        <div class="step" bind:this={stepEl} in:fly={{ x: step === 'pick' ? -12 : 12, duration: dur('med'), easing: cubicOut }}>
          {#if step === 'pick'}
            {@render picker()}
          {:else if step === 'server' || step === 'navidrome'}
            {@render methods()}
          {:else if step === 'plex'}
            <p class="lead">{t('plex.link.body')}</p>
            {#if plexPin}
              <div class="plex-link" aria-live="polite">
                {#if plexQr}
                  <svg class="qr" viewBox="0 0 {plexQr.size} {plexQr.size}" role="img" aria-label={t('plex.link.qrAlt')} shape-rendering="crispEdges">
                    <rect width={plexQr.size} height={plexQr.size} fill="#fff" />
                    <path d={plexQr.d} fill="#000" />
                  </svg>
                {/if}
                <div class="plex-code">
                  <p>{t('plex.link.lead')}</p>
                  <strong class="code mono" class:dim={plexPin.expired}>{plexPin.code}</strong>
                  {#if plexPin.expired}
                    <p class="caution" role="status"><Icon name="exclamation" size={14} /> {t('plex.link.expired')}</p>
                  {:else}
                    <p class="waiting"><span class="spinner small"></span> {t('plex.link.waiting')}</p>
                  {/if}
                </div>
              </div>
              {#if plexPin.expired}
                <div class="actions"><button class="btn primary" onclick={plexLink} data-autofocus>{t('plex.link.newCode')}</button></div>
              {/if}
            {:else if busy === 'plex'}
              <p class="quiet"><span class="spinner small"></span> {t('common.status.loading')}</p>
            {:else}
              <!-- Only when asking for the code failed: ask again. -->
              <div class="actions">
                <button class="btn primary" onclick={plexLink} data-autofocus>{t('sources.add.plex.getCode')}</button>
              </div>
            {/if}
            <p class="caption legal">{t('plex.account.unofficial')}</p>
          {:else if step === 'photos'}
            <ul class="list">
              <li>
                <button class="row type" onclick={() => openFiles('photos')}>
                  <span class="meta"><span class="name">{t('sources.add.photos.folder.title')}</span><span class="sub">{t('sources.add.types.files.body')}</span></span>
                  <span class="go"><Icon name="chevronRight" size={16} /></span>
                </button>
              </li>
              <!-- Immich connects in Settings, which opens once a server is signed in (App.svelte's guard). -->
              {#if signedIn}
                <li>
                  <button class="row type" onclick={() => (closeAdd(), navigate('/settings?pane=sources'))}>
                    <span class="meta"><span class="name">Immich</span><span class="sub">{t('sources.add.photos.immich.body')}</span></span>
                    <span class="go"><Icon name="chevronRight" size={16} /></span>
                  </button>
                </li>
              {/if}
            </ul>
          {:else if step === 'remote'}
            {#if connectedMesh}
              <section class="group">
                <div class="group-head"><h2 class="label">{t('sources.add.remote.lead', { name: meshName(connectedMesh) })}</h2></div>
                {#if peers === null}
                  <p class="quiet"><span class="spinner small"></span> {t('vpn.peers.searching')}</p>
                {:else if peers.length === 0}
                  <p class="quiet">{t('vpn.peers.none')}</p>
                {:else}
                  <ul class="list">
                    {#each peers as peer (peer.name + (peer.ips[0] ?? ''))}
                      {@const server = peer.servers[0]}
                      <li>
                        <button
                          class="row"
                          disabled={!server}
                          aria-disabled={busy !== null}
                          onclick={() => server && busy === null && addAndSelect(server.address, `vpn:${server.id}`)}
                          title={server?.address}
                        >
                          <span class="meta">
                            <span class="name">{peer.name}</span>
                            <span class="sub">{server ? `${kindLabel(server.kind)} · ${server.name}` : peer.online ? t('vpn.peers.noServer', { ports: fmt.list(['8096', '8920']) }) : t('common.status.offline')}</span>
                          </span>
                          {#if !server}
                            <span class="text-action off">{t('sources.add.remote.unavailable')}</span>
                          {:else if busy === `vpn:${server.id}`}
                            <span class="spinner"></span>
                          {:else}
                            <span class="text-action">{t('common.actions.add')}</span>
                          {/if}
                        </button>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </section>
            {:else}
              <p class="lead">{t('sources.add.remote.off')}</p>
              <!-- Sign-in and installed clients right here, signed in or not; the advanced fields stay in Settings. -->
              <div class="mesh"><VpnPanel compact disabled={busy !== null} onpick={(a, k) => addAndSelect(a, k)} onconnected={() => void loadVpn()} /></div>
            {/if}
            {#if signedIn}
              <div class="actions">
                <button class="btn" onclick={() => (closeAdd(), navigate('/settings?pane=remote'))}>{t('sources.add.remote.settings')}</button>
              </div>
            {/if}
          {/if}
        </div>
      {/key}
    </div>
  </Sheet>

  <Sheet open={plexSheet !== null} onclose={() => (plexSheet = null)} label={plexAccount ? t('plex.account.linkedAs', { name: plexAccount.name }) : t('plex.link.title')} width={560}>
    {#if plexAccount}
      {@const account = plexAccount}
      <div class="sheet-body">
        <header class="sheet-head">
          <h2 class="title-3">{t('plex.account.linkedAs', { name: account.name })}</h2>
        </header>
        {#if account.pass}<p class="lead">{t('plex.account.passOn')}</p>{/if}
        <ul class="list">
          {#each saved.filter((s) => s.plex?.account === account.id) as server (server.id)}
            <li class="row static" data-plex-server={server.id}>
              <span class="meta">
                <span class="name">{server.name}</span>
                <span class="sub">{server.plex?.owned ? t('plex.account.owned') : server.plex?.source ? t('plex.account.sharedBy', { name: server.plex.source }) : t('plex.account.shared')}</span>
              </span>
              <Toggle checked={!server.plex?.hidden} label={t('plex.account.show', { name: server.name })} onchange={(v) => plexShow(server, v)} />
            </li>
          {/each}
        </ul>
        {#if !account.pass}<p class="hint">{t('plex.account.passOff')}</p>{/if}
        <div class="sheet-foot">
          <button class="text-btn danger" onclick={() => plexUnlink(account)}>{t('sources.plex.unlink')}</button>
          <p class="caption legal">{t('plex.account.unofficial')}</p>
        </div>
      </div>
    {/if}
  </Sheet>

  <Sheet open={confirming !== null} onclose={() => (confirming = null)} label={confirming?.action ?? ''} width={420}>
    {#if confirming}
      <div class="sheet-body">
        <p class="lead confirm">{confirming.body}</p>
        <div class="actions">
          <button class="btn" onclick={() => (confirming = null)} data-autofocus>{t('common.actions.cancel')}</button>
          <button class="btn danger" onclick={confirmRun}>{confirming.action}</button>
        </div>
      </div>
    {/if}
  </Sheet>

  <FileSourceSheet
    open={fileSheet !== null}
    photos={fileSheet === 'photos'}
    onclose={() => ((fileSheet = null), void refreshSaved())}
    onback={fileFrom ? () => fileFrom && openAdd(fileFrom) : undefined}
  />
  <IptvSourceSheet open={iptvSheet} onclose={() => ((iptvSheet = false), void refreshSaved())} onback={fileFrom ? () => fileFrom && openAdd(fileFrom) : undefined} />
{/if}

<style>
  /* ---- Page: one column on the canvas, no card ---- */
  .setup {
    view-transition-name: page;
    position: relative;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .column {
    width: min(640px, 100% - 48px);
    margin: 0 auto;
    padding: calc(var(--titlebar) + 40px) 0 48px;
  }
  /* Title and actions share one centre line; the blurb sits under both. */
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 4px;
  }
  .head .large-title {
    min-width: 0;
    margin: 0;
    letter-spacing: -0.03em;
  }
  .head-actions {
    display: flex;
    flex: none;
    gap: 8px;
  }
  .blurb {
    margin: 0 0 24px;
    font-size: var(--fs-callout);
    color: var(--label-2);
  }

  /* Empty first run: the add sheet's first step, on the page. */
  .first {
    padding-top: 8vh;
  }
  .first .title-1 {
    margin: 0;
  }
  .first .blurb {
    margin: 8px 0 0;
  }
  .first-body {
    display: flex;
    flex-direction: column;
    gap: 32px;
    margin-top: 48px;
  }

  /* ---- Lists: rows on the surface, hairlines inset to the text edge ---- */
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .list li {
    position: relative;
  }
  /* Every list bleeds 16 px past the column (or the sheet's padding): text, dots and hairlines keep its edges. */
  .list li + li::before {
    content: '';
    position: absolute;
    top: 0;
    left: 16px;
    right: 16px;
    height: 1px;
    background: var(--separator);
  }
  .sources,
  .skel,
  .first-body .list {
    margin-inline: -16px;
  }
  .sources li + li::before {
    left: 40px;
  }
  /* A row being hovered or focused hides the hairlines on both of its sides. */
  .list li:has(> .row:is(:hover, :focus-visible))::before,
  .list li:has(> .row:is(:hover, :focus-visible)) + li::before {
    opacity: 0;
  }
  .reveal {
    animation: rise var(--t-slow) var(--ease-out) both;
    animation-delay: calc(var(--i) * var(--t-stagger));
  }
  .row {
    display: flex;
    align-items: center;
    gap: 16px;
    width: 100%;
    min-height: 56px;
    padding: 12px 16px;
    border-radius: var(--r-sm);
    text-align: left;
    transition:
      transform var(--t-med) var(--spring);
  }
  .row:not(.static):hover {
    background: var(--fill-2);
  }
  /* Focus reads stronger than hover, for a pad or a remote across the room (no ring, per design.md). */
  .row:focus-visible {
    background: var(--fill-3);
  }
  .row:not(.static, :disabled, [aria-disabled='true']):active {
    transform: scale(0.98);
  }
  .row:disabled,
  .row[aria-disabled='true'] {
    cursor: default;
  }
  .row:disabled .name {
    color: var(--label-2);
  }
  .row.static {
    cursor: default;
  }
  .dot {
    width: 8px;
    height: 8px;
    flex: none;
    border-radius: 50%;
    background: var(--success);
  }
  .dot.idle {
    background: none;
    box-shadow: inset 0 0 0 1.5px var(--label-2);
  }
  .dot.warn {
    background: var(--warning);
  }
  .dot.bad {
    background: var(--danger);
  }
  .meta {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .name {
    font-size: var(--fs-headline);
    font-weight: 600;
    letter-spacing: -0.01em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    font-size: var(--fs-footnote);
    color: var(--label-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* "never connected" and other mid-sentence strings start the line. */
  .sub::first-letter {
    text-transform: uppercase;
  }
  .sub .mono {
    font-size: 11.5px;
  }
  .kind {
    flex: none;
    font-size: var(--fs-footnote);
    color: var(--label-2);
  }
  .go {
    display: grid;
    place-items: center;
    width: 24px;
    flex: none;
    color: var(--label-2);
    transition: opacity var(--t-fast) var(--ease);
  }
  .row:hover .go {
    color: var(--label);
  }
  .text-action {
    flex: none;
    font-size: var(--fs-callout);
    font-weight: 560;
    color: var(--label-2);
  }
  .row:hover .text-action,
  .row:focus-visible .text-action {
    color: var(--label);
  }
  .text-action.off,
  .row:hover .text-action.off {
    font-weight: 400;
    color: var(--label-3);
  }

  /* The … button takes the trailing glyph's place on hover or focus; always focusable for arrows and pads. */
  .more {
    position: absolute;
    top: 14px;
    right: 12px;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    color: var(--label-2);
    opacity: 0;
    transition:
      opacity var(--t-fast) var(--ease);
  }
  li:hover > .more,
  li:focus-within > .more,
  li.menu-open > .more {
    opacity: 1;
  }
  .sources li:is(:hover, :focus-within, .menu-open) > .row .go {
    opacity: 0;
  }
  .more:hover,
  .more:focus-visible,
  li.menu-open > .more {
    background: var(--fill-3);
    color: var(--label);
  }
  .menu {
    position: absolute;
    top: 46px;
    right: 8px;
    z-index: 20;
    min-width: 200px;
    padding: 6px;
    border-radius: var(--r-md);
    background: var(--material-thick);
    box-shadow:
      var(--shadow-2),
      inset 0 0 0 1px var(--hairline);
    transform-origin: top right;
    animation: pop var(--t-med) var(--ease-out) both;
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: translate3d(0, -4px, 0);
    }
  }
  .menu button {
    display: flex;
    align-items: center;
    width: 100%;
    height: 34px;
    padding: 0 12px;
    border-radius: var(--r-xs);
    text-align: left;
    font-size: var(--fs-callout);
    white-space: nowrap;
    color: var(--label);
  }
  .menu button:hover,
  .menu button:focus-visible {
    background: var(--fill-3);
  }
  .menu button.danger {
    color: var(--danger);
  }

  /* Offline: the fixes sit on the row, under its text. */
  .fixes {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: -4px 0 0;
    padding: 0 16px 14px 40px;
  }
  .fixes .text-btn {
    padding: 0 12px;
    border-radius: 999px;
    background: var(--fill-2);
    color: var(--label);
  }
  .fixes .text-btn:hover,
  .fixes .text-btn:focus-visible {
    background: var(--fill-3);
  }
  .text-btn {
    height: 28px;
    padding: 0 8px;
    border-radius: var(--r-xs);
    font-size: var(--fs-callout);
    font-weight: 560;
    color: var(--label-2);
  }
  .text-btn:hover,
  .text-btn:focus-visible {
    background: var(--fill-2);
    color: var(--label);
  }
  .text-btn.danger,
  .text-btn.danger:is(:hover, :focus-visible) {
    color: var(--danger);
  }

  .skel li {
    display: flex;
    align-items: center;
    height: 56px;
    padding: 0 16px 0 40px;
  }
  .bar {
    width: 60%;
    height: 12px;
    border-radius: var(--r-xs);
    background: var(--fill-1);
  }

  /* ---- Found on this network, and remote access: single rows on the list's edges ---- */
  .row.found,
  .row.remote {
    width: calc(100% + 32px);
    margin-inline: -16px;
  }
  .row.found {
    min-height: 44px;
    margin-bottom: 8px;
  }
  .found-text {
    flex: 1;
    min-width: 0;
    font-size: var(--fs-callout);
  }
  .row.remote {
    margin-top: 32px;
  }
  .remote-value {
    display: flex;
  }
  .nowrap {
    flex: none;
    white-space: pre;
  }
  .device-head {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .remote-state.bad {
    color: var(--danger);
  }

  /* ---- Groups (discovery, types) ---- */
  .group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .group-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 12px;
    min-height: 28px;
    padding: 0 4px 0 16px;
  }
  .label {
    flex: 1;
    margin: 0;
    font-size: var(--fs-footnote);
    font-weight: 600;
    color: var(--label-2);
  }
  .scan-state {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: var(--fs-footnote);
    color: var(--label-2);
  }
  .icon-btn {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    flex: none;
    border-radius: 50%;
    color: var(--label-2);
  }
  .icon-btn:hover,
  .icon-btn:focus-visible {
    background: var(--fill-2);
    color: var(--label);
  }
  .icon-btn:disabled {
    color: var(--label-3);
    background: none;
  }
  /* The refresh button's centre sits on the chevron column below it. */
  .group-head .icon-btn {
    margin-right: -2px;
  }
  .quiet {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    padding: 8px 16px;
    font-size: var(--fs-callout);
    color: var(--label-2);
  }

  /* ---- Sheets ---- */
  /* 13 px: the title row's centre meets the close button's (Sheet.svelte, 14 px + 30 / 2). */
  .sheet-body {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 13px 24px 24px;
  }
  .sheet-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 32px;
    padding-right: 40px;
  }
  .sheet-head .title-3 {
    margin: 0;
  }
  .back {
    margin-left: -8px;
    width: 32px;
    height: 32px;
  }
  .step {
    display: flex;
    flex-direction: column;
    gap: 24px;
  }
  /* In a sheet, row text lines up with the title; the hover fill reaches 8 px from the edge. */
  .sheet-body .list {
    margin: 0 -16px;
  }
  .sheet-body .group-head,
  .first-body .group-head {
    padding: 0;
  }
  .sheet-body .quiet {
    padding: 8px 0;
  }
  .lead {
    margin: 0;
    font-size: var(--fs-body);
    line-height: 1.5;
    color: var(--label-2);
  }
  .lead.confirm {
    padding-right: 32px;
    color: var(--label);
  }
  .sheet-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .sheet-foot .text-btn {
    flex: none;
    margin-left: -8px;
  }
  .sheet-foot .legal {
    text-align: right;
  }
  .legal {
    margin: 0;
    color: var(--label-2);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  /* VpnPanel's compact rows, laid flat on the sheet like the other lists (no inset card; the text on the sheet's edge). */
  .mesh :global(.rows) {
    background: none;
    box-shadow: none;
    border-radius: 0;
  }
  .mesh :global(.rows .row) {
    gap: 16px;
    min-height: 56px;
    padding: 12px 0;
  }
  .mesh :global(.rows .name) {
    font-size: var(--fs-headline);
  }
  .mesh :global(.rows .glyph) {
    display: none;
  }
  .actions .btn {
    min-width: 96px;
  }

  /* ---- Forms ---- */
  .embed {
    display: flex;
    flex-direction: column;
    gap: 24px;
  }
  .method {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .method > :global(.seg) {
    align-self: flex-start;
  }
  /* One accent per view: the chosen segment is neutral, the submit button keeps the accent. */
  .method :global(.seg .thumb) {
    background: var(--fill-3);
  }
  .method :global(.seg button.on) {
    color: var(--label);
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .field-label {
    font-size: var(--fs-footnote);
    font-weight: 600;
    color: var(--label-2);
  }
  .field-label:not(:first-child) {
    margin-top: 8px;
  }
  .field[aria-invalid='true'] {
    border-color: color-mix(in srgb, var(--danger) 60%, transparent);
  }
  .error {
    margin: 0;
    font-size: var(--fs-footnote);
    color: var(--danger);
  }
  .caution {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font-size: var(--fs-footnote);
    color: var(--warning);
  }
  .disclosure {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    gap: 6px;
    padding: 4px 0;
    font-size: var(--fs-footnote);
    color: var(--label-2);
  }
  .disclosure:hover,
  .disclosure:focus-visible {
    color: var(--label);
  }
  .chev {
    display: grid;
    transition: transform var(--t-med) var(--ease);
  }
  .chev.up {
    transform: rotate(180deg);
  }
  .hint {
    margin: 0;
    font-size: var(--fs-footnote);
    line-height: 1.5;
    color: var(--label-2);
  }
  .hint .mono {
    font-size: 11.5px;
    color: var(--label);
  }
  .form .actions {
    margin-top: 16px;
  }

  /* ---- Plex code ---- */
  .plex-link {
    display: flex;
    gap: 24px;
    align-items: center;
  }
  .qr {
    width: 148px;
    height: 148px;
    flex: none;
    border-radius: var(--r-md);
  }
  .plex-code {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
  .plex-code p {
    margin: 0;
    font-size: var(--fs-callout);
    line-height: 1.5;
    color: var(--label-2);
  }
  .code {
    font-size: 40px;
    font-weight: 700;
    letter-spacing: 0.18em;
  }
  .code.dim {
    opacity: 0.4;
  }
  .waiting {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .spinner {
    width: 18px;
    height: 18px;
    flex: none;
    border-radius: 50%;
    background: conic-gradient(from 90deg, transparent 10%, var(--label-2));
    mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px));
    /* Progress, not decoration: it keeps turning under reduced motion (times --tempo it would strobe). */
    animation: spin var(--t-spin) linear infinite;
  }
  .spinner.small {
    width: 12px;
    height: 12px;
  }
  .spinner.on-accent {
    background: conic-gradient(from 90deg, transparent 10%, var(--accent-fg));
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (max-width: 560px) {
    .kind {
      display: none;
    }
    .plex-link {
      flex-direction: column;
      align-items: flex-start;
    }
  }
</style>
