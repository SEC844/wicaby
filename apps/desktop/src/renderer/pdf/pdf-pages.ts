// pdf.html: draws PDF comic pages for main (src/main/comics/pdf-pages.ts calls window.wicabyPdf).
// The book is read with Range requests on wicaby-media://comic-file, so a remote cover reads only
// what page 1 needs. No text layer, no annotations, no scripts: pages become JPEG images.
import { getDocument, GlobalWorkerOptions, PDFDataRangeTransport, type PDFDocumentLoadingTask, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

// A page drawn bigger than this many pixels is drawn smaller (a forged MediaBox must not exhaust memory).
const MAX_PIXELS = 40_000_000;
// Page sizes are read for at most this many pages; later ones show at the reader's default ratio.
const MAX_SIZES = 2000;
const CHUNK = 256 * 1024;

let current: { url: string; doc: Promise<PDFDocumentProxy>; task?: PDFDocumentLoadingTask } | null = null;

async function range(url: string, begin: number, end: number): Promise<{ data: Uint8Array; total: number }> {
  const res = await fetch(url, { headers: { Range: `bytes=${begin}-${end - 1}` } });
  const m = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '');
  if (res.status !== 206 || !m) throw new Error(`Range refused (HTTP ${res.status})`);
  return { data: new Uint8Array(await res.arrayBuffer()).subarray(0, end - begin), total: Number(m[1]) };
}

function open(url: string): Promise<PDFDocumentProxy> {
  if (current?.url === url) return current.doc;
  void current?.task?.destroy();
  const entry: NonNullable<typeof current> = { url, doc: Promise.resolve(null as never) };
  entry.doc = (async () => {
    const first = await range(url, 0, CHUNK);
    const transport = new PDFDataRangeTransport(first.total, first.data);
    transport.requestDataRange = (begin: number, end: number) => {
      range(url, begin, end).then(
        (r) => transport.onDataRange(begin, r.data),
        () => transport.abort(),
      );
    };
    entry.task = getDocument({ range: transport, rangeChunkSize: CHUNK, disableAutoFetch: true, disableStream: true, enableXfa: false });
    return entry.task.promise;
  })();
  current = entry;
  entry.doc.catch(() => {
    if (current === entry) current = null;
  });
  return entry.doc;
}

async function info(url: string): Promise<{ count: number; sizes: [number, number][] }> {
  const doc = await open(url);
  const sizes: [number, number][] = [];
  for (let i = 1; i <= Math.min(doc.numPages, MAX_SIZES); i++) {
    const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
    sizes.push([Math.round(vp.width), Math.round(vp.height)]);
  }
  return { count: doc.numPages, sizes };
}

async function render(url: string, index: number, height: number): Promise<Uint8Array> {
  const page = await (await open(url)).getPage(index + 1);
  try {
    const base = page.getViewport({ scale: 1 });
    let scale = height / base.height;
    if (base.width * base.height * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (base.width * base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    // 'print': no requestAnimationFrame, which a hidden window may never run.
    await page.render({ canvas, viewport, intent: 'print' }).promise;
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    canvas.width = 0;
    if (!blob) throw new Error('PDF page could not be encoded');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    page.cleanup();
  }
}

declare global {
  interface Window {
    wicabyPdf: { info: typeof info; render: typeof render };
  }
}
window.wicabyPdf = { info, render };
