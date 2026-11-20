#!/usr/bin/env node
/**
 * Build step: inline the HTML pages into ES modules so the Worker can serve
 * them. Keeping app.html / gate.html as real files keeps the repo readable;
 * this script is the only thing that turns them into Worker modules.
 *
 *   node build.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const out = resolve(root, 'src/generated');
mkdirSync(out, { recursive: true });

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
