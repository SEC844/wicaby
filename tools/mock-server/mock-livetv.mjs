// IPTV-scale Live TV for the Emby and Jellyfin mocks (docs/specs/livetv-spec-final.md §17.2, work package MK-1).
//
// Enabled with MOCK_LIVETV=iptv. mock-emby.mjs sends every /emby request through route() before its own
// 30-channel Live TV block, and the /Mock/LiveTv/* control routes through control(). mock-jellyfin.mjs creates
// the module with flavour 'jellyfin' and forwards the few paths it does not already forward (claims()).
//
//   createLiveTv({flavour, seed, channels, days, tuners, now, env, host, emit, user})
//     -> {route, control, upgrade, claims, report, encodingsKilled, state, reset, m3u, generated}
//
// The lineup is fictional: 300 channels × 7 days by default (about 76,000 programmes; the 2-minute clip channel alone is about 5,400), generated from a
// mulberry32 seed in per-channel sorted arrays, so range queries are binary searches. No dependency.
//
// Environment (all optional): MOCK_LIVE_CHANNELS, MOCK_LIVE_DAYS, MOCK_LIVE_SEED, MOCK_LIVE_ANCHOR, MOCK_TUNERS,
// MOCK_LIVE_TUNE_MS, MOCK_LIVE_TUNE_JITTER_MS, MOCK_LIVE_LATE_MS, MOCK_LIVE_MODE, MOCK_LIVE_BUSY, MOCK_LIVE_FAIL,
// MOCK_LIVE_CATEGORY_IGNORED, MOCK_LIVE_FLAGLESS, MOCK_JF_PROGRAM_SEARCH, MOCK_DVR, MOCK_CAN_RECORD, MOCK_LATENCY_MS,
// MOCK_FAULTS, MOCK_JF_VERSION, MOCK_EMBY_ONNOW, MOCK_EMBY_HD, MOCK_CLOCK_SKEW_MIN, MOCK_LIVE_BITRATE,
// MOCK_LIVE_VIDEOS ("<channel number>=<file>;…": a video per channel, e.g. other cadences for DM-1; the rest get the host video).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MIN = 60_000;
const HOUR = 60 * MIN;
const TICKS_PER_MS = 10_000;

// ---------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------

export function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '.0000000Z');
const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];
const between = (lo, hi, rng, step = 1) => lo + Math.floor((rng() * (hi - lo + step)) / step) * step;
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Programme flag bits.
const F = { Movie: 1, Sports: 2, News: 4, Kids: 8, Series: 16, Live: 32, Premiere: 64, Repeat: 128, New: 256, HD: 512 };
const FLAG_KEYS = ['IsMovie', 'IsSports', 'IsNews', 'IsKids', 'IsSeries', 'IsLive', 'IsPremiere', 'IsRepeat', 'IsNew', 'IsHD'];
const FLAG_BITS = [F.Movie, F.Sports, F.News, F.Kids, F.Series, F.Live, F.Premiere, F.Repeat, F.New, F.HD];
const CATEGORY = { ismovie: F.Movie, issports: F.Sports, isnews: F.News, iskids: F.Kids, isseries: F.Series };

// ---------------------------------------------------------------------------------------------------------
// Fictional lineup data
// ---------------------------------------------------------------------------------------------------------

// tpl(name, minutes | [min, max], flags, genres, kind): kind 's' = series with episodes, 'm' = film slot.
const tpl = (name, dur, flags = 0, genres = [], kind) => ({ name, dur, flags, genres, kind });

const MOVIES = [
  ['Le Dernier Phare', 1987], ['Minuit sur la Lagune', 2019], ['Les Ombres du Quai', 1962], ['Cap au Nord', 2004],
  ['La Valse des Comètes', 2021], ['Trois Jours à Lisbonne', 2015], ['Le Secret du Moulin', 1974], ['Orage d’Été', 1999],
  ['La Ligne Bleue', 2011], ['Mission Altiplano', 2023], ['Le Train de 6 h 12', 1995], ['Rue des Lanternes', 1958],
  ['Les Héritiers du Vent', 2008], ['Nuit Blanche à Marseille', 2017], ['L’Horloger', 1981], ['Silence Radio', 2013],
  ['Le Grand Saut', 2020], ['Âme Sœur', 2002], ['Les Faussaires', 1969], ['Vertiges', 1990], ['L’Île aux Mouettes', 2016],
  ['Opération Cristal', 2024], ['La Dernière Séance de Juin', 1978], ['Retour à Valmorel', 2010], ['Le Gardien du Col', 2006],
  ['Pluie d’Étoiles', 2022], ['Les Cerfs-Volants', 1985], ['Code 1000', 2018], ['Le Pacte des Glaces', 2001], ['Été 85 bis', 2014],
].map(([name, year], i) => ({ name, year, genres: ['Film', ['Comédie', 'Drame', 'Policier', 'Aventure', 'Thriller', 'Romance'][i % 6]], rating: ['TP', '-10', '-12', '-16'][i % 4] }));

const EP_TITLES = ['Le Retour', 'Faux Départ', 'La Clé', 'Sous la Surface', 'Point de Non-Retour', 'Le Témoin', 'Marée Haute', 'L’Alibi', 'Double Jeu', 'La Promesse', 'Dernier Acte', 'Les Fondations', 'Le Pari', 'Contre-Courant', 'À Découvert', 'La Fugue'];

const NEWS = (name, dur, genres = ['Information']) => tpl(name, dur, F.News, genres);
const FILLER = tpl('Météo', 5, 0, ['Météo']);

// share: channels per 300. Grid groups replay a per-channel day grid from 06:00 (anchors in local hours);
// freeform groups walk the whole range with random durations.
const GROUPS = [
  {
    key: 'gen', tag: 'Généralistes', share: 30, grid: true,
    names: ['Horizon 1', 'Canal Lumière', 'Télé Rivage', 'Première Onde', 'Antenne Néva', 'Vision 2', 'Écran Libre', 'Cap Télé', 'Ondine', 'Hexa TV', 'Téléport 9', 'Altiplano', 'Méridien', 'Rose des Vents', 'Phare 3'],
    anchors: [[13, NEWS('Le 13 heures', 40)], [20, NEWS('Le 20 heures', 40)], [21.1, tpl('Film du soir', [95, 120], F.Movie, [], 'm')]],
    tpls: [
      tpl('Les Voisins du Port', 26, F.Series, ['Série', 'Comédie'], 's'), tpl('Brigade Lumière', 52, F.Series, ['Série', 'Policier'], 's'),
      tpl('Cap sur l’Été', 52, F.Series, ['Série', 'Drame'], 's'), tpl('Le Grand Quiz', 40, F.Series, ['Jeu'], 's'),
      tpl('Midi Pile', 26, 0, ['Magazine']), tpl('Vie Pratique', 26, 0, ['Magazine', 'Société']),
    ],
    night: tpl('Programmes de nuit', 30, 0, ['Divertissement']),
  },
  {
    key: 'info', tag: 'Info', share: 25, info: true,
    names: ['Info Continue', 'Le Fil 24', 'Dépêche TV', 'Agora Info', 'Éco Direct', 'Flash 360', 'Info Monde 2', 'Parlement Fictif', 'Météo Plus'],
    tpls: [NEWS('Le Journal', 30), NEWS('Flash Info', 5), tpl('Le Débat du Jour', 25, 0, ['Débat', 'Information']), tpl('L’Éco en Bref', 25, F.News, ['Économie', 'Information'])],
    night: NEWS('Le Journal de la Nuit', 30),
  },
  {
    key: 'sport', tag: 'Sport', share: 35, sport: true,
    names: ['Sport Arène', 'Tribune 1', 'Podium', 'Glisse TV', 'Ballon Rond', 'Échappée', 'Ring 4', 'Raquette+', 'Moteur 8', 'Olympe Sport'],
    tpls: [
      tpl('Football : Ligue des Ports', [95, 120], F.Sports, ['Sport', 'Football']), tpl('Rugby : Challenge de l’Ouest', [100, 120], F.Sports, ['Sport', 'Rugby']),
      tpl('Tennis : Open des Collines', [120, 240], F.Sports, ['Sport', 'Tennis']), tpl('Cyclisme : Tour des Volcans', [180, 240], F.Sports, ['Sport', 'Cyclisme']),
      tpl('Basket : Coupe des Docks', [90, 120], F.Sports, ['Sport', 'Basket-ball']), tpl('Handball : Trophée du Lac', [90, 110], F.Sports, ['Sport', 'Handball']),
      tpl('Sprint Auto : Grand Prix', [120, 150], F.Sports, ['Sport', 'Sports mécaniques']),
    ],
    filler: tpl('Le Mag du Sport', [30, 60], F.Sports, ['Sport', 'Magazine']),
  },
  {
    key: 'cine', tag: 'Cinéma', share: 35, cinema: true,
    names: ['Ciné Lumière', 'Grand Écran', 'Ciné Frayeur', 'Ciné Club 7', 'Pellicule', 'Ciné Tribu', 'Noir & Blanc', 'Ciné Étoile', 'Super 8', 'Cinémascope'],
    filler: tpl('Courts Métrages', [10, 20], 0, ['Court métrage']),
  },
  {
    key: 'series', tag: 'Séries', share: 35, grid: true,
    names: ['Séries Max', 'Épisode', 'Saison 2', 'Polaroïd Séries', 'Club Feuilletons', 'Feuilleton', 'Rebondir', 'Intrigue', 'Suspense 5'],
    anchors: [[13, NEWS('Le Flash de 13 h', 10)], [20, NEWS('Le Flash de 20 h', 10)]],
    tpls: [
      tpl('Rue des Oliviers', 26, F.Series, ['Série', 'Feuilleton'], 's'), tpl('Section 7', 52, F.Series, ['Série', 'Policier'], 's'),
      tpl('Les Gardiens du Phare', 52, F.Series, ['Série', 'Fantastique'], 's'), tpl('Hôpital Central', 52, F.Series, ['Série', 'Drame'], 's'),
      tpl('Duo d’Enquête', 52, F.Series, ['Série', 'Policier'], 's'), tpl('Sous le Même Toit', 26, F.Series, ['Série', 'Comédie'], 's'),
      tpl('Mémoires Vives', 52, F.Series, ['Série', 'Historique'], 's'),
    ],
    night: tpl('Nuit des Séries', 30, F.Series | F.Repeat, ['Série']),
  },
  {
    key: 'kids', tag: 'Jeunesse', share: 25, grid: true, offAir: 23,
    names: ['Kidou', 'Pirouette', 'Les Mômes', 'Cartoon Ville', 'Récré 3', 'Bambin', 'Zigzag', 'P’tit Loup'],
    tpls: [
      tpl('Les Petits Explorateurs', 11, F.Kids | F.Series, ['Jeunesse', 'Animation'], 's'), tpl('Robo et Pixel', 13, F.Kids | F.Series, ['Jeunesse', 'Animation'], 's'),
      tpl('La Forêt des Lucioles', 22, F.Kids | F.Series, ['Jeunesse', 'Animation'], 's'), tpl('Capitaine Nuage', 26, F.Kids | F.Series, ['Jeunesse', 'Aventure'], 's'),
      tpl('Mini Labo', 11, F.Kids | F.Series, ['Jeunesse', 'Éducatif'], 's'), tpl('Les Copains d’Abord', 24, F.Kids | F.Series, ['Jeunesse'], 's'),
    ],
  },
  {
    key: 'docu', tag: 'Documentaires', share: 30, grid: true,
    names: ['Planisphère Docu', 'Périple 2', 'Mémoire Vive', 'Nature & Vie', 'Exploria', 'Savoir+', 'Globe', 'Science Ouverte', 'Archives 20'],
    tpls: [
      tpl('Planète Bleue Profonde', 52, F.Series, ['Documentaire', 'Nature'], 's'), tpl('Les Routes du Sel', 52, F.Series, ['Documentaire', 'Voyage'], 's'),
      tpl('Archives du XXe siècle', 90, 0, ['Documentaire', 'Histoire']), tpl('Ingénieurs de l’Extrême', 52, F.Series, ['Documentaire', 'Sciences'], 's'),
      tpl('Volcans', 26, 0, ['Documentaire', 'Sciences']), tpl('Grands Chefs, Petits Plats', 26, F.Series, ['Documentaire', 'Cuisine'], 's'),
    ],
    night: tpl('Rediffusion documentaire', 52, F.Repeat, ['Documentaire']),
  },
  {
    key: 'music', tag: 'Musique', share: 20, grid: true,
    names: ['Musique Live', 'Clip 24', 'Jazz Bleu', 'Classique Or', 'Électro Nuit', 'Rap Hexa', 'Chanson+'],
    tpls: [tpl('Top Clips', 60, 0, ['Musique', 'Clips']), tpl('Live au Club', 90, 0, ['Musique', 'Concert']), tpl('Session Acoustique', 30, 0, ['Musique']), tpl('Nuit Électro', 120, 0, ['Musique', 'Électro'])],
    night: tpl('Clips de nuit', 60, 0, ['Musique', 'Clips']),
  },
  {
    key: 'region', tag: 'Régions', share: 30, grid: true,
    names: ['Alpes Télé', 'Bretagne Ouest', 'Côte Basque', 'Provence 13', 'Lyon Métropole', 'Normandie Vue', 'Corse Île', 'Alsace Rhin', 'Occitanie Sud', 'Loire Vallée', 'Auvergne Volcans', 'Picardie Nord'],
    anchors: [[12, NEWS('Journal régional', 30)], [19, NEWS('Journal régional du soir', 30)]],
    tpls: [tpl('Terroirs', 26, 0, ['Magazine', 'Gastronomie']), tpl('Balade en Région', 26, F.Series, ['Magazine', 'Découverte'], 's'), tpl('Le Marché du Coin', 26, 0, ['Magazine']), tpl('Débat local', 52, 0, ['Débat'])],
    night: tpl('Boucle régionale', 60, F.Repeat, ['Magazine']),
  },
  {
    key: 'intl', tag: 'International', share: 25, grid: true,
    names: ['World Desk', 'Euro 3', 'Atlantica', 'Nordic One', 'Sahel TV', 'Andes Vision', 'Pacific 24', 'Balkan Live', 'Orient Express TV'],
    tpls: [NEWS('World News', 30, ['Information', 'International']), tpl('Global Talk', 26, 0, ['Débat', 'International']), tpl('City Stories', 52, F.Series, ['Série', 'Drame'], 's'), tpl('Weekend Escape', 26, 0, ['Voyage'])],
    night: NEWS('World News Overnight', 30, ['Information', 'International']),
  },
  {
    key: 'radio', tag: 'Radio', share: 10, grid: true, radio: true,
    names: ['Radio Horizon', 'Onde Bleue FM', 'Radio Partition', 'Radio Swing Bleu', 'Info Radio 24', 'Radio Mômes', 'Radio Région Sud', 'Électro FM', 'Radio Sport Arène', 'Chanson Radio'],
    tpls: [tpl('La Matinale', 180, 0, ['Radio', 'Information']), tpl('Musique non-stop', 120, 0, ['Radio', 'Musique']), NEWS('Le Journal radio', 15, ['Radio', 'Information']), tpl('Libre Antenne', 60, 0, ['Radio', 'Société'])],
    night: tpl('Nuit musicale', 60, 0, ['Radio', 'Musique']),
  },
];
const SUFFIXES = ['', ' HD', ' +1', ' 2', ' Max', ' Plus', ' 3', ' Extra'];
const LONG_NAME = 'Info Continue Régionale des Vallées et des Hauts-Plateaux 24h'.slice(0, 60).padEnd(60, '·');

