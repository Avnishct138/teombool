#!/usr/bin/env node
/**
 * Regression test for the duplicated-homepage-nav bug.
 *
 * Root cause: the original `teom` Worker injects a block of nav chips into
 * `nav.navlinks` on every request to `/` and `/index.html`. The asset that was
 * uploaded to public/ had been downloaded from the live site, so it already
 * contained that injected block — and the Worker injected it a second time,
 * making every chip appear twice on the homepage.
 *
 * This test asserts that public/index.html carries NO injected chip, i.e. it is
 * the pristine pre-injection asset, and that the strip helper is idempotent.
 *
 *   node scripts/test-nav-injection.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripInjectedNavChips } from './fetch-original-assets.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

// 1. the deployed asset must contain NO injected chip — the Worker adds them
//    at request time. A chip baked into the asset renders twice.
const indexPath = resolve(root, 'public', 'index.html');
check('public/index.html exists', existsSync(indexPath));
const index = readFileSync(indexPath, 'utf8');
const navOpen = /<nav\b[^>]*\bclass="[^"]*\bnavlinks\b[^"]*"[^>]*>/i.exec(index);
check('index.html has nav.navlinks', !!navOpen);

const inner = index.slice(navOpen.index + navOpen[0].length, index.indexOf('</nav>', navOpen.index));
// count chip anchors by href — the chip's real identity. (Matching on visible
// text would double-count, because each chip spells its label in both the
// aria-label attribute and the link text.)
const CHIP_HREFS = {
  'पृथ्वी': '/hi/पृथ्वी-दिवस',
  '3D view Earth': '/hi/earthday-3d',
  'NCERT अध्ययन': '/hi/ncert',
  'उत्तराखंड बोर्ड': '/hi/uttarakhand-board/class-9/study-guide',
  'OS Web': '/web-os',
  'AGNi': '/hi/agni',
};
const countByHref = (html, href) =>
  (html.match(new RegExp('<a\\b[^>]*href="' + href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"', 'g')) || []).length;
for (const [label, href] of Object.entries(CHIP_HREFS)) {
  const n = countByHref(inner, href);
  check(`asset carries no baked-in "${label}" chip`, n === 0, `found ${n}`);
}

// 2. the five original nav links must survive untouched
for (const [label, re] of [
  ['परिचय', />परिचय<\/a>/], ['JIT', />JIT<\/a>/], ['सत्यापन', />सत्यापन<\/a>/],
  ['फ़ाइलें', />फ़ाइलें<\/a>/], ['सीमाएँ', />सीमाएँ<\/a>/],
]) {
  check(`original nav link "${label}" present`, re.test(inner));
}

// 2b. the Te'o bool entry point must be reachable from the homepage, exactly once
check('homepage nav links to /hi/teombool exactly once',
  countByHref(inner, '/hi/teombool') === 1, `found ${countByHref(inner, '/hi/teombool')}`);
check('homepage has a hero CTA to /hi/teombool',
  (index.match(/href="\/hi\/teombool"/g) || []).length === 2,
  `found ${(index.match(/href="\/hi\/teombool"/g) || []).length} links (1 nav + 1 hero)`);

// 3. the strip helper is idempotent and removes injected chips
const once = stripInjectedNavChips(index);
check('strip() on a pristine asset removes nothing', once.removed === 0, `removed ${once.removed}`);
check('strip() leaves the asset byte-identical', once.html === index);
const twice = stripInjectedNavChips(once.html);
check('strip() is idempotent', twice.html === once.html && twice.removed === 0);

// 4. a synthetic page that mimics the Worker injection must be fully cleaned
const injected = index.replace('</nav>', '<a href="/web-os" aria-label="Open Te\'oM OS Web">OS Web</a><a href="/hi/agni" aria-label="AGNi">AGNi</a></nav>');
const cleaned = stripInjectedNavChips(injected);
check('strip() removes an injected chip block', cleaned.removed === 2, `removed ${cleaned.removed}`);
check('strip() restores the pristine page', cleaned.html === index);

// 4b. end-to-end: the page the Worker will serve must show each chip ONCE
const WORKER_INJECTION = [
  '<a href="/hi/पृथ्वी-दिवस" aria-label="पृथ्वी दिवस">पृथ्वी</a>',
  '<a href="/hi/earthday-3d" aria-label="3D view Earth" style="x">3D view Earth 🌎</a>',
  '<a href="/hi/ncert" aria-label="NCERT अध्ययन और पाठ खोजें" style="x">NCERT अध्ययन</a>',
  '<a href="/hi/uttarakhand-board/class-9/study-guide" aria-label="उत्तराखंड बोर्ड कक्षा 9 अध्ययन-सहायिका" style="x">उत्तराखंड बोर्ड · कक्षा 9</a>',
  '<a href="/web-os" aria-label="Open Te\'oM OS Web">OS Web</a>',
  '<a href="/hi/agni" aria-label="AGNi — Accelerated Generative Neural Inference">AGNi</a>',
].join('');
const served = index.replace('</nav>', WORKER_INJECTION + '</nav>');
for (const [label, href] of Object.entries(CHIP_HREFS)) {
  const n = countByHref(served, href);
  check(`served page shows "${label}" exactly once`, n === 1, `found ${n}`);
}
const servedNav = served.split('<nav class="navlinks"')[1].split('</nav>')[0];
check('served nav links to /hi/teombool exactly once',
  countByHref(servedNav, '/hi/teombool') === 1, `found ${countByHref(servedNav, '/hi/teombool')}`);

// 5. pages that are never injected must be left alone
for (const f of ['public/jit.html']) {
  const p = resolve(root, f);
  if (!existsSync(p)) { check(`${f} exists`, false); continue; }
  const r = stripInjectedNavChips(readFileSync(p, 'utf8'));
  check(`${f} is not modified by strip()`, r.removed === 0 && r.html === readFileSync(p, 'utf8'));
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
