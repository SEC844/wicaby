// Mock admin: item metadata (editor, identify, artwork, refresh, remote
// subtitles, delete). Loaded by tools/mock-server/mock-emby.mjs. Everything lives in
// memory and edits the shared catalogue in place, so pages show the changes.
import { randomUUID } from 'node:crypto';

const palette = ['#5e5ce6', '#0a84ff', '#30d158', '#ff9f0a', '#ff375f', '#64d2ff', '#bf5af2', '#ffd60a'];
// Image bytes by tag: uploads, downloaded artwork, identify results.
const store = new Map();
let ready = false;

function authed(req, q, tokens) {
  const token = req.headers['x-emby-token'] ?? q.get('api_key') ?? /Token="([^"]+)"/.exec(String(req.headers['x-emby-authorization'] ?? ''))?.[1];
  return token && tokens.has(token);
}

async function raw(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 30 * 1024 * 1024) throw new Error('too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const newTag = () => randomUUID().replace(/-/g, '').slice(0, 12);

function art(label, type, seed, provider = '') {
  const c1 = palette[seed % palette.length];
  const c2 = palette[(seed + 3) % palette.length];
  const [W, H] = type === 'Primary' ? [400, 600] : type === 'Logo' || type === 'Banner' ? [900, 300] : type === 'Disc' ? [500, 500] : [960, 540];
  const text = String(label).replace(/[<&>"]/g, '').slice(0, 24);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${
    type === 'Logo'
      ? ''
      : `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="#0b0b0d"/></linearGradient><radialGradient id="r" cx="0.2" cy="0.1" r="0.9"><stop offset="0" stop-color="${c2}" stop-opacity="0.6"/><stop offset="1" stop-color="${c2}" stop-opacity="0"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><rect width="100%" height="100%" fill="url(#r)"/>`
  }<text x="${W * 0.08}" y="${H * 0.86}" font-family="Georgia, serif" font-weight="700" font-size="${Math.round(Math.min(W, H * 1.6) / 9)}" fill="#fff">${text}</text>${
    provider ? `<text x="${W * 0.08}" y="${H * 0.14}" font-family="Arial" font-size="${Math.round(W / 26)}" fill="#fff" fill-opacity="0.7">${provider}</text>` : ''
  }</svg>`;
  return svg;
}

const dataUrl = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

function init(items) {
  if (ready) return;
  ready = true;
  for (const it of items.values()) {
    if (['Movie', 'Episode', 'Series', 'Season', 'Book', 'Video', 'BoxSet', 'Playlist'].includes(it.Type)) it.CanDelete = true;
    if (it.Type === 'Movie' || it.Type === 'Series') {
      it.ProviderIds ??= { Imdb: `tt${String(1000000 + it.Id.length * 7919).slice(0, 7)}`, Tmdb: String(10000 + it.Id.charCodeAt(it.Id.length - 1)) };
      it.Tags ??= ['Démo'];
      it.LockedFields ??= [];
      it.LockData ??= false;
      it.Taglines ??= ['Une histoire de test.'];
      it.OriginalTitle ??= it.Name;
    }
  }
  const series = items.get('series-1');
  if (series) {
    series.Status ??= 'Continuing';
    series.AirDays ??= ['Tuesday'];
    series.AirTime ??= '21:00';
  }
}

const EDITABLE = [
  'Name', 'OriginalTitle', 'ForcedSortName', 'Taglines', 'Overview', 'ProductionYear', 'PremiereDate', 'EndDate', 'OfficialRating',
  'CommunityRating', 'CriticRating', 'Genres', 'Studios', 'Tags', 'People', 'ProviderIds', 'IndexNumber', 'ParentIndexNumber',
  'Status', 'AirDays', 'AirTime', 'LockData', 'LockedFields',
];

function imageList(it) {
  const out = [];
  for (const [type, tag] of Object.entries(it.ImageTags ?? {})) if (tag) out.push({ ImageType: type, ImageTag: tag, ImageIndex: 0, Width: type === 'Primary' ? 400 : 960, Height: type === 'Primary' ? 600 : 540, Size: 48_213 });
  (it.BackdropImageTags ?? []).forEach((tag, i) => out.push({ ImageType: 'Backdrop', ImageTag: tag, ImageIndex: i, Width: 1920, Height: 1080, Size: 212_000 }));
  return out;
}

function setImage(it, type, tag) {
  if (type === 'Backdrop') it.BackdropImageTags = [...(it.BackdropImageTags ?? []), tag];
  else it.ImageTags = { ...(it.ImageTags ?? {}), [type]: tag };
  if (type === 'Primary') delete it.ImageBlurHashes;
}

const PROVIDERS = ['TheMovieDb', 'FanArt', 'TheTVDB'];
const LANGS = ['fr', 'en', null, 'de'];

function remoteImages(it, q) {
  const type = q.get('Type') ?? q.get('type') ?? 'Primary';
  const provider = q.get('ProviderName') ?? q.get('providerName');
  const all = (q.get('IncludeAllLanguages') ?? q.get('includeAllLanguages')) === 'true';
  const out = [];
  for (let i = 0; i < 14; i++) {
    const ProviderName = PROVIDERS[i % PROVIDERS.length];
    const Language = LANGS[i % LANGS.length];
    if (provider && provider !== ProviderName) continue;
    if (!all && Language === 'de') continue;
    const svg = art(`${it.Name} ${i + 1}`, type, i + it.Id.length, ProviderName);
    const [Width, Height] = type === 'Primary' ? [1000, 1500] : type === 'Logo' || type === 'Banner' ? [1000, 185] : [3840, 2160];
    out.push({ ProviderName, Url: dataUrl(svg), Width, Height, CommunityRating: Math.round((9.5 - i * 0.4) * 10) / 10, VoteCount: 40 - i * 2, Language, Type: type, RatingType: 'Score' });
  }
  return { Images: out, TotalRecordCount: out.length, Providers: PROVIDERS };
}

function searchResults(type, info) {
  const name = info?.Name || 'Sans titre';
  const year = Number(info?.Year) || 2019;
  const base = [
    { Name: name, ProductionYear: year, prov: 'TheMovieDb', ov: `${name} : correspondance principale trouvée par le serveur de test.` },
    { Name: `${name} (version longue)`, ProductionYear: year, prov: 'TheMovieDb', ov: 'Montage alternatif, plus long de vingt minutes.' },
    { Name: `Le retour de ${name}`, ProductionYear: year + 3, prov: 'TheTVDB', ov: 'Suite directe, avec la même équipe.' },
    { Name: `${name}: Origins`, ProductionYear: year - 6, prov: 'TheMovieDb', ov: '' },
  ];
  return base.map((r, i) => ({
    Name: r.Name,
    ProductionYear: r.ProductionYear,
    PremiereDate: `${r.ProductionYear}-0${(i % 9) + 1}-12T00:00:00.0000000Z`,
    SearchProviderName: r.prov,
    Overview: r.ov,
    ProviderIds: { Imdb: info?.ProviderIds?.Imdb ?? `tt09${i}4512`, Tmdb: String(55100 + i) },
    ImageUrl: dataUrl(art(r.Name, 'Primary', i + 2, r.prov)),
    Type: type,
  }));
}

const CULTURES = [
  ['French', 'Français', 'fr', 'fre'],
  ['English', 'English', 'en', 'eng'],
  ['German', 'Deutsch', 'de', 'ger'],
  ['Spanish', 'Español', 'es', 'spa'],
  ['Italian', 'Italiano', 'it', 'ita'],
  ['Japanese', 'Japanese', 'ja', 'jpn'],
].map(([Name, DisplayName, TwoLetterISOLanguageName, ThreeLetterISOLanguageName]) => ({ Name, DisplayName, TwoLetterISOLanguageName, ThreeLetterISOLanguageName, ThreeLetterISOLanguageNames: [ThreeLetterISOLanguageName] }));

function subtitles(it, lang) {
  if (lang === 'jpn') return [];
  const n = it.Name.replace(/\s+/g, '.');
  return [
    { Id: `os-${lang}-1`, ProviderName: 'Open Subtitles', Name: `${n}.1080p.BluRay.x264`, Format: 'srt', Author: 'wika', CommunityRating: 8.7, DownloadCount: 1520, IsHashMatch: true, Language: lang, ThreeLetterISOLanguageName: lang, Comment: 'Synchro parfaite avec la version Blu-ray.' },
    { Id: `os-${lang}-2`, ProviderName: 'Open Subtitles', Name: `${n}.WEB-DL`, Format: 'srt', CommunityRating: 7.1, DownloadCount: 312, IsForced: true, Language: lang, ThreeLetterISOLanguageName: lang },
    { Id: `ad-${lang}-3`, ProviderName: 'Addic7ed', Name: `${n}.HDTV.SDH`, Format: 'ass', CommunityRating: 6.4, DownloadCount: 88, IsHearingImpaired: true, Language: lang, ThreeLetterISOLanguageName: lang },
  ];
}

export async function route(ctx) {
  const { req, res, p, parts, q, send, body, tokens, items } = ctx;
  const m = req.method;
  init(items);

  // Image bytes we hold (served without auth, like the server's image route).
  if (m === 'GET' && parts[0] === 'Items' && parts[2] === 'Images' && parts[3] && parts[3] !== 'Chapter') {
    const hit = store.get(q.get('tag') ?? '');
    if (!hit) return false;
    res.writeHead(200, { 'Content-Type': hit.mime, 'Content-Length': hit.data.length, 'Cache-Control': 'max-age=31536000' });
    res.end(hit.data);
    return true;
  }

  const ours =
    (parts[0] === 'Items' && (parts.length === 2 || ['Images', 'MetadataEditor', 'RemoteImages', 'Refresh', 'RemoteSearch', 'Delete'].includes(parts[2]) || parts[1] === 'RemoteSearch')) ||
    p === '/Localization/Cultures';
  if (!ours || (parts.length === 2 && parts[0] === 'Items' && m === 'GET')) return false;
  if (!authed(req, q, tokens)) {
    send(res, 401, 'Unauthorized', 'text/plain');
    return true;
  }

  if (p === '/Localization/Cultures') return send(res, 200, CULTURES), true;

  // Identify.
  if (parts[1] === 'RemoteSearch') {
    if (parts[2] === 'Apply' && m === 'POST') {
      const it = items.get(parts[3]);
      if (!it) return send(res, 404, 'Not found', 'text/plain'), true;
      const r = await body(req);
      if (r.Name) it.Name = r.Name;
      if (r.ProductionYear) it.ProductionYear = r.ProductionYear;
      if (r.PremiereDate) it.PremiereDate = r.PremiereDate;
      if (r.Overview) it.Overview = r.Overview;
      if (r.ProviderIds) it.ProviderIds = { ...it.ProviderIds, ...r.ProviderIds };
      if ((q.get('ReplaceAllImages') ?? q.get('replaceAllImages')) !== 'false' && typeof r.ImageUrl === 'string' && r.ImageUrl.startsWith('data:')) {
        const tag = newTag();
        store.set(tag, { mime: 'image/svg+xml', data: Buffer.from(r.ImageUrl.split(',')[1], 'base64') });
        setImage(it, 'Primary', tag);
      }
      return send(res, 204), true;
    }
    if (m === 'POST' && parts[2]) {
      const b = await body(req);
      return send(res, 200, searchResults(parts[2], b.SearchInfo)), true;
    }
    return false;
  }

  const id = parts[1];
  const it = items.get(id);
  if (!it) return send(res, 404, 'Not found', 'text/plain'), true;

  // Save (POST /Items/{id}: the full DTO).
  if (parts.length === 2 && m === 'POST') {
    const dto = await body(req);
    if (!dto || typeof dto.Name !== 'string') return send(res, 400, 'Invalid item', 'text/plain'), true;
    for (const k of EDITABLE) if (k in dto) dto[k] === null ? delete it[k] : (it[k] = dto[k]);
    if (Array.isArray(dto.Studios)) it.Studios = dto.Studios.map((s, i) => ({ Name: s.Name, Id: s.Id ?? `studio-${i}` }));
    console.log(`[metadata] saved ${id}: ${it.Name}`);
    return send(res, 204), true;
  }
  // Delete (DELETE /Items/{id} or POST /Items/{id}/Delete): the item and what it contains.
  if ((parts.length === 2 && m === 'DELETE') || (parts[2] === 'Delete' && m === 'POST')) {
    const doomed = [...items.values()].filter((x) => x.Id === id || x.SeriesId === id || x.SeasonId === id || x.ParentId === id).map((x) => x.Id);
    for (const k of doomed) items.delete(k);
    console.log(`[metadata] deleted ${doomed.join(', ')}`);
    return send(res, 204), true;
  }

  if (parts[2] === 'MetadataEditor') {
    return send(res, 200, {
      ParentalRatingOptions: ['Tous publics', '-10', '-12', '-16', '-18', 'G', 'PG', 'PG-13', 'R', 'NC-17', 'TV-MA'].map((Name, Value) => ({ Name, Value })),
      ExternalIdInfos: [
        { Name: 'IMDb', Key: 'Imdb', UrlFormatString: 'https://www.imdb.com/title/{0}' },
        { Name: 'TheMovieDb', Key: 'Tmdb', UrlFormatString: it.Type === 'Movie' ? 'https://www.themoviedb.org/movie/{0}' : 'https://www.themoviedb.org/tv/{0}' },
        { Name: 'TheTVDB', Key: 'Tvdb', UrlFormatString: 'https://thetvdb.com/?tab=series&id={0}' },
      ],
      Countries: [],
      Cultures: CULTURES,
    }), true;
  }

  if (parts[2] === 'Refresh' && m === 'POST') {
    console.log(`[metadata] refresh ${id} ${q.toString()}`);
    return send(res, 204), true;
  }

  // Remote subtitles: GET …/Subtitles/{lang}, POST …/Subtitles/{id} (X-03). MediaSourceId is not a declared
  // parameter on either server, so it is not required. MOCK_SUBS=none: no provider plugin (404 on search);
  // MOCK_SUB_POLICY=deny: the account lacks the right (403). Requests forwarded by mock-jellyfin.mjs get
  // Jellyfin's field names (Forced, HearingImpaired, MachineTranslated).
  if (parts[2] === 'RemoteSearch' && parts[3] === 'Subtitles' && parts[4]) {
    if (process.env.MOCK_SUB_POLICY === 'deny') return send(res, 403, 'Forbidden', 'text/plain'), true;
    if (m === 'GET') {
      if (process.env.MOCK_SUBS === 'none') return send(res, 404, 'No subtitle provider', 'text/plain'), true;
      const found = subtitles(it, decodeURIComponent(parts[4]));
      const jf = req.headers['x-mock-flavour'] === 'jellyfin';
      return send(res, 200, jf ? found.map(({ IsForced, IsHearingImpaired, ...r }, i) => ({ ...r, Forced: Boolean(IsForced), HearingImpaired: Boolean(IsHearingImpaired), AiTranslated: false, MachineTranslated: i === 2 })) : found), true;
    }
    if (m === 'POST') {
      const subId = decodeURIComponent(parts[4]);
      const lang = /^\w+-(\w+)-/.exec(subId)?.[1] ?? 'und';
      console.log(`[metadata] subtitle ${subId} -> ${id}`);
      const list = ctx.addedSubs?.get(id) ?? [];
      // Saved next to the file like the server does; downloading the same one again replaces it.
      const Path = `/media/${id}.${lang}.${subId}.srt`;
      if (ctx.addedSubs && !list.some((x) => x.Path === Path)) ctx.addedSubs.set(id, [...list, { Type: 'Subtitle', Codec: 'srt', Language: lang, DisplayTitle: `${CULTURES.find((c) => c.ThreeLetterISOLanguageName === lang)?.DisplayName ?? lang} (SRT)`, IsTextSubtitleStream: true, Path }]);
      return send(res, 204), true;
    }
  }

  // Artwork.
  if (parts[2] === 'RemoteImages') {
    if (parts[3] === 'Providers') return send(res, 200, PROVIDERS.map((Name) => ({ Name, SupportedImages: ['Primary', 'Backdrop', 'Logo', 'Thumb', 'Banner', 'Art', 'Disc'] }))), true;
    if (parts[3] === 'Download' && m === 'POST') {
      const type = q.get('Type') ?? q.get('type');
      const url = q.get('ImageUrl') ?? q.get('imageUrl') ?? '';
      if (!type || !url.startsWith('data:')) return send(res, 400, 'Bad image', 'text/plain'), true;
      const tag = newTag();
      store.set(tag, { mime: 'image/svg+xml', data: Buffer.from(url.split(',')[1], 'base64') });
      setImage(it, type, tag);
      return send(res, 204), true;
    }
    if (m === 'GET') return send(res, 200, remoteImages(it, q)), true;
  }
  if (parts[2] === 'Images') {
    const type = parts[3];
    if (!type && m === 'GET') return send(res, 200, imageList(it)), true;
    if (type && parts[5] === 'Index' && m === 'POST') {
      const from = Number(parts[4]);
      const to = Number(q.get('NewIndex') ?? q.get('newIndex'));
      const list = [...(it.BackdropImageTags ?? [])];
      if (type !== 'Backdrop' || !(from in list) || !(to in list)) return send(res, 400, 'Bad index', 'text/plain'), true;
      const [moved] = list.splice(from, 1);
      list.splice(to, 0, moved);
      it.BackdropImageTags = list;
      return send(res, 204), true;
    }
    if (type && (m === 'DELETE' || (m === 'POST' && parts[parts.length - 1] === 'Delete'))) {
      const index = Number(parts[4] ?? 0) || 0;
      if (type === 'Backdrop') it.BackdropImageTags = (it.BackdropImageTags ?? []).filter((_, i) => i !== index);
      else if (it.ImageTags) {
        const { [type]: _gone, ...rest } = it.ImageTags;
        it.ImageTags = rest;
      }
      return send(res, 204), true;
    }
    if (type && parts.length === 4 && m === 'POST') {
      const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim();
      if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) return send(res, 415, 'Unsupported image type', 'text/plain'), true;
      const text = (await raw(req)).toString('utf8').trim();
      const data = Buffer.from(text, 'base64');
      if (!data.length) return send(res, 400, 'Empty image', 'text/plain'), true;
      const tag = newTag();
      store.set(tag, { mime, data });
      setImage(it, type, tag);
      console.log(`[metadata] upload ${type} ${mime} ${data.length} B -> ${id}`);
      return send(res, 204), true;
    }
  }
  return false;
}