// Edge channels by lineup index for a 300-channel lineup; scaled for other sizes.
const EDGE = {
  noEpg: [27, 52, 88, 123, 158, 213, 233, 262, 270, 274, 279, 282, 284, 286, 288],
  gaps: [11, 33, 62, 97, 130, 190, 240, 250, 266, 276],
  twoMin: [220],
  long26h: [6],
  directOnly: [8, 9, 31, 57],
  opening: [10, 32, 58],
  favourites: [0, 1, 2, 4, 30, 55, 90, 290],
  longName: [42],
};

// Lineup numbers: 1–N with every 37th missing, sub-channels 13.1–13.4 / 40.1–40.3 / 202-1–202-3, "05",
// "42" twice, 3 above 1000, 8 without a number, radio in the 900s.
function lineupNumbers(n, radio) {
  const tv = n - radio;
  const special = tv >= 60;
  const plainCount = tv - (special ? 23 : 0);
  const out = [];
  const inline = { 5: ['05'], 42: ['42'], 13: ['13.1', '13.2', '13.3', '13.4'], 40: ['40.1', '40.2', '40.3'], 202: ['202-1', '202-2', '202-3'] };
  let extra = 0;
  for (let k = 1, plain = 0; plain < plainCount; k++) {
    if (k % 37 === 0) continue;
    out.push(String(k));
    plain++;
    if (special && inline[k]) (out.push(...inline[k]), (extra += inline[k].length));
  }
  // A small lineup stops before 202: top up the 12 inline specials it skipped.
  for (; special && extra < 12; extra++) out.push(String(5000 + extra));
  if (special) out.push('1001', '1002', '1500', ...Array(8).fill(undefined));
  for (let i = 0; i < radio; i++) out.push(String(901 + i));
  return out.slice(0, n);
}

function localAt(day0, d, hours) {
  const x = new Date(day0);
  x.setDate(x.getDate() + d);
  x.setHours(Math.floor(hours), Math.round((hours % 1) * 100), 0, 0);
  return x.getTime();
}

// ---------------------------------------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------------------------------------

export function generate({ seed = 42, channels = 300, days = 7, anchorMs = Date.now() } = {}) {
  const t0 = performance.now();
  const day0 = new Date(anchorMs);
  day0.setHours(0, 0, 0, 0);
  const dataStart = day0.getTime() - 6 * HOUR;
  const dataEnd = localAt(day0.getTime(), days, 0);
  const scale = (list) => new Set(list.map((i) => Math.floor((i * channels) / 300)).filter((i) => i < channels));
  const edge = Object.fromEntries(Object.entries(EDGE).map(([k, v]) => [k, scale(v)]));

  // Group sizes by share, radio last.
  const sizes = GROUPS.map((g) => Math.round((g.share * channels) / 300));
  let diff = channels - sizes.reduce((a, b) => a + b, 0);
  for (let i = 0; diff !== 0; i = (i + 1) % GROUPS.length) {
    if (diff > 0) (sizes[i]++, diff--);
    else if (sizes[i] > 0) (sizes[i]--, diff++);
  }
  const radioCount = sizes[GROUPS.length - 1];
  const numbers = lineupNumbers(channels, radioCount);

  // Day boundaries (local 06:00) shared by every grid channel.
  const bases = [];
  for (let d = -1; d <= days; d++) bases.push(localAt(day0.getTime(), d, 6));

  const lineup = [];
  const progs = [];
  let idx = 0;
  GROUPS.forEach((g, gi) => {
    for (let j = 0; j < sizes[gi]; j++, idx++) {
      const i = idx;
      const rng = mulberry32((seed * 0x9e3779b1) ^ Math.imul(i + 1, 0x85ebca6b));
      const name = edge.longName.has(i) ? LONG_NAME : `${g.names[j % g.names.length]}${SUFFIXES[Math.floor(j / g.names.length) % SUFFIXES.length]}${j >= g.names.length * SUFFIXES.length ? ` ${Math.floor(j / (g.names.length * SUFFIXES.length)) + 1}` : ''}`;
      const ch = {
        i,
        Id: `ltc-${String(i + 1).padStart(3, '0')}`,
        Name: name,
        Number: numbers[i],
        group: g,
        radio: !!g.radio,
        hd: !g.radio && i % 5 < 3,
        logo: i % 12 !== 3,
        dark: i % 7 === 5,
        mode: edge.directOnly.has(i) ? 'hdhr' : edge.opening.has(i) ? 'opening' : 'normal',
        noEpg: edge.noEpg.has(i),
        fav: edge.favourites.has(i),
        flagsAny: 0,
        maxDur: 0,
      };
      lineup.push(ch);
      const list = [];
      if (!ch.noEpg) {
        const hdBit = ch.hd ? F.HD : 0;
        const epCount = new Map();
        const push = (s, e, t, extra = 0, mv = -1) => {
          if (e <= s || e <= dataStart || s >= dataEnd) return;
          const prev = list[list.length - 1];
          // 1 % of programmes start 5 min before the previous one ends.
          if (prev && prev.e === s && e - s > 10 * MIN && prev.e - prev.s > 10 * MIN && rng() < 0.01) s -= 5 * MIN;
          let f = t.flags | extra | hdBit;
          let se = 0;
          let ep = 0;
          if (t.kind === 's') {
            ep = (epCount.get(t) ?? Math.floor(rng() * 20)) + 1;
            epCount.set(t, ep);
            se = 1 + (ep >> 4);
            const night = new Date(s).getHours() < 6;
            const r = rng();
            if (night || r < 0.3) f |= F.Repeat;
            else if (r < 0.55) f |= F.New;
          }
          list.push({ s, e, t, f, se, ep, mv });
        };
        if (edge.twoMin.has(i)) {
          for (let t = dataStart; t < dataEnd; t += 2 * MIN) push(t, t + 2 * MIN, tpl('Clip non-stop', 2, 0, ['Musique', 'Clips']));
        } else if (g.sport || g.cinema) {
          let t = Math.floor((dataStart - 4 * HOUR) / HOUR) * HOUR;
          while (t < dataEnd) {
            const night = new Date(t).getHours() < 6;
            if (g.sport) {
              const ev = rng() < 0.75 ? pick(g.tpls, rng) : g.filler;
              const dur = Array.isArray(ev.dur) ? between(ev.dur[0], ev.dur[1], rng, 5) : ev.dur;
              push(t, t + dur * MIN, ev, ev === g.filler ? 0 : night ? F.Repeat : F.Live);
              t += dur * MIN;
            } else if (rng() < 0.12) {
              const dur = between(g.filler.dur[0], g.filler.dur[1], rng, 5);
              push(t, t + dur * MIN, g.filler);
              t += dur * MIN;
            } else {
              const mv = Math.floor(rng() * MOVIES.length);
              const dur = between(85, 150, rng, 5);
              push(t, t + dur * MIN, MOVIE_TPL, (rng() < 0.03 ? F.Premiere : 0) | (night ? F.Repeat : 0), mv);
              t += dur * MIN;
            }
          }
        } else {
          const grid = buildGrid(g, rng);
          for (let d = 0; d < bases.length - 1; d++) {
            const base = bases[d];
            const next = bases[d + 1];
            let end = base;
            for (const slot of grid) {
              const s = base + slot.at * MIN;
              if (s >= next) break;
              const e = Math.min(s + slot.dur * MIN, next);
              const mv = slot.t.kind === 'm' ? Math.floor(rng() * MOVIES.length) : -1;
              push(s, e, slot.t.kind === 'm' ? MOVIE_TPL : slot.t, slot.t.kind === 'm' && rng() < 0.03 ? F.Premiere : 0, mv);
              end = e;
            }
            // A 25 h day (or a grid that stops early) is topped up with the night filler until the next 06:00.
            if (!g.offAir) for (let s = end; s < next; s += g.night.dur * MIN) push(s, Math.min(s + g.night.dur * MIN, next), g.night);
          }
        }
        if (edge.gaps.has(i)) {
          // 2–5 h overnight holes, from about 01:00 local.
          for (let d = 0; d <= days; d++) {
            const gs = localAt(day0.getTime(), d, 1) + Math.floor(rng() * 4) * 15 * MIN;
            const ge = gs + between(2, 5, rng) * HOUR;
            for (let k = list.length - 1; k >= 0; k--) {
              const p = list[k];
              if (p.e <= gs || p.s >= ge) continue;
              if (p.s < gs) p.e = gs;
              else list.splice(k, 1);
            }
          }
        }
        if (edge.long26h.has(i)) {
          const ls = localAt(day0.getTime(), 1, 20);
          const le = ls + 26 * HOUR;
          for (let k = list.length - 1; k >= 0; k--) {
            const p = list[k];
            if (p.e <= ls || p.s >= le) continue;
            if (p.s < ls) p.e = ls;
            else if (p.e > le) p.s = le;
            else list.splice(k, 1);
          }
          list.push({ s: ls, e: le, t: LONG_TPL, f: LONG_TPL.flags | (ch.hd ? F.HD : 0), se: 0, ep: 0, mv: -1 });
        }
        list.sort((a, b) => a.s - b.s);
      }
      for (const p of list) {
        ch.flagsAny |= p.f;
        if (p.e - p.s > ch.maxDur) ch.maxDur = p.e - p.s;
      }
      progs.push(list);
    }
  });
  const count = progs.reduce((a, l) => a + l.length, 0);
  return { lineup, progs, dataStart, dataEnd, day0: day0.getTime(), count, ms: performance.now() - t0, seed, days };
}
const MOVIE_TPL = tpl('', 0, F.Movie, [], 'm');
const LONG_TPL = tpl('Nuit Spéciale : 26 heures de solidarité', 26 * 60, F.Live, ['Divertissement', 'Événement']);

