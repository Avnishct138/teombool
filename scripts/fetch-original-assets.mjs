#!/usr/bin/env node
/**
 * Re-download the pre-existing `teom` static assets into public/.
 * The `teom` Worker shares its hostname with an existing site, so those files
 * must be present in public/ on every deploy or they will 404.
 *
 *   node scripts/fetch-original-assets.mjs
 *
 * IMPORTANT — `/` and `/index.html` are served through an HTMLRewriter in the
 * original Worker that appends a block of nav chips to `nav.navlinks` on every
 * request:
 *
 *     new HTMLRewriter()
 *       .on("nav.navlinks", { element(el){ el.append(dR+fR+hR+mR+WEBOS_NAV_LINK+AGNI_NAV_LINK) } })
 *       .transform(assetResponse)
 *
 * The response you download is therefore NOT the raw file on disk — it already
 * contains that injected block. Re-uploading it verbatim would make the Worker
 * inject the same chips a second time, and every chip would appear twice on
 * the homepage. `stripInjectedNavChips()` removes the injected tail so the
 * saved file matches the original asset byte-for-byte.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ORIGIN = process.env.TEOM_ORIGIN || 'https://teom.avnishchandrathapliyal.workers.dev';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// hrefs of the nav chips the original Worker injects into `nav.navlinks`
const INJECTED_HREFS = new Set([
  '/hi/पृथ्वी-दिवस',
  '/hi/earthday-3d',
  '/hi/ncert',
  '/hi/uttarakhand-board/class-9/study-guide',
  '/web-os',
  '/hi/agni',
]);

/**
 * Remove the Worker-injected chip block from the tail of `nav.navlinks`.
 * The injection is a plain append, so the injected anchors are the trailing
 * run of <a> elements in that nav. Everything before them is the real asset.
 */
export function stripInjectedNavChips(html) {
  const navOpen = /<nav\b[^>]*\bclass="[^"]*\bnavlinks\b[^"]*"[^>]*>/i;
  const m = navOpen.exec(html);
  if (!m) return { html, removed: 0 };
  const innerStart = m.index + m[0].length;
  const innerEnd = html.indexOf('</nav>', innerStart);
  if (innerEnd === -1) return { html, removed: 0 };

  let inner = html.slice(innerStart, innerEnd);
  const original = inner;
  let removed = 0;

  // peel injected anchors off the end, one at a time.
  // NOTE: find the LAST anchor in the nav — a lazy `</a>\s*$` pattern would
  // happily match from the first `<a` all the way to the final `</a>`.
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/g;
  for (;;) {
    let last = null;
    for (let mm; (mm = anchorRe.exec(inner)); ) last = { index: mm.index, attrs: mm[1] };
    if (!last) break;
    const href = /href="([^"]*)"/.exec(last.attrs);
    if (!href || !INJECTED_HREFS.has(href[1])) break;
    inner = inner.slice(0, last.index);
    removed++;
  }

  if (!removed) return { html, removed: 0 };
  return { html: html.slice(0, innerStart) + inner + html.slice(innerEnd), removed };
}

// path on the live site -> file inside public/
const FILES = [
  // NOTE: '/jit.html' 307 → '/jit' (auto-trailing-slash). Fetch the final path so
  // the saved file is the raw asset, not a redirect target.
  ['/jit', 'jit.html'],
  ['/index.html', 'index.html'],
  ['/robots.txt', 'robots.txt'],
  ['/metadata/jit.json', 'metadata/jit.json'],
  ['/metadata/jit.md', 'metadata/jit.md'],
  ['/assets/teom_learning_curves.png', 'assets/teom_learning_curves.png'],
];

async function main() {
for (const [urlPath, outPath] of FILES) {
  const res = await fetch(ORIGIN + urlPath, { redirect: 'follow' });
  if (!res.ok) { console.error(`skip ${urlPath} → ${res.status}`); continue; }
  let buf = Buffer.from(await res.arrayBuffer());
  let removed = 0;
  if (outPath.endsWith('.html')) {
    const stripped = stripInjectedNavChips(buf.toString('utf8'));
    removed = stripped.removed;
    buf = Buffer.from(stripped.html, 'utf8');
  }
  // Binary assets (PNG) must stay raw — base64 text breaks the image.
  const dest = resolve(root, 'public', outPath);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  console.log(`saved public/${outPath}  (${buf.length} bytes${removed ? `, stripped ${removed} injected nav chip(s)` : ''})`);
}
}

// only download when run directly — importing the module must be side-effect free
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main();
}