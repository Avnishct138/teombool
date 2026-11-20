#!/usr/bin/env node
/**
 * Copies the standalone single-file build of the app into dist/ so it can be
 * opened straight from disk (file://) — the Worker version is the same app
 * plus the API client, which degrades gracefully when the API is unreachable.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const out = resolve(root, 'dist');
mkdirSync(out, { recursive: true });

const html = readFileSync(resolve(root, 'src/app.html'), 'utf8');
writeFileSync(resolve(out, 'te-o-bool.html'), html);
console.log('built dist/te-o-bool.html');