// One channel's day: slots from 06:00 (offsets in minutes), with fixed anchors and an optional off-air hour.
function buildGrid(g, rng) {
  const anchors = (g.anchors ?? []).map(([h, t]) => ({ at: Math.round((Math.floor(h) - 6) * 60 + (h % 1) * 100), t }));
  const endAt = g.offAir ? (g.offAir - 6) * 60 : 1440;
  const slots = [];
  let t = 0;
  while (t < endAt) {
    const a = anchors.find((x) => x.at >= t);
    if (a && a.at === t) {
      const dur = Array.isArray(a.t.dur) ? between(a.t.dur[0], a.t.dur[1], rng, 5) : a.t.dur;
      slots.push({ at: t, dur, t: a.t });
      t += dur;
      continue;
    }
    const night = t >= 18 * 60; // 00:00–06:00
    // Info: an hourly Journal (30) + Flash (5) + Débat or Éco (25); the night is half-hour journals.
    const k = slots.length % 3;
    let x = g.info ? (night ? g.night : k === 2 ? g.tpls[2 + (Math.floor(slots.length / 3) % 2)] : g.tpls[k]) : night && g.night ? g.night : pick(g.tpls, rng);
    let dur = Array.isArray(x.dur) ? between(x.dur[0], x.dur[1], rng, 5) : x.dur;
    if (a && t + dur > a.at) dur = a.at - t;
    if (t + dur > endAt) dur = endAt - t;
    if (dur < 10 && (Array.isArray(x.dur) ? x.dur[0] : x.dur) >= 10) x = FILLER;
    slots.push({ at: t, dur, t: x });
    t += dur;
  }
  return slots;
}

