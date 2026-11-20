#!/usr/bin/env node
/**
 * Build step: inline the HTML pages into ES modules so the Worker can serve
 * them. Keeping app.html / gate.html as real files keeps the repo readable;
 * this script is the only thing that turns them into Worker modules.
 *
 *   node build.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const out = resolve(root, 'src/generated');
mkdirSync(out, { recursive: true });

// The pre-existing teom Worker bundle is stored gzipped + base64 so the repo
// stays small; expand it back to a plain module before bundling.
const vendored = resolve(root, 'src/original-teom.mjs.gz.b64');
const vendoredOut = resolve(root, 'src/original-teom.mjs');
if (existsSync(vendored)) {
  const { gunzipSync } = await import('node:zlib');
  const buf = gunzipSync(Buffer.from(readFileSync(vendored, 'utf8').trim(), 'base64'));
  writeFileSync(vendoredOut, buf);
  console.log(`expanded src/original-teom.mjs  (${buf.length} bytes)`);
}

const pages = [
  ['app.html', 'app-html.js', 'APP_HTML'],
  ['gate.html', 'gate-html.js', 'GATE_HTML'],
];

for (const [src, dest, name] of pages) {
  const html = readFileSync(resolve(root, 'src', src), 'utf8');
  const js = `// AUTO-GENERATED from src/${src} by build.mjs — do not edit.\nexport const ${name} = ${JSON.stringify(html)};\nexport default ${name};\n`;
  writeFileSync(resolve(out, dest), js);
  console.log(`built src/generated/${dest}  (${html.length} bytes of markup)`);
}
