// Where every demo image comes from, and how it is cropped. Input of scripts/build-demo-assets.mjs,
// which downloads, checks the licence, normalises and writes ATTRIBUTION.json / ATTRIBUTION.md.
//
// Only CC BY (any version) or CC0 material is accepted. Wikimedia Commons sources are checked live
// against the file's licence metadata (LicenseShortName) and its "Restrictions" field; the build fails
// on any other licence (BY-SA, BY-ND, NC...) and on any restriction (e.g. "trademarked") that the entry
// does not acknowledge in `restrictions`. Blender Studio sources carry their licence here; the build
// re-reads the page given as licenseSource and fails unless it still contains licenseQuote.
//
// Logos and trademarks are NOT covered by the CC licence (Blender Studio licensing pages: "Excluded from
// the Creative Commons license is: all logos ... (including the Blender logo, <film> logo, Creative
// Commons logo, sponsor logos) and associated trademarks"; studio.blender.org/terms-and-conditions:
// "Trademarks and logos - including the Blender logo - are copyrighted properties, with all rights
// reserved"). The published posters carry the film's title logo, the Blender and CC logos and sponsor
// marks, so every poster here is cropped (`crop`) to the artwork alone: no title treatment, credit
// block or logo strip is left (`removed` says what was cut). Wing It! uses the textless paintover
// preview instead of the final poster. The mock keeps drawing its own text logo.
//
// Agent 327: Operation Barbershop is left out on purpose: every Agent 327 asset on studio.blender.org
// is CC BY-ND (the character belongs to Martin Lodewijk), and the crop/resize step is a derivative.
//
// kind: 'poster' -> 600x900 JPEG, 'backdrop' -> 1920x1080 JPEG.
// crop (optional): source rectangle as fractions {x, y, w, h}; it is then narrowed to the target
// aspect ratio around focus {x, y} (0..1, default 0.5), so the result never reaches outside it.
// author / credit (optional on Commons entries): override the Commons Artist / Credit text when it is
// a URL, a typo or a description of how the file was made (the raw values stay in ATTRIBUTION.json).
// label (optional): what the image is, when the file name alone would mislead.

// Studio pages used as licenseSource. Sintel, Hero, Sprite Fright and Charge have no per-project
// licensing page (/projects/<slug>/pages/licensing/ answers 404), so they cite the site-wide terms.
const STUDIO_TERMS = 'https://studio.blender.org/terms-and-conditions/';
const STUDIO_TERMS_QUOTE = 'Unless notified otherwise, all digital content (webpages, video, artwork, 3D data) is available under the Creative Commons Attribution 4.0';
const STUDIO_TERMS_NOTE = 'Blender Studio terms (no per-project licensing page exists for this film): "Unless notified otherwise, all digital content (webpages, video, artwork, 3D data) is available under the Creative Commons Attribution 4.0." The same page: "Trademarks and logos - including the Blender logo - are copyrighted properties, with all rights reserved by its owners."';
const LOGOS_NOTE = (film, sponsors) =>
  `Project licensing page: CC BY 4.0 for all data published on the site. "Excluded from the Creative Commons license is: all logos on this website (including the Blender logo, ${film} logo, Creative Commons logo${sponsors ? ', sponsor logos' : ''}) and associated trademarks."`;