// First index whose start is >= ms.
function lowerStart(list, ms) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].s < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Programmes of one channel overlapping [minEnd, maxStart): binary search bounded by the channel's longest programme.
export function range(ch, list, minEnd, maxStart) {
  const from = lowerStart(list, minEnd - ch.maxDur);
  const to = lowerStart(list, maxStart);
  const out = [];
  for (let k = from; k < to; k++) if (list[k].e > minEnd) out.push(list[k]);
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------------------------------------

export function createLiveTv(opts = {}) {
  const env = opts.env ?? process.env;
  const host = opts.host ?? {};
  const flavour = opts.flavour ?? 'emby';
  const emby = flavour === 'emby';
  const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
  const cfg = {
    channels: opts.channels ?? num(env.MOCK_LIVE_CHANNELS, 300),
    days: opts.days ?? num(env.MOCK_LIVE_DAYS, 7),
    seed: opts.seed ?? num(env.MOCK_LIVE_SEED, 42),
    tuners: opts.tuners ?? num(env.MOCK_TUNERS, 2),
    tuneMs: num(env.MOCK_LIVE_TUNE_MS, 300),
    jitterMs: num(env.MOCK_LIVE_TUNE_JITTER_MS, 0),
    lateMs: num(env.MOCK_LIVE_LATE_MS, 15_000),
    mode: env.MOCK_LIVE_MODE ?? 'mixed',
    busy: env.MOCK_LIVE_BUSY ?? 'http500',
    fail: new Set((env.MOCK_LIVE_FAIL ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
    categoryIgnored: env.MOCK_LIVE_CATEGORY_IGNORED === '1',
    flagless: env.MOCK_LIVE_FLAGLESS === '1',
    jfProgramSearch: env.MOCK_JF_PROGRAM_SEARCH !== '0',
    dvr: env.MOCK_DVR ?? '',
    canRecord: env.MOCK_CAN_RECORD !== '0',
    latencyMs: num(env.MOCK_LATENCY_MS, 0),
    faults: (env.MOCK_FAULTS ?? '').split(',').filter(Boolean).map((f) => {
      const [key, status, p] = f.split(':');
      return { key: key.toLowerCase(), status: Number(status) || 500, p: Number(p) || 0 };
    }),
    jfVersion: opts.jfVersion ?? env.MOCK_JF_VERSION ?? '12.2',
    embyOnNow: env.MOCK_EMBY_ONNOW ?? 'honour',
    embyHd: env.MOCK_EMBY_HD !== '0',
    skewMin: num(env.MOCK_CLOCK_SKEW_MIN, 0),
    bitrate: num(env.MOCK_LIVE_BITRATE, 0),
  };
  const anchorMs = env.MOCK_LIVE_ANCHOR ? Date.parse(env.MOCK_LIVE_ANCHOR) : typeof opts.now === 'number' ? opts.now : Date.now();
  const realNow = typeof opts.now === 'function' ? opts.now : typeof opts.now === 'number' ? () => opts.now : Date.now;
  let clockOffsetMin = 0;
  const now = () => realNow() + (cfg.skewMin + clockOffsetMin) * MIN;
  const uid = () => crypto.randomUUID().replace(/-/g, '');
  const ud = host.ud ?? ((id) => (udFallback.get(id) ?? udFallback.set(id, { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false }).get(id)));
  const udFallback = new Map();
  const serverId = host.serverId ?? 'mock-livetv';
  const video = host.video ?? null;
  const videoExt = video ? path.extname(video).slice(1).toLowerCase() || 'mkv' : 'ts';
  const videos = new Map((env.MOCK_LIVE_VIDEOS ?? '').split(';').map((kv) => kv.split('=').map((x) => x.trim())).filter((kv) => kv.length === 2 && kv[0] && kv[1]));
  const log = (...a) => console.log('LIVETV', ...a);

  let seed = cfg.seed;
  let g;
  let byId;
  const regenerate = () => {
    g = generate({ seed, channels: cfg.channels, days: cfg.days, anchorMs });
    byId = new Map(g.lineup.map((c) => [c.Id, c]));
    log(`${flavour}: ${g.lineup.length} channels, ${g.count} programmes over ${cfg.days} days generated in ${g.ms.toFixed(0)} ms (seed ${seed})`);
  };
  regenerate();
  for (const ch of g.lineup) if (ch.fav) ud(ch.Id).IsFavorite = true;
  if (opts.user) {
    opts.user.Policy = { ...opts.user.Policy, EnableLiveTvAccess: true, EnableLiveTvManagement: cfg.canRecord };
  }

  // ---- State ----
  const streams = new Map(); // id -> {id, channelId, playSessionId, openedAt, consumers, transcoding, maxBitrate}
  const released = new Map(); // id -> 'close' | 'stop'
  const conns = new Set(); // live stream HTTP connections {res, lsid, stall()}
  const sockets = new Set(); // Emby /embywebsocket clients
  const prefs = new Map();
  const timers = new Map();
  const seriesTimers = new Map();
  const recordings = new Map();
  const faultQueue = { pbi500: 0, pbiSlow: 0, closeBody400: 0, programs500: 0, streamStall: 0 };
  const faultRng = mulberry32(cfg.seed + 7);
  let st;
  let seq = 0;
  const resetState = () => {
    st = {
      closes: 0, stopReleases: 0, doubleReleases: 0, busyRejects: 0, lateAnswers: 0, encodingsKilled: 0, encodingsKillAttempts: 0,
      maxConcurrent: 0, opens: 0, openIdsInQuery: 0, openIdsInBody: 0, closeRejects: 0, closeWithBody: 0, closeUnknown: 0,
      missingBitrate: 0, stopsWithoutPlaySessionId: 0, clientEmby: 0, prefsWrites: 0, lastPrefsPost: null,
      programQueries: 0, maxProgramIds: 0, maxProgramUrl: 0, lastProgramQuery: null,
      streamsServed: 0, streamsWithoutLiveStreamId: 0, streamsUnknown: 0,
      requests: {}, reports: [], emitted: [],
    };
  };
  resetState();

  // ---- DVR seed: a Completed timer (Emby only), two one-offs, a series rule with a Cancelled tombstone; 12 recordings ----
  const findProgram = (pred, from = now()) => {
    for (const ch of g.lineup) {
      const list = g.progs[ch.i];
      for (let k = lowerStart(list, from); k < list.length; k++) if (pred(list[k], ch)) return { p: list[k], ch };
    }
    return null;
  };
  function seedDvr() {
    timers.clear();
    seriesTimers.clear();
    for (const id of recordings.keys()) host.items?.delete(id);
    recordings.clear();
    const t = now();
    const movie = findProgram((p) => p.t === MOVIE_TPL && p.s > t + 2 * HOUR);
    if (movie) addTimer(movie.p, movie.ch, {});
    const sport = findProgram((p, ch) => ch.group.key === 'sport' && p.f & F.Live && p.s > t + 3 * HOUR);
    if (sport) addTimer(sport.p, sport.ch, { PrePaddingSeconds: 120, PostPaddingSeconds: 600 });
    const past = findProgram((p) => p.t.kind === 's', t - 30 * HOUR);
    if (past && past.p.e < t) addTimer(past.p, past.ch, {}).completed = true;
    const ser = findProgram((p, ch) => ch.group.key === 'series' && p.t.kind === 's' && p.s > t + HOUR);
    if (ser) {
      const rule = addSeriesTimer(ser.p, ser.ch, { RecordNewOnly: false });
      const child = [...timers.values()].find((x) => x.SeriesTimerId === rule.Id);
      if (child) child.cancelled = true;
    }
    for (let k = 0; k < 12; k++) {
      const ch = g.lineup[(k * 23 + 5) % g.lineup.length];
      const inProgress = k === 0;
      const s = inProgress ? t - 20 * MIN : t - (k + 1) * 26 * HOUR;
      const e = inProgress ? t + 40 * MIN : s + (30 + (k % 4) * 30) * MIN;
      const kind = ['Movie', 'Series', 'Sports', 'Kids', 'News'][k % 5];
      const name = kind === 'Movie' ? MOVIES[k].name : kind === 'Series' ? 'Section 7' : kind === 'Sports' ? 'Rugby : Challenge de l’Ouest' : kind === 'Kids' ? 'Capitaine Nuage' : 'Le 20 heures';
      const item = {
        Id: `ltr-${String(k + 1).padStart(2, '0')}`,
        Name: name,
        Type: 'Recording',
        MediaType: 'Video',
        ChannelId: ch.Id,
        ChannelName: ch.Name,
        StartDate: iso(s),
        EndDate: iso(e),
        RunTimeTicks: (e - s) * TICKS_PER_MS,
        DateCreated: iso(s),
        Status: inProgress ? 'InProgress' : 'Completed',
        [`Is${kind}`]: true,
        IsSeries: kind === 'Series' || kind === 'Kids' || undefined,
        EpisodeTitle: kind === 'Series' ? EP_TITLES[k] : undefined,
        ParentIndexNumber: kind === 'Series' ? 2 : undefined,
        IndexNumber: kind === 'Series' ? k + 1 : undefined,
        SeriesName: kind === 'Series' ? name : undefined,
        Genres: kind === 'Movie' ? MOVIES[k].genres : ['Enregistrement'],
        Overview: `${name} : enregistrement fictif du serveur de test.`,
        ImageTags: { Primary: 'rp' },
      };
      recordings.set(item.Id, item);
      host.items?.set(item.Id, item);
    }
  }

  // ---- DTOs ----
  const progName = (p) => (p.mv >= 0 ? MOVIES[p.mv].name : p.t.name);
  const progId = (ch, p) => `p-${ch.Id}-${Math.floor(p.s / MIN)}`;
  const seriesId = (ch, p) => (p.t.kind === 's' ? `lts-${ch.group.key}-${fold(p.t.name).replace(/[^a-z0-9]+/g, '-')}` : undefined);
  function parseProgId(id) {
    const m = /^p-(ltc-\d+)-(\d+)$/.exec(id ?? '');
    if (!m) return null;
    const ch = byId.get(m[1]);
    if (!ch) return null;
    const list = g.progs[ch.i];
    const k = lowerStart(list, Number(m[2]) * MIN);
    return list[k]?.s === Number(m[2]) * MIN ? { ch, p: list[k] } : null;
  }
  const timerFor = (pid) => [...timers.values()].find((x) => x.ProgramId === pid && !x.cancelled);

  function progDto(ch, p, o = {}) {
    const pid = progId(ch, p);
    const out = {
      Id: pid,
      ServerId: serverId,
      Name: progName(p),
      Type: 'Program',
      MediaType: ch.radio ? 'Audio' : 'Video',
      IsFolder: false,
      ChannelId: ch.Id,
      ChannelName: ch.Name,
      StartDate: iso(p.s),
      EndDate: iso(p.e),
      RunTimeTicks: (p.e - p.s) * TICKS_PER_MS,
    };
    if (!cfg.flagless) {
      FLAG_KEYS.forEach((k, b) => {
        if (k === 'IsNew' && !emby) return;
        if (k === 'IsHD' && emby && !cfg.embyHd) return;
        const on = !!(p.f & FLAG_BITS[b]);
        // Emby sends only the flags that are set; Jellyfin sends every flag it knows.
        if (on || !emby) out[k] = on;
      });
    }
    if (p.t.kind === 's') {
      out.EpisodeTitle = EP_TITLES[p.ep % EP_TITLES.length];
      out.ParentIndexNumber = p.se;
      out.IndexNumber = p.ep;
      out.SeriesId = seriesId(ch, p);
      out.SeriesName = p.t.name;
    }
    if (p.mv >= 0) {
      out.ProductionYear = MOVIES[p.mv].year;
      out.OfficialRating = MOVIES[p.mv].rating;
    }
    if (o.images !== false && (p.mv >= 0 || p.t.kind === 's')) out.ImageTags = { Primary: 'pp' };
    else if (o.images !== false) out.ImageTags = {};
    const genres = p.mv >= 0 ? MOVIES[p.mv].genres : p.t.genres;
    if (o.genres || o.detail) out.Genres = genres;
    if (o.overview || o.detail) out.Overview = `${out.Name}${out.EpisodeTitle ? ` · ${out.EpisodeTitle}` : ''} : programme fictif de ${ch.Name}, généré par le serveur de test de Wicaby.`;
    if (o.detail || o.timers !== false) {
      const timer = timerFor(pid);
      if (timer) out.TimerId = timer.Id;
      const sid = timer?.SeriesTimerId ?? [...seriesTimers.values()].find((r) => r.SeriesId && r.SeriesId === out.SeriesId && (r.RecordAnyChannel || r.ChannelId === ch.Id))?.Id;
      if (sid) out.SeriesTimerId = sid;
    }
    // A fresh default: programmes never get an entry in the shared user-data map.
    if (o.userData !== false) out.UserData = emby ? { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false } : { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false, Key: pid, ItemId: pid };
    return out;
  }
  const userDataOf = (id) => (emby ? { ...ud(id) } : { ...ud(id), Key: id, ItemId: id });

  function chanDto(ch, o = {}) {
    const out = {
      Id: ch.Id,
      ServerId: serverId,
      Name: ch.Name,
      Type: 'TvChannel',
      ChannelType: ch.radio ? 'Radio' : 'TV',
      MediaType: ch.radio ? 'Audio' : 'Video',
      IsFolder: false,
    };
    if (ch.Number !== undefined) {
      out.Number = ch.Number;
      out.ChannelNumber = ch.Number;
    }
    if (!cfg.flagless && ch.hd && !(emby && !cfg.embyHd)) out.IsHD = true;
    if (o.images !== false) out.ImageTags = ch.logo ? { Primary: `lg${ch.i}` } : {};
    if (o.userData !== false) out.UserData = userDataOf(ch.Id);
    if (o.tags) out.Tags = [ch.group.tag];
    if (o.current) {
      const t = now();
      const cur = range(ch, g.progs[ch.i], t + 1, t + 1)[0];
      if (cur) out.CurrentProgram = progDto(ch, cur, { images: o.images, userData: false });
    }
    return out;
  }

  // ---- Timers ----
  function padded(x) {
    return [Date.parse(x.StartDate) - (x.PrePaddingSeconds ?? 0) * 1000, Date.parse(x.EndDate) + (x.PostPaddingSeconds ?? 0) * 1000];
  }
  function addTimer(p, ch, b, rule) {
    const id = `ltt-${++seq}`;
    const timer = {
      Id: id,
      ProgramId: progId(ch, p),
      ChannelId: ch.Id,
      ChannelName: ch.Name,
      Name: progName(p),
      StartDate: iso(p.s),
      EndDate: iso(p.e),
      PrePaddingSeconds: b.PrePaddingSeconds ?? rule?.PrePaddingSeconds ?? 60,
      PostPaddingSeconds: b.PostPaddingSeconds ?? rule?.PostPaddingSeconds ?? 300,
      IsPrePaddingRequired: false,
      IsPostPaddingRequired: false,
      Priority: rule?.Priority ?? b.Priority ?? 0,
      KeepUntil: 'UntilDeleted',
      SeriesTimerId: rule?.Id,
      created: seq,
      cancelled: false,
      completed: false,
    };
    timers.set(id, timer);
    return timer;
  }
  // Statuses at read time: Cancelled, Completed, InProgress, then tuner conflicts (higher Priority, then the
  // earlier timer, wins a tuner), else New.
  function statuses() {
    const t = now();
    const out = new Map();
    const live = [];
    for (const x of timers.values()) {
      const [s, e] = padded(x);
      if (x.cancelled) out.set(x.Id, 'Cancelled');
      else if (x.completed || e <= t) out.set(x.Id, 'Completed');
      else if (s <= t) out.set(x.Id, 'InProgress');
      else live.push({ x, s, e });
    }
    live.sort((a, b) => b.x.Priority - a.x.Priority || a.x.created - b.x.created);
    const accepted = [];
    const losers = [];
    for (const c of live) {
      const over = accepted.filter((a) => a.s < c.e && a.e > c.s);
      // Peak concurrency of the accepted timers inside c's window.
      const points = over.flatMap((a) => [[Math.max(a.s, c.s), 1], [Math.min(a.e, c.e), -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let cur = 0;
      let peak = 0;
      for (const [, d] of points) peak = Math.max(peak, (cur += d));
      if (peak >= cfg.tuners) losers.push(c);
      else accepted.push(c);
    }
    for (const c of accepted) out.set(c.x.Id, losers.some((l) => l.s < c.e && l.e > c.s) ? 'ConflictedOk' : 'New');
    for (const c of losers) out.set(c.x.Id, 'ConflictedNotOk');
    return out;
  }
  function timerDto(x, status) {
    const { created: _c, cancelled: _x, completed: _d, ...rest } = x;
    const prog = parseProgId(x.ProgramId);
    return {
      ...rest,
      Type: 'Timer',
      ServerId: serverId,
      Status: status,
      RunTimeTicks: (Date.parse(x.EndDate) - Date.parse(x.StartDate)) * TICKS_PER_MS,
      ProgramInfo: prog ? progDto(prog.ch, prog.p, { userData: false }) : undefined,
    };
  }
  function seriesMatches(rule) {
    const t = now();
    const ref = parseProgId(rule.ProgramId);
    const tod = ref ? new Date(ref.p.s).getHours() * 60 + new Date(ref.p.s).getMinutes() : null;
    const days = (rule.Days ?? []).map((d) => String(d).toLowerCase());
    const out = [];
    for (const ch of g.lineup) {
      if (!rule.RecordAnyChannel && ch.Id !== rule.ChannelId) continue;
      for (const p of range(ch, g.progs[ch.i], t, t + 7 * 24 * HOUR)) {
        if (seriesId(ch, p) !== rule.SeriesId) continue;
        const d = new Date(p.s);
        if (!rule.RecordAnyTime && tod !== null && d.getHours() * 60 + d.getMinutes() !== tod) continue;
        if (days.length && !days.includes(d.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase())) continue;
        if (rule.RecordNewOnly && !(p.f & F.New)) continue;
        out.push({ ch, p });
      }
    }
    return out.slice(0, 60);
  }
  function syncChildren(rule) {
    const keep = new Map([...timers.values()].filter((x) => x.SeriesTimerId === rule.Id).map((x) => [x.ProgramId, x]));
    const want = seriesMatches(rule);
    const wantIds = new Set(want.map(({ ch, p }) => progId(ch, p)));
    for (const [pid, x] of keep) if (!wantIds.has(pid) && !x.cancelled && !x.completed && Date.parse(x.StartDate) > now()) timers.delete(x.Id);
    for (const { ch, p } of want) {
      const x = keep.get(progId(ch, p));
      if (x) Object.assign(x, { PrePaddingSeconds: rule.PrePaddingSeconds, PostPaddingSeconds: rule.PostPaddingSeconds, Priority: rule.Priority });
      else if (!timerFor(progId(ch, p))) addTimer(p, ch, {}, rule);
    }
  }
  function addSeriesTimer(p, ch, b) {
    const id = `ltst-${++seq}`;
    const d = new Date(p.s);
    const rule = {
      Id: id,
      Type: 'SeriesTimer',
      ServerId: serverId,
      Name: progName(p),
      ChannelId: ch.Id,
      ChannelName: ch.Name,
      ProgramId: progId(ch, p),
      SeriesId: seriesId(ch, p),
      StartDate: iso(p.s),
      EndDate: iso(p.e),
      RecordAnyTime: !!b.RecordAnyTime,
      RecordAnyChannel: !!b.RecordAnyChannel,
      RecordNewOnly: !!b.RecordNewOnly,
      SkipEpisodesInLibrary: !!b.SkipEpisodesInLibrary,
      KeepUpTo: b.KeepUpTo ?? 0,
      KeepUntil: b.KeepUntil ?? 'UntilDeleted',
      Days: b.Days ?? [],
      DayPattern: b.DayPattern,
      PrePaddingSeconds: b.PrePaddingSeconds ?? 60,
      PostPaddingSeconds: b.PostPaddingSeconds ?? 300,
      IsPrePaddingRequired: false,
      IsPostPaddingRequired: false,
      Priority: b.Priority ?? 0,
      ImageTags: { Primary: 'pp' },
      TimeOfDay: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    };
    seriesTimers.set(id, rule);
    syncChildren(rule);
    return rule;
  }
  seedDvr();

  // ---- HTTP helpers ----
  function send(res, status, b, type = 'application/json') {
    if (res.headersSent || res.destroyed) return true;
    res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
    res.end(type === 'application/json' && b !== undefined ? JSON.stringify(b) : b);
    return true;
  }
  const text = (res, status, msg) => send(res, status, msg, 'text/plain; charset=utf-8');
  async function raw(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks);
  }
  async function json(req) {
    if (req.method === 'GET' || req.method === 'HEAD') return {};
    try {
      return JSON.parse((await raw(req)).toString('utf8') || '{}');
    } catch {
      return {};
    }
  }
  const qget = (q, name) => {
    const n = name.toLowerCase();
    for (const [k, v] of q) if (k.toLowerCase() === n) return v;
    return null;
  };
  const truthy = (v) => v === true || String(v).toLowerCase() === 'true';
  const flagParam = (v) => (v === null || v === undefined ? null : truthy(v));
  const isMine = (id) => /^(ltc-\d+|p-ltc-\d+-\d+)$/.test(id ?? '');
  const normPath = (p) => p.split('/').map((s) => (/^(ltc-|p-ltc-|ltt-|ltst-|ltr-|ls-|lms-)/i.test(s) || /^[0-9a-f]{20,}$/i.test(s) ? '{id}' : s)).join('/');
  const count = (p) => {
    const k = normPath(p);
    st.requests[k] = (st.requests[k] ?? 0) + 1;
  };
  function stampDate(res) {
    if (cfg.skewMin || clockOffsetMin) res.setHeader('Date', new Date(now()).toUTCString());
  }
  const routeKey = (lp) => (lp[2] === 'playbackinfo' ? 'playbackinfo' : lp[0] === 'livetv' ? (lp[1] ?? 'livetv') : lp[0]);

  // ---- Classification ----
  // Which requests this module answers. Images and streams are anonymous; everything else needs the mock's token.
  function classify(method, lp, parts, q) {
    if (lp[0] === 'items' && isMine(parts[1]) && lp[2] === 'images') return 'image';
    if ((lp[0] === 'videos' || lp[0] === 'audio') && isMine(parts[1])) return 'stream';
    if (lp[0] === 'livetv' && lp[1] === 'livestreamfiles') return 'stream';
    if (lp[0] === 'livetv') return 'livetv';
    if (lp[0] === 'livestreams') return 'livestreams';
    if (lp[0] === 'items' && isMine(parts[1]) && lp[2] === 'playbackinfo') return 'pbi';
    if (lp[0] === 'users' && lp[2] === 'items' && isMine(parts[3]) && !lp[4]) return 'item';
    if (lp[0] === 'users' && lp[2] === 'items' && !lp[3]) {
      const ids = (qget(q, 'Ids') ?? '').split(',').filter(Boolean);
      if (ids.length && ids.every(isMine)) return 'items';
      if (!emby && /livetvprogram/i.test(qget(q, 'IncludeItemTypes') ?? '')) return 'search';
    }
    if (emby && lp[0] === 'users' && lp[2] === 'favoriteitems' && isMine(parts[3])) return 'fav';
    if (lp[0] === 'displaypreferences' && parts[1]) return 'prefs';
    if (emby && lp[0] === 'sessions' && lp[1] === 'playing' && method === 'POST') return 'report';
    if (lp[0] === 'videos' && lp[1] === 'activeencodings' && method === 'DELETE') return 'kill';
    return null;
  }

  // Jellyfin forwards these paths to the Emby handler (it already forwards LiveTv, LiveStreams, Items).
  function claims(lp) {
    return lp[0] === 'displaypreferences' || ((lp[0] === 'videos' || lp[0] === 'audio') && isMine(lp[1]));
  }

  async function route(req, res, p, parts, q) {
    const lp = parts.map((s) => s.toLowerCase());
    if (lp[0] === 'mock' && lp[1] === 'livetv') return control(req, res, `/${parts.join('/')}`, q);
    const kind = classify(req.method, lp, parts, q);
    stampDate(res);
    // MOCK_CAN_RECORD=0: the user DTO (answered by mock-admin) says so too.
    if (!cfg.canRecord && lp[0] === 'users' && parts.length === 2 && req.method === 'GET') denyRecordingPolicy(res);
    if (!kind) return false;
    count(p);
    if (kind !== 'image' && kind !== 'stream' && host.authed && !host.authed(req, q)) return text(res, 401, 'Unauthorized');
    if (kind !== 'image' && kind !== 'stream') {
      await sleep(cfg.latencyMs);
      const key = routeKey(lp);
      for (const f of cfg.faults) if (f.key === key && faultRng() < f.p) return text(res, f.status, `Injected fault (${key})`);
    }
    switch (kind) {
      case 'image':
        return image(res, parts[1], q);
      case 'stream':
        return stream(req, res, lp, parts, q);
      case 'livetv':
        return liveTvRoute(req, res, lp, parts, q);
      case 'livestreams':
        return lp[1] === 'open' ? openRoute(req, res, q) : lp[1] === 'close' ? closeRoute(req, res, q) : text(res, 404, 'Not found');
      case 'pbi':
        return playbackInfo(req, res, parts[1], q);
      case 'item': {
        const dto = itemDto(parts[3], q);
        return dto ? send(res, 200, dto) : text(res, 404, 'Not found');
      }
      case 'items': {
        const arr = qget(q, 'Ids').split(',').map((id) => itemDto(id, q)).filter(Boolean);
        return send(res, 200, { Items: arr, TotalRecordCount: arr.length, StartIndex: 0 });
      }
      case 'search':
        return jfSearch(res, q);
      case 'fav': {
        const d = ud(parts[3]);
        d.IsFavorite = req.method === 'POST';
        emit('UserDataChanged', { UserId: parts[1], UserDataList: [{ ...d, ItemId: parts[3], Key: parts[3] }] }, false);
        return send(res, 200, d);
      }
      case 'prefs':
        return prefsRoute(req, res, parts[1], q);
      case 'report': {
        const b = await json(req);
        const r = report(lp[2] ?? 'start', b, q);
        return r === 400 ? text(res, 400, 'PlaySessionId is required') : send(res, 204);
      }
      case 'kill':
        encodingsKilled(204);
        return send(res, 204);
    }
    return false;
  }

  function denyRecordingPolicy(res) {
    const end = res.end.bind(res);
    res.end = (b, ...rest) => {
      try {
        const u = JSON.parse(String(b));
        if (u?.Policy) b = JSON.stringify({ ...u, Policy: { ...u.Policy, EnableLiveTvManagement: false } });
      } catch {
        // Not JSON: leave it.
      }
      return end(b, ...rest);
    };
  }

  function itemDto(id, q) {
    const ch = byId.get(id);
    if (ch) return chanDto(ch, { current: true, tags: emby });
    const pr = parseProgId(id);
    return pr ? progDto(pr.ch, pr.p, { detail: true }) : null;
  }

  // ---- /LiveTv ----
  async function liveTvRoute(req, res, lp, parts, q) {
    const M = req.method;
    if (lp[1] === 'info') {
      return send(res, 200, {
        IsEnabled: true,
        EnabledUsers: [host.userId ?? 'u-wika'],
        Services: [{ Name: 'Mock IPTV', Status: 'Ok', Version: '1.0', HasUpdateAvailable: false, IsVisible: true, Tuners: Array.from({ length: cfg.tuners }, (_, i) => `tuner-${i + 1}`) }],
      });
    }
    if (lp[1] === 'guideinfo') return send(res, 200, { StartDate: iso(g.dataStart), EndDate: iso(g.dataEnd) });
    if (lp[1] === 'channeltags') {
      if (!emby) return text(res, 404, 'Not found');
      const tags = GROUPS.map((x) => x.tag).filter((tag) => g.lineup.some((c) => c.group.tag === tag));
      return send(res, 200, { Items: tags.map((Name) => ({ Name, Id: `tag-${fold(Name)}`, Type: 'Tag' })), TotalRecordCount: tags.length });
    }
    if (lp[1] === 'channels') {
      if (parts[2]) {
        const ch = byId.get(parts[2]);
        return ch ? send(res, 200, chanDto(ch, { current: true, tags: emby })) : text(res, 404, 'Not found');
      }
      return channels(res, q);
    }
    if (lp[1] === 'programs') {
      if (lp[2] === 'recommended') return recommended(res, q);
      if (parts[2]) {
        const pr = parseProgId(parts[2]);
        return pr ? send(res, 200, progDto(pr.ch, pr.p, { detail: true })) : text(res, 404, 'Not found');
      }
      if (M === 'POST' && emby) return text(res, 405, 'Method not allowed');
      const b = M === 'POST' ? await json(req) : {};
      return programs(req, res, q, b);
    }
    if (lp[1] === 'timers' || lp[1] === 'seriestimers') return timersRoute(req, res, lp, parts, q);
    if (lp[1] === 'availablerecordingoptions') {
      if (!emby) return text(res, 404, 'Not found');
      return send(res, 200, { RecordingFolders: [{ Id: 'rf-1', Name: 'Enregistrements', Path: '/srv/dvr' }, { Id: 'rf-2', Name: 'Films enregistrés', Path: '/srv/dvr-films' }], DefaultRecordingFolder: 'rf-1' });
    }
    if (lp[1] === 'recordings') {
      if (lp[2] === 'folders') {
        if (emby) return text(res, 404, 'Not found');
        return send(res, 200, { Items: [{ Id: 'rf-1', Name: 'Enregistrements', Type: 'CollectionFolder', CollectionType: 'tvshows' }], TotalRecordCount: 1 });
      }
      if (lp[2] === 'groups' || lp[2] === 'series') {
        if (!emby && cfg.jfVersion === '12.2') return text(res, 404, 'Not found');
        return send(res, 200, { Items: [], TotalRecordCount: 0 });
      }
      if (parts[2]) {
        const rec = recordings.get(parts[2]);
        if (!rec) return text(res, 404, 'Not found');
        if (M === 'DELETE' || (M === 'POST' && lp[3] === 'delete')) {
          if (!cfg.canRecord) return text(res, 403, 'Forbidden');
          recordings.delete(rec.Id);
          host.items?.delete(rec.Id);
          return send(res, 204);
        }
        return send(res, 200, recView(rec));
      }
      let arr = [...recordings.values()];
      const inProgress = flagParam(qget(q, 'IsInProgress'));
      if (inProgress !== null) arr = arr.filter((r) => (r.Status === 'InProgress') === inProgress);
      for (const k of ['IsMovie', 'IsSeries', 'IsSports', 'IsKids', 'IsNews']) {
        const v = flagParam(qget(q, k));
        if (v !== null) arr = arr.filter((r) => !!r[k] === v);
      }
      if (qget(q, 'ChannelId')) arr = arr.filter((r) => r.ChannelId === qget(q, 'ChannelId'));
      arr.sort((a, b) => Date.parse(b.DateCreated) - Date.parse(a.DateCreated));
      const start = Number(qget(q, 'StartIndex') ?? 0);
      const limit = Number(qget(q, 'Limit') ?? 10_000);
      return send(res, 200, { Items: arr.slice(start, start + limit).map(recView), TotalRecordCount: arr.length, StartIndex: start });
    }
    return text(res, 404, 'Not found');
  }
  const recView = (rec) => (host.view ? host.view(rec) : { ...rec, ServerId: serverId, UserData: userDataOf(rec.Id) });

  function channels(res, q) {
    let arr = g.lineup;
    const type = qget(q, 'Type');
    if (type) arr = arr.filter((c) => (c.radio ? 'radio' : 'tv') === type.toLowerCase());
    const fav = flagParam(qget(q, 'IsFavorite'));
    if (fav !== null) arr = arr.filter((c) => !!ud(c.Id).IsFavorite === fav);
    const tags = qget(q, 'Tags');
    if (emby && tags) {
      const want = new Set(tags.split(/[|,]/).map(fold));
      arr = arr.filter((c) => want.has(fold(c.group.tag)));
    }
    if (!cfg.categoryIgnored) {
      for (const [k, bit] of Object.entries(CATEGORY)) {
        const v = flagParam(qget(q, k));
        if (v !== null) arr = arr.filter((c) => !!(c.flagsAny & bit && !cfg.flagless) === v);
      }
    }
    const sortBy = (qget(q, 'SortBy') ?? '').split(',')[0].toLowerCase();
    if (sortBy) {
      arr = [...arr];
      if (sortBy === 'name') arr.sort((a, b) => fold(a.Name).localeCompare(fold(b.Name)));
      else if (sortBy === 'dateplayed') arr.sort((a, b) => (ud(b.Id).LastPlayedDate ?? '').localeCompare(ud(a.Id).LastPlayedDate ?? ''));
      else arr.sort(byNumber);
      if (qget(q, 'SortOrder') === 'Descending') arr.reverse();
    } else arr = [...arr].sort(byNumber);
    const start = Number(qget(q, 'StartIndex') ?? 0);
    const limit = Number(qget(q, 'Limit') ?? 100_000);
    const fields = (qget(q, 'Fields') ?? '').toLowerCase().split(',');
    const o = {
      images: qget(q, 'EnableImages') !== 'false',
      userData: qget(q, 'EnableUserData') !== 'false',
      tags: emby && fields.includes('tags'),
      current: qget(q, 'AddCurrentProgram') !== 'false',
    };
    const page = arr.slice(start, start + limit).map((c) => chanDto(c, o));
    return send(res, 200, { Items: page, TotalRecordCount: qget(q, 'EnableTotalRecordCount') === 'false' ? 0 : arr.length, StartIndex: start });
  }
  function numberKey(c) {
    if (c.Number === undefined) return [Infinity, 0, c.i];
    const m = /^(\d+)(?:[.\-\s](\d+))?/.exec(c.Number);
    return m ? [Number(m[1]), m[2] ? Number(m[2]) : -1, c.i] : [Infinity, 0, c.i];
  }
  function byNumber(a, b) {
    const x = numberKey(a);
    const y = numberKey(b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  }

  function programFilter(q, b) {
    const get = (k) => qget(q, k) ?? (b[k] !== undefined ? String(b[k]) : null);
    const f = [];
    // MOCK_LIVE_FLAGLESS: the server has no flags at all, so a flag filter matches nothing set.
    const has = (p, bit) => !cfg.flagless && !!(p.f & bit);
    for (const [k, bit] of Object.entries(CATEGORY)) {
      const v = flagParam(get(k));
      if (v !== null) f.push((p) => has(p, bit) === v);
    }
    if (emby) {
      for (const [k, bit] of [['IsNew', F.New], ['IsPremiere', F.Premiere], ['IsRepeat', F.Repeat]]) {
        const v = flagParam(get(k));
        if (v !== null) f.push((p) => has(p, bit) === v);
      }
      const nop = flagParam(get('IsNewOrPremiere'));
      if (nop !== null) f.push((p) => has(p, F.New | F.Premiere) === nop);
    }
    const t = now();
    const aired = flagParam(get('HasAired'));
    if (aired !== null) f.push((p) => p.e <= t === aired);
    const airing = flagParam(get('IsAiring'));
    if (airing !== null) f.push((p) => (p.s <= t && p.e > t) === airing);
    const term = emby ? get('SearchTerm') : null;
    if (term) {
      const ft = fold(term);
      f.push((p) => fold(progName(p)).includes(ft));
    }
    return f;
  }

  function collect(chIds, minEnd, maxStart, filters, extra) {
    const out = [];
    const chans = chIds ? chIds.map((id) => byId.get(id)).filter(Boolean) : g.lineup;
    for (const ch of chans) {
      for (const p of range(ch, g.progs[ch.i], minEnd, maxStart)) {
        if (filters.every((fn) => fn(p)) && (!extra || extra(ch, p))) out.push({ ch, p });
      }
    }
    return out;
  }

  function programs(req, res, q, b) {
    if (faultQueue.programs500 > 0) {
      faultQueue.programs500--;
      return text(res, 500, 'Injected fault (programs500)');
    }
    const get = (k) => qget(q, k) ?? (b[k] !== undefined ? (Array.isArray(b[k]) ? b[k].join(',') : String(b[k])) : null);
    const ids = get('ChannelIds')?.split(',').filter(Boolean) ?? null;
    st.programQueries++;
    st.maxProgramIds = Math.max(st.maxProgramIds, ids?.length ?? 0);
    st.maxProgramUrl = Math.max(st.maxProgramUrl, req.url.length);
    st.lastProgramQuery = { ids: ids?.length ?? 0, urlLength: req.url.length, minEndDate: get('MinEndDate'), maxStartDate: get('MaxStartDate'), minStartDate: get('MinStartDate') };
    log(`Programs ids=${ids?.length ?? 'all'} url=${req.url.length}`);
    const date = (k, d) => {
      const v = get(k);
      const ms = v ? Date.parse(v) : NaN;
      return Number.isNaN(ms) ? d : ms;
    };
    const minEnd = date('MinEndDate', -Infinity);
    const maxStart = date('MaxStartDate', Infinity);
    const minStart = date('MinStartDate', -Infinity);
    const maxEnd = date('MaxEndDate', Infinity);
    const filters = programFilter(q, b);
    if (minStart > -Infinity) filters.push((p) => p.s >= minStart);
    if (maxEnd < Infinity) filters.push((p) => p.e <= maxEnd);
    let extra = null;
    const lib = get('LibrarySeriesId');
    if (lib) extra = (ch, p) => seriesId(ch, p) === lib;
    const rule = get('SeriesTimerId');
    if (rule) {
      const pids = new Set([...timers.values()].filter((x) => x.SeriesTimerId === rule && !x.cancelled).map((x) => x.ProgramId));
      const prev = extra;
      extra = (ch, p) => pids.has(progId(ch, p)) && (!prev || prev(ch, p));
    }
    const found = collect(ids, minEnd === -Infinity ? g.dataStart - 1 : minEnd, maxStart === Infinity ? g.dataEnd + 1 : maxStart, filters, extra);
    const sort = (get('SortBy') ?? 'StartDate').toLowerCase();
    if (sort.startsWith('name') || sort.startsWith('sortname')) found.sort((a, b) => fold(progName(a.p)).localeCompare(fold(progName(b.p))));
    else found.sort((a, b) => a.p.s - b.p.s || a.ch.i - b.ch.i);
    if (get('SortOrder') === 'Descending') found.reverse();
    const start = Number(get('StartIndex') ?? 0);
    const limit = Number(get('Limit') ?? 1_000_000);
    const fields = (get('Fields') ?? '').toLowerCase().split(',');
    const o = { images: get('EnableImages') !== 'false', userData: get('EnableUserData') !== 'false', genres: fields.includes('genres'), overview: fields.includes('overview') };
    const items = found.slice(start, start + limit).map(({ ch, p }) => progDto(ch, p, o));
    return send(res, 200, { Items: items, TotalRecordCount: get('EnableTotalRecordCount') === 'false' ? 0 : found.length, StartIndex: start });
  }

  // On now. MOCK_EMBY_ONNOW=ignore: Emby ignores IsAiring and mixes in what starts later (the V15 probe).
  function recommended(res, q) {
    const t = now();
    const ignore = emby && cfg.embyOnNow === 'ignore';
    const airing = flagParam(qget(q, 'IsAiring'));
    const filters = programFilter(new URLSearchParams([...q].filter(([k]) => !(ignore && k.toLowerCase() === 'isairing'))), {});
    const found = airing && !ignore ? collect(null, t + 1, t + 1, filters) : collect(null, t, t + 6 * HOUR, filters);
    // Interesting first: films, sport, then series; inside, by start and lineup order.
    const score = (p) => (p.f & F.Movie ? 0 : p.f & F.Sports ? 1 : p.f & F.Series ? 2 : 3);
    found.sort((a, b) => score(a.p) - score(b.p) || (ignore ? b.p.s - a.p.s : a.p.s - b.p.s) || a.ch.i - b.ch.i);
    const limit = Number(qget(q, 'Limit') ?? 24);
    const items = found.slice(0, limit).map(({ ch, p }) => progDto(ch, p, { images: qget(q, 'EnableImages') !== 'false', genres: true, overview: true }));
    return send(res, 200, { Items: items, TotalRecordCount: found.length });
  }

  function jfSearch(res, q) {
    if (!cfg.jfProgramSearch) return send(res, 200, { Items: [], TotalRecordCount: 0, StartIndex: 0 });
    const term = fold(qget(q, 'SearchTerm') ?? '');
    const found = term ? collect(null, g.dataStart, g.dataEnd, [(p) => fold(progName(p)).includes(term)]) : [];
    found.sort((a, b) => a.p.s - b.p.s || a.ch.i - b.ch.i);
    const limit = Number(qget(q, 'Limit') ?? 100);
    return send(res, 200, { Items: found.slice(0, limit).map(({ ch, p }) => progDto(ch, p, {})), TotalRecordCount: found.length, StartIndex: 0 });
  }

  // ---- Timers routes ----
  async function timersRoute(req, res, lp, parts, q) {
    const M = req.method;
    const series = lp[1] === 'seriestimers';
    const id = parts[2];
    if (!series && lp[2] === 'defaults') {
      const pr = parseProgId(qget(q, 'ProgramId'));
      if (!pr) return text(res, 404, 'Program not found');
      const { ch, p } = pr;
      return send(res, 200, {
        ProgramId: progId(ch, p), ChannelId: ch.Id, ChannelName: ch.Name, Name: progName(p), ServerId: serverId, Type: 'SeriesTimer',
        StartDate: iso(p.s), EndDate: iso(p.e), SeriesId: seriesId(ch, p),
        PrePaddingSeconds: 60, PostPaddingSeconds: 300, IsPrePaddingRequired: false, IsPostPaddingRequired: false, Priority: 0,
        RecordAnyTime: false, RecordAnyChannel: false, RecordNewOnly: false, SkipEpisodesInLibrary: false, KeepUpTo: 0, KeepUntil: 'UntilDeleted', Days: [],
      });
    }
    const write = M !== 'GET';
    if (write && !cfg.canRecord) return text(res, 403, 'Live TV management is not allowed for this user');
    if (!series) {
      if (M === 'GET' && !id) {
        const sts = statuses();
        let arr = [...timers.values()];
        const rule = qget(q, 'SeriesTimerId');
        if (rule) arr = arr.filter((x) => x.SeriesTimerId === rule);
        if (qget(q, 'ChannelId')) arr = arr.filter((x) => x.ChannelId === qget(q, 'ChannelId'));
        // Jellyfin drops finished timers; Emby lists them as Completed.
        if (!emby) arr = arr.filter((x) => sts.get(x.Id) !== 'Completed');
        const active = flagParam(qget(q, 'IsActive'));
        if (active !== null) arr = arr.filter((x) => (sts.get(x.Id) === 'InProgress') === active);
        arr.sort((a, b) => Date.parse(a.StartDate) - Date.parse(b.StartDate));
        return send(res, 200, { Items: arr.map((x) => timerDto(x, sts.get(x.Id))), TotalRecordCount: arr.length });
      }
      if (M === 'POST' && !id) {
        const b = await json(req);
        if (emby && cfg.dvr === 'nopremiere') return text(res, 500, 'Emby Premiere required');
        const pr = parseProgId(b.ProgramId);
        if (!pr) return text(res, 400, 'Program not found');
        if (timerFor(progId(pr.ch, pr.p))) return text(res, 400, 'A timer already exists for this program');
        const x = addTimer(pr.p, pr.ch, b);
        emit('TimerCreated', { Id: x.Id, ProgramId: x.ProgramId });
        return send(res, 204);
      }
      const x = timers.get(id);
      if (!x) return text(res, 404, 'Timer not found');
      if (M === 'DELETE' || (M === 'POST' && lp[3] === 'delete')) {
        // A series child stays as a Cancelled tombstone (the episode is skipped); a one-off goes away.
        if (x.SeriesTimerId) x.cancelled = true;
        else timers.delete(id);
        emit('TimerCancelled', { Id: x.Id, ProgramId: x.ProgramId });
        return send(res, 204);
      }
      if (M === 'POST') {
        const b = await json(req);
        for (const k of ['PrePaddingSeconds', 'PostPaddingSeconds', 'IsPrePaddingRequired', 'IsPostPaddingRequired', 'Priority']) if (b[k] !== undefined) x[k] = b[k];
        return send(res, 204);
      }
      return send(res, 200, timerDto(x, statuses().get(x.Id)));
    }
    // Series rules
    if (M === 'GET' && !id) {
      const arr = [...seriesTimers.values()].sort((a, b) => b.Priority - a.Priority);
      return send(res, 200, { Items: arr, TotalRecordCount: arr.length });
    }
    if (M === 'POST' && !id) {
      const b = await json(req);
      if (emby && cfg.dvr === 'nopremiere') return text(res, 500, 'Emby Premiere required');
      const pr = parseProgId(b.ProgramId);
      if (!pr) return text(res, 400, 'Program not found');
      if (pr.p.t.kind !== 's') return text(res, 500, 'Program is not a series');
      const sid = seriesId(pr.ch, pr.p);
      if ([...seriesTimers.values()].some((r) => r.SeriesId === sid && r.ChannelId === pr.ch.Id)) return text(res, 400, 'A series timer already exists for this series');
      const rule = addSeriesTimer(pr.p, pr.ch, b);
      emit('SeriesTimerCreated', { Id: rule.Id, ProgramId: rule.ProgramId });
      return send(res, 204);
    }
    const rule = seriesTimers.get(id);
    if (!rule) return text(res, 404, 'Series timer not found');
    if (M === 'DELETE' || (M === 'POST' && lp[3] === 'delete')) {
      seriesTimers.delete(id);
      for (const x of [...timers.values()]) if (x.SeriesTimerId === id && !(x.completed || Date.parse(x.EndDate) <= now())) timers.delete(x.Id);
      emit('SeriesTimerCancelled', { Id: id, ProgramId: rule.ProgramId });
      return send(res, 204);
    }
    if (M === 'POST') {
      const b = await json(req);
      // The client must send the whole rule back (GET, merge, POST): a partial body is refused.
      const missing = ['Id', 'ChannelId', 'ProgramId', 'PrePaddingSeconds', 'PostPaddingSeconds', 'RecordAnyChannel', 'RecordAnyTime', 'RecordNewOnly', 'KeepUpTo'].filter((k) => b[k] === undefined);
      if (missing.length) return text(res, 400, `Partial series timer body (missing ${missing.join(', ')})`);
      for (const k of ['RecordAnyTime', 'RecordAnyChannel', 'RecordNewOnly', 'SkipEpisodesInLibrary', 'KeepUpTo', 'KeepUntil', 'Days', 'DayPattern', 'PrePaddingSeconds', 'PostPaddingSeconds', 'IsPrePaddingRequired', 'IsPostPaddingRequired', 'Priority']) if (b[k] !== undefined) rule[k] = b[k];
      syncChildren(rule);
      return send(res, 204);
    }
    return send(res, 200, rule);
  }

  // ---- DisplayPreferences ----
  async function prefsRoute(req, res, id, q) {
    const user = qget(q, 'UserId') ?? '';
    const queryClient = qget(q, 'Client');
    if (req.method === 'GET') {
      if (!emby && !queryClient) return text(res, 400, 'client is required');
      const client = queryClient ?? 'emby';
      if (client.toLowerCase() === 'emby') return clientEmby(res, 'GET', id);
      const doc = prefs.get(`${id}|${client}|${user}`) ?? { Id: id, SortBy: 'SortName', RememberIndexing: false, PrimaryImageHeight: 250, PrimaryImageWidth: 250, CustomPrefs: {}, ScrollDirection: 'Horizontal', ShowBackdrop: true, RememberSorting: false, SortOrder: 'Ascending', ShowSidebar: false, Client: client };
      return send(res, 200, doc);
    }
    if (req.method !== 'POST') return text(res, 405, 'Method not allowed');
    const b = await json(req);
    st.lastPrefsPost = { id, queryClient, bodyClient: b.Client ?? null, bodyId: b.Id ?? null, keys: Object.keys(b.CustomPrefs ?? {}).length };
    // Jellyfin binds client from the query; Emby 4.1.1 reads it from the DTO (a missing one means "emby").
    if (!emby && !queryClient) return text(res, 400, 'client is required');
    const client = emby ? (b.Client ?? 'emby') : queryClient;
    if (String(client).toLowerCase() === 'emby') return clientEmby(res, 'POST', id);
    if (Object.values(b.CustomPrefs ?? {}).some((v) => v !== null && typeof v !== 'string')) return text(res, 400, 'CustomPrefs values must be strings');
    prefs.set(`${id}|${client}|${user}`, { ...b, Id: id, Client: client });
    st.prefsWrites++;
    return send(res, 204);
  }
  function clientEmby(res, method, id) {
    st.clientEmby++;
    log(`FAIL DisplayPreferences ${method} ${id} with client=emby (would overwrite the Emby web app's own document)`);
    return text(res, 400, 'client=emby is refused by the Wicaby mock');
  }

  // ---- Tuning ----
  function channelMode(ch) {
    if (cfg.mode === 'mixed') return ch.mode;
    return { direct: 'direct', hdhr: 'hdhr', hls: 'hls', opening: 'opening' }[cfg.mode] ?? 'normal';
  }
  function openStream(ch, playSessionId, maxBitrate, transcoding) {
    const id = `ls-${++seq}-${crypto.randomBytes(3).toString('hex')}`;
    const s = { id, channelId: ch.Id, playSessionId, openedAt: new Date(realNow()).toISOString(), consumers: 0, transcoding, maxBitrate };
    streams.set(id, s);
    st.maxConcurrent = Math.max(st.maxConcurrent, streams.size);
    const d = ud(ch.Id);
    d.LastPlayedDate = new Date(now()).toISOString();
    d.PlayCount = (d.PlayCount ?? 0) + 1;
    return s;
  }
  function release(id, via) {
    if (streams.has(id)) {
      streams.delete(id);
      released.set(id, via);
      for (const c of conns) if (c.lsid === id) c.end();
      return 'ok';
    }
    if (released.has(id)) {
      st.doubleReleases++;
      log(`DOUBLE RELEASE ${id} by ${via} (first by ${released.get(id)})`);
      return 'double';
    }
    return 'unknown';
  }
  function source(ch, mode, s, psid, maxBitrate, needsOpen, req) {
    const bitrate = ch.radio ? 192_000 : cfg.bitrate || 8_000_000;
    const capped = !!maxBitrate && maxBitrate < bitrate;
    const lsid = s?.id;
    const msid = `lms-${ch.Id}`;
    const dp = (mode === 'normal' || mode === 'direct') && !capped;
    const ds = mode !== 'hls' && (!capped || mode === 'hdhr' || mode === 'direct');
    const tc = mode === 'normal' || mode === 'hls';
    const prefix = emby ? '/emby' : '';
    const ext = videoExt;
    const qs = new URLSearchParams({ DeviceId: 'mock', MediaSourceId: msid, PlaySessionId: psid, VideoCodec: 'h264', AudioCodec: 'aac', SegmentContainer: 'ts', MaxStreamingBitrate: String(maxBitrate ?? bitrate) });
    if (lsid) qs.set('LiveStreamId', lsid);
    const streamsDto = ch.radio
      ? [{ Index: 0, Type: 'Audio', Codec: 'aac', Channels: 2, SampleRate: 48000, BitRate: 192_000, Language: 'fre', IsDefault: true, DisplayTitle: 'Français AAC stéréo' }]
      : [
          { Index: 0, Type: 'Video', Codec: 'h264', Width: 1920, Height: 1080, IsInterlaced: ch.i % 3 === 0, RealFrameRate: 25, AverageFrameRate: 25, BitRate: bitrate - 192_000, DisplayTitle: '1080 H264' },
          { Index: 1, Type: 'Audio', Codec: 'aac', Channels: 2, SampleRate: 48000, BitRate: 192_000, Language: 'fre', IsDefault: true, DisplayTitle: 'Français AAC stéréo' },
          { Index: 2, Type: 'Subtitle', Codec: 'dvbsub', Language: 'fre', DisplayTitle: 'Français (DVB)', DeliveryMethod: 'Embed' },
        ];
    return {
      Id: msid,
      Name: ch.Name,
      Type: 'Default',
      Protocol: 'Http',
      Path: lsid ? `http://${req.headers.host ?? '127.0.0.1'}${prefix}/LiveTv/LiveStreamFiles/${lsid}/stream.${ext}` : `http://tuner.invalid/${ch.Id}.ts`,
      Container: ext,
      IsRemote: false,
      IsInfiniteStream: true,
      ReadAtNativeFramerate: true,
      RequiresOpening: needsOpen,
      OpenToken: needsOpen ? `tok-${ch.Id}` : undefined,
      RequiresClosing: true,
      LiveStreamId: lsid,
      SupportsProbing: true,
      AnalyzeDurationMs: 1000,
      SupportsDirectPlay: dp,
      SupportsDirectStream: ds,
      SupportsTranscoding: tc,
      TranscodingUrl: tc && lsid ? `/videos/${ch.Id}/master.m3u8?${qs}` : undefined,
      TranscodingSubProtocol: tc && lsid ? 'hls' : undefined,
      TranscodingContainer: tc && lsid ? 'ts' : undefined,
      Bitrate: bitrate,
      DefaultAudioStreamIndex: ch.radio ? 0 : 1,
      MediaStreams: streamsDto,
    };
  }
  function busyReply(res, open) {
    st.busyRejects++;
    log(`BUSY (${cfg.busy}) with ${streams.size}/${cfg.tuners} streams open`);
    if (cfg.busy === 'errorcode') return send(res, 200, { ErrorCode: 'NoCompatibleStream', MediaSources: [], PlaySessionId: uid() });
    if (cfg.busy === 'empty') return send(res, 200, open ? {} : { MediaSources: [], PlaySessionId: uid() });
    return text(res, 500, 'No tuners available');
  }
  function watchAbort(res) {
    const w = { aborted: false };
    res.on('close', () => {
      if (!res.writableFinished) w.aborted = true;
    });
    return w;
  }
  // Late = delivered after the client's tune timeout (§8.1): the client must close what it gets. A client that hung
  // up still gets its tuner opened, as on a real server, so a leak shows in openStreams (send() skips a dead socket).
  function lateOrGone(w, res, delay, ch) {
    if (delay >= cfg.lateMs) st.lateAnswers++;
    if (w.aborted || res.destroyed) log(`answer for ${ch.Id} after the client hung up: the stream stays open server-side`);
  }
  async function playbackInfo(req, res, chId, q) {
    const ch = byId.get(chId);
    if (!ch) return text(res, 404, 'Not found');
    if (req.method !== 'POST' && req.method !== 'GET') return text(res, 405, 'Method not allowed');
    const b = await json(req);
    const get = (k) => qget(q, k) ?? (b[k] !== undefined ? String(b[k]) : null);
    const autoOpen = truthy(get('AutoOpenLiveStream'));
    const maxBitrate = Number(get('MaxStreamingBitrate')) || null;
    if (!maxBitrate) st.missingBitrate++;
    const w = watchAbort(res);
    let delay = cfg.tuneMs + (cfg.jitterMs ? Math.floor(Math.random() * cfg.jitterMs) : 0);
    if (faultQueue.pbiSlow > 0) {
      faultQueue.pbiSlow--;
      delay = 20_000;
    }
    await sleep(delay);
    lateOrGone(w, res, delay, ch);
    if (faultQueue.pbi500 > 0) {
      faultQueue.pbi500--;
      return text(res, 500, 'Injected fault (pbi500)');
    }
    if (cfg.fail.has(ch.Id)) return text(res, 500, 'Error opening the tuner stream');
    const mode = channelMode(ch);
    const needsOpen = mode === 'opening' || !autoOpen;
    const psid = uid();
    let s = null;
    if (!needsOpen) {
      if (streams.size >= cfg.tuners) return busyReply(res, false);
      s = openStream(ch, psid, maxBitrate, mode === 'normal' || mode === 'hls');
    }
    return send(res, 200, { MediaSources: [source(ch, mode, s, psid, maxBitrate, needsOpen, req)], PlaySessionId: psid });
  }
  async function openRoute(req, res, q) {
    if (req.method !== 'POST') return text(res, 405, 'Method not allowed');
    const b = await json(req);
    const token = b.OpenToken ?? qget(q, 'OpenToken');
    const itemId = qget(q, 'ItemId') ?? b.ItemId;
    if (qget(q, 'ItemId') || qget(q, 'PlaySessionId')) st.openIdsInQuery++;
    if (b.ItemId || b.PlaySessionId || b.OpenToken) st.openIdsInBody++;
    const ch = byId.get(token?.startsWith('tok-') ? token.slice(4) : itemId);
    if (!ch) return text(res, 400, 'Unknown OpenToken');
    st.opens++;
    const maxBitrate = Number(qget(q, 'MaxStreamingBitrate') ?? b.MaxStreamingBitrate) || null;
    if (!maxBitrate) st.missingBitrate++;
    const w = watchAbort(res);
    await sleep(cfg.tuneMs);
    lateOrGone(w, res, cfg.tuneMs, ch);
    if (cfg.fail.has(ch.Id)) return text(res, 500, 'Error opening the tuner stream');
    if (streams.size >= cfg.tuners) return busyReply(res, true);
    const psid = qget(q, 'PlaySessionId') ?? b.PlaySessionId ?? uid();
    const mode = channelMode(ch) === 'opening' ? 'normal' : channelMode(ch);
    const s = openStream(ch, psid, maxBitrate, mode === 'normal' || mode === 'hls');
    return send(res, 200, { MediaSource: source(ch, mode, s, psid, maxBitrate, false, req) });
  }
  async function closeRoute(req, res, q) {
    if (req.method !== 'POST') return text(res, 405, 'Method not allowed');
    const body = await raw(req);
    if (faultQueue.closeBody400 > 0) {
      faultQueue.closeBody400--;
      st.closeRejects++;
      return text(res, 400, 'Injected fault (closeBody400)');
    }
    if (body.length) {
      st.closeRejects++;
      st.closeWithBody++;
      log('Close with a body refused (ids go in the query string)');
      return text(res, 400, 'LiveStreams/Close takes its ids in the query string');
    }
    const id = qget(q, 'LiveStreamId');
    if (!id) {
      st.closeRejects++;
      return text(res, 400, 'LiveStreamId is required');
    }
    if (emby && !qget(q, 'PlaySessionId')) {
      st.closeRejects++;
      return text(res, 400, 'PlaySessionId is required');
    }
    const r = release(id, 'close');
    if (r === 'ok') {
      st.closes++;
      return send(res, 204);
    }
    if (r === 'unknown') st.closeUnknown++;
    return text(res, 404, 'Live stream not found');
  }

  // Playback reports. Returns 400 when Emby would refuse it, else undefined. A Stopped report with a
  // LiveStreamId releases that stream.
  function report(kind, b, q) {
    const live = !!b?.LiveStreamId || byId.has(b?.ItemId);
    if (!live) return undefined;
    const psid = b.PlaySessionId ?? (q ? qget(q, 'PlaySessionId') : null);
    st.reports.push({ kind, at: new Date(realNow()).toISOString(), ItemId: b.ItemId, MediaSourceId: b.MediaSourceId, LiveStreamId: b.LiveStreamId ?? null, PlaySessionId: psid ?? null, PlayMethod: b.PlayMethod, IsPaused: b.IsPaused });
    if (st.reports.length > 100) st.reports.shift();
    if (emby && !psid) {
      if (kind === 'stopped') st.stopsWithoutPlaySessionId++;
      return 400;
    }
    if (kind === 'stopped' && b.LiveStreamId && release(b.LiveStreamId, 'stop') === 'ok') st.stopReleases++;
    return undefined;
  }
  function encodingsKilled(status) {
    st.encodingsKillAttempts++;
    if (status < 300) st.encodingsKilled++;
  }

  // ---- Streams ----
  function stream(req, res, lp, parts, q) {
    let lsid = qget(q, 'LiveStreamId');
    let ch = byId.get(parts[1]);
    if (lp[1] === 'livestreamfiles') {
      lsid = parts[2];
      ch = byId.get(streams.get(lsid)?.channelId);
    }
    if (lsid && !streams.has(lsid)) {
      st.streamsUnknown++;
      return text(res, 404, 'Live stream not found');
    }
    if (!lsid) st.streamsWithoutLiveStreamId++;
    if (lp.at(-1)?.endsWith('.m3u8')) {
      const seg = new URLSearchParams();
      if (lsid) seg.set('LiveStreamId', lsid);
      if (qget(q, 'PlaySessionId')) seg.set('PlaySessionId', qget(q, 'PlaySessionId'));
      const body = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:3600', '#EXT-X-MEDIA-SEQUENCE:0', '#EXTINF:3600.000,', `hls1/main/0.${videoExt}?${seg}`].join('\n');
      return send(res, 200, `${body}\n`, 'application/vnd.apple.mpegurl');
    }
    return serveLive(req, res, lsid, ch);
  }
  function serveLive(req, res, lsid, ch) {
    const src = videos.get(String(ch?.Number)) ?? video;
    if (!src || !fs.existsSync(src)) return text(res, 404, 'No test video configured');
    const ext = path.extname(src).slice(1).toLowerCase();
    const type = ext === 'ts' ? 'video/mp2t' : ext === 'mkv' || !ext ? 'video/x-matroska' : 'application/octet-stream';
    // Live: no Range, no Content-Length, no Accept-Ranges.
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
    if (req.method === 'HEAD') return res.end(), true;
    st.streamsServed++;
    const s = lsid ? streams.get(lsid) : null;
    if (s) s.consumers++;
    const file = fs.createReadStream(src, { highWaterMark: 64 * 1024 });
    const rate = cfg.bitrate ? cfg.bitrate / 8 : 0;
    const started = Date.now();
    let sent = 0;
    let stalled = false;
    let resumeTimer = null;
    const conn = {
      lsid,
      stall() {
        stalled = true;
        file.pause();
      },
      end() {
        file.destroy();
        res.end();
      },
    };
    conns.add(conn);
    if (faultQueue.streamStall > 0) {
      faultQueue.streamStall--;
      setTimeout(() => conn.stall(), 2000);
    }
    file.on('data', (chunk) => {
      if (stalled) return file.pause();
      sent += chunk.length;
      if (!res.write(chunk)) {
        file.pause();
        res.once('drain', () => !stalled && !resumeTimer && file.resume());
      }
      if (rate) {
        // Two seconds of burst, then real time at MOCK_LIVE_BITRATE.
        const ahead = sent / rate - (Date.now() - started) / 1000 - 2;
        if (ahead > 0) {
          file.pause();
          resumeTimer = setTimeout(() => {
            resumeTimer = null;
            if (!stalled) file.resume();
          }, ahead * 1000);
        }
      }
    });
    file.on('end', () => res.end());
    file.on('error', () => res.destroy());
    res.on('close', () => {
      conns.delete(conn);
      clearTimeout(resumeTimer);
      file.destroy();
      if (s) s.consumers = Math.max(0, s.consumers - 1);
    });
    return true;
  }

  function image(res, id, q) {
    const w = Number(qget(q, 'maxWidth') ?? qget(q, 'width') ?? 0);
    const h = Number(qget(q, 'maxHeight') ?? qget(q, 'height') ?? 0);
    const ch = byId.get(id);
    if (ch) {
      if (!ch.logo) return text(res, 404, 'Not found');
      // Wordmark on transparent, light on most and dark on some (to exercise the logo plate); radio logos are square.
      const [W, H] = ch.radio ? [400, 400] : [480, 200];
      const sw = w || (h ? Math.round((h * W) / H) : W);
      const sh = h || Math.round((sw * H) / W);
      const label = esc(ch.Name.toUpperCase().slice(0, 18));
      const size = Math.min(ch.radio ? 56 : 64, Math.round((W * 1.8) / Math.max(6, label.length)));
      return send(res, 200, `<svg xmlns="http://www.w3.org/2000/svg" width="${sw}" height="${sh}" viewBox="0 0 ${W} ${H}"><text x="${W / 2}" y="${H / 2 + size / 3}" text-anchor="middle" font-family="Bahnschrift, Arial, sans-serif" font-weight="700" font-size="${size}" fill="${ch.dark ? '#1b1c20' : '#f2f2f5'}">${label}</text></svg>`, 'image/svg+xml');
    }
    const pr = parseProgId(id);
    if (!pr) return text(res, 404, 'Not found');
    const W = w || 640;
    const H = h || Math.round((W * 9) / 16);
    const hue = (pr.ch.i * 47 + pr.p.ep * 13) % 360;
    return send(res, 200, `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 640 360"><rect width="640" height="360" fill="hsl(${hue},30%,22%)"/><text x="32" y="320" font-family="Bahnschrift, Arial, sans-serif" font-weight="700" font-size="36" fill="#ece8e1">${esc(progName(pr.p).slice(0, 30))}</text></svg>`, 'image/svg+xml');
  }

  // ---- Realtime: Emby /embywebsocket (Jellyfin uses its own /socket broadcaster through opts.emit) ----
  function frame(obj) {
    const data = Buffer.from(JSON.stringify(obj));
    const len = data.length;
    const head = len < 126 ? Buffer.from([0x81, len]) : len < 65536 ? Buffer.from([0x81, 126, len >> 8, len & 255]) : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
    return Buffer.concat([head, data]);
  }
  function upgrade(req, sock) {
    const url = new URL(req.url, 'http://x');
    if (!/^(\/emby)?\/embywebsocket\/?$/i.test(url.pathname)) return false;
    if (host.authed && !host.authed(req, url.searchParams)) {
      sock.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      return true;
    }
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const entry = { sock, deviceId: url.searchParams.get('deviceId') ?? '', at: realNow() };
    sockets.add(entry);
    sock.write(frame({ MessageType: 'ForceKeepAlive', Data: 60, MessageId: uid() }));
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const op = buf[0] & 15;
        let len = buf[1] & 127;
        let off = 2;
        if (len === 126) [len, off] = [buf.readUInt16BE(2), 4];
        else if (len === 127) [len, off] = [Number(buf.readBigUInt64BE(2)), 10];
        const masked = buf[1] & 128;
        const total = off + (masked ? 4 : 0) + len;
        if (buf.length < total) return;
        const mask = masked ? buf.subarray(off, off + 4) : null;
        const payload = Buffer.from(buf.subarray(total - len, total));
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        buf = buf.subarray(total);
        if (op === 8) return sock.end(Buffer.from([0x88, 0]));
        if (op === 9) sock.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
        if (op !== 1) continue;
        try {
          if (JSON.parse(payload.toString('utf8')).MessageType === 'KeepAlive') sock.write(frame({ MessageType: 'KeepAlive', MessageId: uid() }));
        } catch {
          // Ignore malformed frames.
        }
      }
    });
    const drop = () => sockets.delete(entry);
    sock.on('close', drop);
    sock.on('error', drop);
    return true;
  }
  // Sends to the Emby sockets and, on Jellyfin, through the mock's /socket broadcaster.
  function emit(MessageType, Data, record = true) {
    for (const s of sockets) s.sock.write(frame({ MessageType, Data, MessageId: uid() }));
    let sent = sockets.size;
    if (opts.emit) sent += opts.emit(MessageType, Data) ?? 0;
    if (record) {
      st.emitted.push({ MessageType, at: new Date(realNow()).toISOString() });
      if (st.emitted.length > 50) st.emitted.shift();
    }
    return sent;
  }

  // ---- Recording scheduler (Emby only): a 15 s tick emits RecordingStarted / RecordingEnded on status changes ----
  // Jellyfin sends neither. A timer cancelled or deleted while recording ends at the next tick.
  const recording = new Map(); // timer id -> timer, while InProgress
  function tick(silent = false) {
    const sts = statuses();
    for (const [id, x] of recording) {
      if (sts.get(id) === 'InProgress') continue;
      recording.delete(id);
      if (!silent) emit('RecordingEnded', timerDto(x, sts.get(id) ?? 'Completed'));
    }
    for (const x of timers.values()) {
      if (sts.get(x.Id) !== 'InProgress' || recording.has(x.Id)) continue;
      recording.set(x.Id, x);
      if (!silent) emit('RecordingStarted', timerDto(x, 'InProgress'));
    }
  }
  if (emby) {
    tick(true);
    setInterval(tick, 15_000).unref();
  }

  // ---- Control routes (no auth, loopback only) ----
  const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  async function control(req, res, p, q) {
    const remote = req.socket?.remoteAddress ?? '';
    if (!LOOPBACK.has(remote)) {
      log(`control route refused for ${remote}`);
      return text(res, 403, 'Mock control routes only answer loopback callers');
    }
    stampDate(res);
    const lp = p.split('/').filter(Boolean).map((s) => s.toLowerCase());
    const M = req.method;
    const what = lp[2];
    if (what === 'state' && M === 'GET') return send(res, 200, state());
    if (what === 'reset' && M === 'POST') {
      reset();
      return send(res, 204);
    }
    if (what === 'clock' && M === 'POST') {
      clockOffsetMin = Number(qget(q, 'offsetMin') ?? 0) || 0;
      return send(res, 200, { offsetMin: clockOffsetMin, now: new Date(now()).toISOString() });
    }
    if (what === 'fault' && M === 'POST') {
      const kind = qget(q, 'kind');
      if (!(kind in faultQueue)) return text(res, 400, `kind must be one of ${Object.keys(faultQueue).join(', ')}`);
      const n = Number(qget(q, 'count') ?? 1) || 1;
      if (kind === 'streamStall') {
        // Open live connections stall now; the rest of the count stalls the next ones after 2 s.
        let left = n;
        for (const c of conns) if (left > 0 && c.lsid) (c.stall(), left--);
        faultQueue.streamStall += left;
      } else faultQueue[kind] += n;
      return send(res, 200, { ...faultQueue });
    }
    if (what === 'refreshguide' && M === 'POST') {
      seed++;
      regenerate();
      emit('ScheduledTaskEnded', { Key: 'RefreshGuide', Name: 'Actualiser le guide', Status: 'Completed', StartTimeUtc: iso(realNow() - 2000), EndTimeUtc: iso(realNow()), Id: 'refresh-guide' });
      return send(res, 204);
    }
    if (what === 'emit' && M === 'POST') {
      const b = await json(req);
      if (!b.MessageType) return text(res, 400, 'MessageType is required');
      let Data = b.Data;
      // Remote Play of a channel: {"MessageType":"Play"} alone plays the first channel (or ?channelId=).
      if (b.MessageType === 'Play' && !Data) Data = { ItemIds: [qget(q, 'channelId') ?? g.lineup[0].Id], PlayCommand: 'PlayNow', StartPositionTicks: 0, ControllingUserId: host.userId ?? 'u-wika' };
      return send(res, 200, { sent: emit(b.MessageType, Data) });
    }
    if (what === 'playlist.m3u' && M === 'GET') return send(res, 200, m3u(`http://${req.headers.host ?? '127.0.0.1'}`), 'audio/x-mpegurl; charset=utf-8');
    if (what === 'logo' && lp[3]) return image(res, p.split('/').filter(Boolean)[3], q);
    if (what === 'raw' && lp[3]) {
      const ch = byId.get(p.split('/').filter(Boolean)[3].replace(/\.[a-z0-9]+$/i, ''));
      return ch ? serveLive(req, res, null, ch) : text(res, 404, 'Not found');
    }
    return text(res, 404, 'Not found');
  }

  function m3u(base = 'http://127.0.0.1') {
    const lines = ['#EXTM3U'];
    for (const ch of g.lineup) {
      const attrs = [`tvg-id="${ch.Id}"`, ch.Number !== undefined ? `tvg-chno="${ch.Number}"` : null, `tvg-name="${ch.Name.replace(/"/g, "'")}"`, ch.logo ? `tvg-logo="${base}/Mock/LiveTv/logo/${ch.Id}"` : null, `group-title="${ch.group.tag}"`, ch.radio ? 'radio="true"' : null].filter(Boolean);
      lines.push(`#EXTINF:-1 ${attrs.join(' ')},${ch.Name}`, `${base}/Mock/LiveTv/raw/${ch.Id}.${videoExt}`);
    }
    return `${lines.join('\n')}\n`;
  }

  function state() {
    return {
      flavour,
      tuners: cfg.tuners,
      seed,
      generated: { channels: g.lineup.length, programmes: g.count, ms: Math.round(g.ms), start: iso(g.dataStart), end: iso(g.dataEnd) },
      now: new Date(now()).toISOString(),
      clockOffsetMin,
      openStreams: [...streams.values()].map(({ id, channelId, playSessionId, openedAt, consumers }) => ({ id, channelId, playSessionId, openedAt, consumers })),
      ...st,
      faults: { ...faultQueue },
      sockets: sockets.size,
      timers: timers.size,
      seriesTimers: seriesTimers.size,
    };
  }

  function reset() {
    for (const c of [...conns]) c.end();
    streams.clear();
    released.clear();
    prefs.clear();
    for (const k of Object.keys(faultQueue)) faultQueue[k] = 0;
    clockOffsetMin = 0;
    if (seed !== cfg.seed) {
      seed = cfg.seed;
      regenerate();
    }
    resetState();
    seedDvr();
    recording.clear();
    if (emby) tick(true);
  }

  return {
    flavour,
    jfVersion: cfg.jfVersion,
    route,
    control,
    upgrade,
    claims,
    report,
    encodingsKilled,
    emit,
    state,
    reset,
    m3u,
    generated: () => ({ ms: g.ms, programmes: g.count, channels: g.lineup.length }),
  };
}
