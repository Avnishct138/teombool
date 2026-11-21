#!/usr/bin/env node
/**
 * Re-download the pre-existing `teom` static assets into public/.
 * The `teom` Worker shares its hostname with an existing site, so those files
 * must be present in public/ on every deploy or they will 404.
 *
 *   node scripts/fetch-original-assets.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = process.env.TEOM_ORIGIN || 'https://teom.avnishchandrathapliyal.workers.dev';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

for (const [urlPath, outPath] of FILES) {
  const res = await fetch(ORIGIN + urlPath, { redirect: 'follow' });
  if (!res.ok) { console.error(`skip ${urlPath} → ${res.status}`); continue; }
  const buf = Buffer.from(await res.arrayBuffer());
  // Binary assets (PNG) must be stored raw — base64 text breaks the image.
  const dest = resolve(root, 'public', outPath);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  console.log(`saved public/${outPath}  (${buf.length} bytes)`);
}