const BY4 = { license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' };
const STUDIO_CREDIT = '(CC) Blender Foundation | studio.blender.org';
// What the poster crops cut away (recorded per image in ATTRIBUTION).
const POSTER_REMOVED = 'title logo, credit block and the Blender, Creative Commons and sponsor logos';
const WING_IT_LICENSING = 'https://studio.blender.org/projects/wing-it/pages/licensing/';
const WING_IT_QUOTE = 'The work of the Wing It! project is licensed under the Creative Commons Attribution 4.0 license';

export const FILMS = [
  { slug: 'big-buck-bunny', title: 'Big Buck Bunny', year: 2008 },
  { slug: 'elephants-dream', title: 'Elephants Dream', year: 2006 },
  { slug: 'sintel', title: 'Sintel', year: 2010 },
  { slug: 'tears-of-steel', title: 'Tears of Steel', year: 2012 },
  { slug: 'cosmos-laundromat', title: 'Cosmos Laundromat: First Cycle', year: 2015 },
  { slug: 'spring', title: 'Spring', year: 2019 },
  { slug: 'caminandes', title: 'Caminandes', year: 2013 },
  { slug: 'glass-half', title: 'Glass Half', year: 2015 },
  { slug: 'hero', title: 'Hero', year: 2018 },
  { slug: 'coffee-run', title: 'Coffee Run', year: 2020 },
  { slug: 'sprite-fright', title: 'Sprite Fright', year: 2021 },
  { slug: 'charge', title: 'Charge', year: 2022 },
  { slug: 'wing-it', title: 'Wing It!', year: 2023 },
];

export const IMAGES = [
  // Big Buck Bunny (Peach). Posters: only the artwork between the top line and the title logo is kept.
  {
    film: 'big-buck-bunny', kind: 'poster', file: 'big-buck-bunny/poster.jpg', commons: 'File:Big buck bunny poster big.jpg',
    crop: { x: 0, y: 0.065, w: 1, h: 0.465 }, removed: `"presents" line, ${POSTER_REMOVED} (Creative Commons Nederland, Digitale Pioniers, Wavemage, Maqina, Filmmore, Blender Institute)`,
  },
  { film: 'big-buck-bunny', kind: 'backdrop', file: 'big-buck-bunny/backdrop.jpg', commons: 'File:Bbb-splash.png' },

  // Elephants Dream (Orange)
  {
    film: 'elephants-dream', kind: 'poster', file: 'elephants-dream/poster.jpg', commons: 'File:ElephantsDreamPoster.jpg',
    crop: { x: 0, y: 0.085, w: 1, h: 0.565 }, focus: { x: 0.55, y: 0.5 }, removed: `"presents" line, ${POSTER_REMOVED}`,
  },
  { film: 'elephants-dream', kind: 'backdrop', file: 'elephants-dream/backdrop.jpg', commons: 'File:Elephants Dream s5 both.jpg', credit: 'orange.blender.org' },

  // Sintel (Durian)
  {
    film: 'sintel', kind: 'poster', file: 'sintel/poster.jpg', commons: 'File:Sintel poster.jpg',
    crop: { x: 0, y: 0.072, w: 1, h: 0.66 }, focus: { x: 0.4, y: 0.5 }, removed: `"presents" line, ${POSTER_REMOVED} (Film Fonds, Blender Foundation, CineGrid, DivX, Dolby Digital)`,
  },
  {
    film: 'sintel', kind: 'backdrop', file: 'sintel/backdrop.jpg',
    studio: { url: 'https://studio.blender.org/files/public/header/project/c0/91/c091f1c8d6aacd18e0285989b69587d3.png', page: 'https://studio.blender.org/projects/sintel/' },
    ...BY4, licenseSource: STUDIO_TERMS, licenseQuote: STUDIO_TERMS_QUOTE, licenseNote: `${STUDIO_TERMS_NOTE} The film itself was released under CC BY 3.0 (durian.blender.org).`,
    author: 'Blender Foundation (Durian open movie project)', credit: '(c) copyright Blender Foundation | durian.blender.org',
  },

  // Tears of Steel (Mango). Commons tags the poster "trademarked": the marks are cut away, the artwork is kept.
  {
    film: 'tears-of-steel', kind: 'poster', file: 'tears-of-steel/poster.jpg', commons: 'File:Tos-poster.png',
    crop: { x: 0, y: 0.155, w: 1, h: 0.685 }, removed: `${POSTER_REMOVED} (Blender Institute, Blender Foundation, Mango, EU flag, Film Fonds)`,
    restrictions: { trademarked: 'The trademarked elements (title logo, Blender, Creative Commons, Mango, Blender Institute, EU and Film Fonds marks) are cropped out; only the artwork between the title and the credit block is used.' },
  },
  { film: 'tears-of-steel', kind: 'backdrop', file: 'tears-of-steel/backdrop.jpg', commons: 'File:Tears of Steel frame 04 3e.jpg' },

  // Cosmos Laundromat (Gooseberry)
  {
    film: 'cosmos-laundromat', kind: 'poster', file: 'cosmos-laundromat/poster.jpg', commons: 'File:CosmosLaundromatPoster.jpg',
    crop: { x: 0, y: 0.075, w: 1, h: 0.68 }, removed: `"presents" lines, ${POSTER_REMOVED} (MEDIA, Garnot, Creative Industries Fund NL, Blender Institute)`,
  },
  { film: 'cosmos-laundromat', kind: 'backdrop', file: 'cosmos-laundromat/backdrop.jpg', commons: 'File:Franck the caterpillar.jpg', focus: { x: 0.55, y: 0.5 }, credit: '(CC) Blender Foundation | gooseberry.blender.org (frame from the film)' },

  // Spring
  { film: 'spring', kind: 'poster', file: 'spring/poster.jpg', commons: 'File:Spring2019PillarPosterBlender.jpg', crop: { x: 0, y: 0.225, w: 1, h: 0.595 }, removed: POSTER_REMOVED },
  { film: 'spring', kind: 'backdrop', file: 'spring/backdrop.jpg', commons: 'File:Spring-concept art-Autumn 02.png', author: 'Blender Foundation (Spring concept art "Autumn 02", uploaded by Andy Goralczyk)', credit: STUDIO_CREDIT },

  // Caminandes: one series, three episodes. The series poster is the "Caminandes: Gran Dillama" (episode 2) poster.
  {
    film: 'caminandes', kind: 'poster', label: 'Caminandes: Gran Dillama (episode 2) poster', file: 'caminandes/poster.jpg',
    crop: { x: 0, y: 0.065, w: 1, h: 0.57 }, focus: { x: 0.62, y: 0.5 }, removed: `"presents" line, ${POSTER_REMOVED}`,
    studio: { url: 'https://studio.blender.org/files/public/thumbnail/e5/e58372aa0af5e669325a4913a46b12561e7d60a8/e58372aa0af5e669325a4913a46b12561e7d60a8.jpg', page: 'https://studio.blender.org/projects/caminandes-2/gallery/?asset=2351', asset: 2351 },
    ...BY4, licenseSource: STUDIO_TERMS, licenseQuote: STUDIO_TERMS_QUOTE, licenseNote: `Asset 2351 ("Poster", Caminandes: Gran Dillama) states "License CC-BY"; the build re-checks it. ${STUDIO_TERMS_NOTE}`,
    author: 'Francesco Siddi / Blender Foundation', credit: STUDIO_CREDIT,
  },
  { film: 'caminandes', kind: 'backdrop', file: 'caminandes/backdrop.jpg', commons: 'File:Caminandes gran dillama.png', credit: 'caminandes.com' },
  { film: 'caminandes', kind: 'backdrop', role: 'episode-1', file: 'caminandes/ep1-llama-drama.jpg', commons: 'File:Pablo Vazquez - Caminandes - Episode 1 - Llama Drama - Cover thumbnail.png', credit: 'caminandes.com (cover frame of Llama Drama)' },
  { film: 'caminandes', kind: 'backdrop', role: 'episode-2', file: 'caminandes/ep2-gran-dillama.jpg', commons: 'File:Blender Foundation - Caminandes - Episode 2 - Gran Dillama - The Earth and the Sun turn dark while Koro accidentally electrocuted by an electric fence.png', credit: 'caminandes.com (frame from Gran Dillama)' },
  { film: 'caminandes', kind: 'backdrop', role: 'episode-3', file: 'caminandes/ep3-llamigos.jpg', commons: 'File:Blender Foundation - Caminandes - Episode 3 - Llamigos - Koro and Oti share more food to eat at night.png', credit: 'caminandes.com (frame from Llamigos)' },

  // Glass Half: no poster published under CC, so a portrait crop of a 4K still (Min's portrait frame)
  { film: 'glass-half', kind: 'poster', file: 'glass-half/poster.jpg', commons: 'File:Glass Half - screenshot-Min and Max artwork style.png', crop: { x: 0.672, y: 0.08, w: 0.3, h: 0.8 }, credit: `${STUDIO_CREDIT} (frame from the film)` },
  { film: 'glass-half', kind: 'backdrop', file: 'glass-half/backdrop.jpg', commons: 'File:Glass Half - screenshot-Min and Max artwork nature.png', credit: `${STUDIO_CREDIT} (frame from the film)` },

  // Hero: no CC poster either, a portrait crop of a 2048x858 still (so the poster is upscaled from 572x858)
  { film: 'hero', kind: 'poster', file: 'hero/poster.jpg', commons: 'File:Hero - screenshot-hero red.png', crop: { x: 0.33, y: 0, w: 0.2793, h: 1 }, credit: `${STUDIO_CREDIT} (frame from the film)` },
  {
    film: 'hero', kind: 'backdrop', file: 'hero/backdrop.jpg',
    studio: { url: 'https://studio.blender.org/files/public/header/project/2e/cb/2ecb2976719298685517e7a559f7f770.png', page: 'https://studio.blender.org/projects/hero/' },
    ...BY4, licenseSource: STUDIO_TERMS, licenseQuote: STUDIO_TERMS_QUOTE, licenseNote: `${STUDIO_TERMS_NOTE} The Hero gallery stills are individually marked CC-BY.`,
    author: 'Daniel Martinez Lara / Blender Foundation', credit: STUDIO_CREDIT,
  },

  // Coffee Run
  {
    film: 'coffee-run', kind: 'poster', file: 'coffee-run/poster.jpg', commons: 'File:Coffee Run-movie poster.png',
    crop: { x: 0, y: 0, w: 1, h: 0.7 }, removed: POSTER_REMOVED, author: 'Hjalti Hjálmarsson / Blender Foundation', credit: STUDIO_CREDIT,
  },
  {
    film: 'coffee-run', kind: 'backdrop', file: 'coffee-run/backdrop.jpg', focus: { x: 0.55, y: 0.5 },
    studio: { url: 'https://studio.blender.org/files/public/header/project/7a/43/7a43fa6b0bc44e62f1cbb21473800e07.png', page: 'https://studio.blender.org/projects/coffee-run/' },
    ...BY4, licenseSource: 'https://studio.blender.org/projects/coffee-run/pages/licensing/', licenseQuote: 'The content of the Coffee Run project is released under the Creative Commons Attribution 4.0 license', licenseNote: LOGOS_NOTE('Coffee Run', false),
    author: 'Blender Foundation (Coffee Run, dir. Hjalti Hjálmarsson)', credit: STUDIO_CREDIT,
  },

  // Sprite Fright
  {
    film: 'sprite-fright', kind: 'poster', file: 'sprite-fright/poster.jpg', commons: 'File:Sprite Fright-movie poster.jpg',
    crop: { x: 0, y: 0.06, w: 1, h: 0.58 }, focus: { x: 0.47, y: 0.5 }, removed: `tagline, ${POSTER_REMOVED}`, author: 'Blender Studio', credit: STUDIO_CREDIT,
  },
  {
    film: 'sprite-fright', kind: 'backdrop', file: 'sprite-fright/backdrop.jpg', focus: { x: 0.7, y: 0.5 },
    studio: { url: 'https://studio.blender.org/files/public/header/project/ff/3d/ff3d8a8048e767cbc92d6489404924b2.jpg', page: 'https://studio.blender.org/projects/sprite-fright/' },
    ...BY4, licenseSource: STUDIO_TERMS, licenseQuote: STUDIO_TERMS_QUOTE, licenseNote: STUDIO_TERMS_NOTE,
    author: 'Blender Studio', credit: STUDIO_CREDIT,
  },

  // Charge
  {
    film: 'charge', kind: 'poster', file: 'charge/poster.jpg', commons: 'File:Charge-movie poster.jpg',
    crop: { x: 0, y: 0, w: 1, h: 0.74 }, removed: POSTER_REMOVED, author: 'Blender Studio', credit: STUDIO_CREDIT,
  },
  {
    film: 'charge', kind: 'backdrop', file: 'charge/backdrop.jpg', focus: { x: 0.75, y: 0.5 },
    studio: { url: 'https://studio.blender.org/files/public/header/project/f6/76/f67601c6f69b2d7f65a5e5d97e73c4d7.png', page: 'https://studio.blender.org/projects/charge/' },
    ...BY4, licenseSource: STUDIO_TERMS, licenseQuote: STUDIO_TERMS_QUOTE, licenseNote: `${STUDIO_TERMS_NOTE} The Charge gallery assets are individually marked CC-BY.`,
    author: 'Blender Studio', credit: STUDIO_CREDIT,
  },

  // Wing It!
  {
    film: 'wing-it', kind: 'poster', label: 'Wing It! poster, textless paintover preview', file: 'wing-it/poster.jpg', crop: { x: 0.004, y: 0, w: 0.32, h: 1 },
    // The "Creating the poster for Wing It!" article shows the textless paintover preview, the same with
    // title and credits, and the final poster side by side (3393x1600); the crop keeps the left panel,
    // which has no title, credits or logos. The image sits behind a short-lived signed URL; the build
    // re-reads the article and picks it by its content hash.
    studio: { blog: 'https://studio.blender.org/blog/creating-the-poster-for-wing-it/', hash: 'd0cf190a2bc98aa8b42e9e2eabc0ad10', page: 'https://studio.blender.org/blog/creating-the-poster-for-wing-it/' },
    removed: 'the two right-hand panels, which carry the title, credits and logos (the textless left panel is kept)',
    ...BY4, licenseSource: WING_IT_LICENSING, licenseQuote: WING_IT_QUOTE, licenseNote: LOGOS_NOTE('Wing It!', true),
    author: 'Rik Schutte, Vivien Lulkowski / Blender Studio', credit: STUDIO_CREDIT,
  },
  {
    film: 'wing-it', kind: 'backdrop', file: 'wing-it/backdrop.jpg',
    studio: { url: 'https://studio.blender.org/files/public/header/project/1c/60/1c60961bd2b161e546343de8022b05c9.jpg', page: 'https://studio.blender.org/projects/wing-it/' },
    ...BY4, licenseSource: WING_IT_LICENSING, licenseQuote: WING_IT_QUOTE, licenseNote: LOGOS_NOTE('Wing It!', true),
    author: 'Blender Studio', credit: STUDIO_CREDIT,
  },
];

export const SIZES = { poster: [600, 900], backdrop: [1920, 1080] };
export const JPEG_QUALITY = { poster: 0.86, backdrop: 0.8 };
