/**
 * AGNi Development Assistant — page injection.
 *
 * The AGNi pages themselves are NOT rewritten here. The original Worker still
 * owns `/hi/agni` and `/hi/agni/lab`; this module only:
 *
 *   1. asks the original Worker for the page,
 *   2. appends the assistant panel markup + its own script/style tags,
 *   3. widens the CSP just enough to allow the same-origin assistant script
 *      and its same-origin API calls (`connect-src 'self'`),
 *   4. marks the response as not cacheable (the injected panel is dynamic).
 *
 * Everything the original Worker does — the legacy `#agni-ai-chat` widget, the
 * CSP hardening, the lab playground maths — is left exactly as it was.
 */

import { ASSISTANT_HTML, ASSISTANT_CSS, ASSISTANT_JS } from '../generated/assistant-assets.js';

export const ASSISTANT_API_BASE = '/api/agni/assistant';

const ASSET_HEADERS = {
  'cache-control': 'public, max-age=300',
  'x-content-type-options': 'nosniff',
};

/**
 * Add 'self' to script-src / connect-src so the assistant can load and call
 * same-origin resources. `connect-src 'none'` is replaced (a directive may not
 * combine 'none' with other sources).
 */
export function augmentCsp(csp) {
  const base = csp || "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'";
  const directives = base
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);

  const seen = new Set();
  const out = [];
  for (const directive of directives) {
    const name = directive.split(/\s+/)[0].toLowerCase();
    seen.add(name);
    if (name === 'script-src') {
      const sources = directive.split(/\s+/).slice(1);
      out.push(sources.includes("'self'") ? directive : `${directive} 'self'`);
      continue;
    }
    if (name === 'connect-src') {
      const sources = directive.split(/\s+/).slice(1);
      if (sources.length === 1 && sources[0] === "'none'") {
        out.push("connect-src 'self'");
      } else {
        out.push(sources.includes("'self'") ? directive : `${directive} 'self'`);
      }
      continue;
    }
    out.push(directive);
  }
  if (!seen.has('connect-src')) out.push("connect-src 'self'");
  return out.join('; ');
}

/** Append the assistant panel to the page body. */
export function injectAssistant(html) {
  if (typeof html !== 'string' || !html.includes('</body>')) return html;
  const block = [
    ASSISTANT_HTML,
    `<style>${ASSISTANT_CSS}</style>`,
    '<script src="/api/agni/assistant/client.js" defer></script>',
  ].join('\n');
  return html.replace('</body>', `${block}\n</body>`);
}

/** Wrap an upstream HTML response with the assistant panel + widened CSP. */
export function withAssistant(upstream) {
  const contentType = upstream.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return upstream;

  const headers = new Headers(upstream.headers);
  headers.set('content-security-policy', augmentCsp(headers.get('content-security-policy')));
  headers.set('cache-control', 'no-store');
  headers.set('x-agni-assistant', '1');

  const transformed = new HTMLRewriter()
    .on('body', {
      element(element) {
        element.append(ASSISTANT_HTML, { html: true });
        element.append(`<style>${ASSISTANT_CSS}</style>`, { html: true });
        element.append('<script src="/api/agni/assistant/client.js" defer></script>', { html: true });
      },
    })
    .transform(upstream);

  return new Response(transformed.body, { status: upstream.status, headers });
}

/* ── static client assets ─────────────────────────────────────────────── */

export function assistantAsset(kind) {
  if (kind === 'js') {
    return new Response(ASSISTANT_JS, {
      headers: {
        ...ASSET_HEADERS,
        'content-type': 'application/javascript; charset=utf-8',
        'content-security-policy': "default-src 'none'",
      },
    });
  }
  if (kind === 'css') {
    return new Response(ASSISTANT_CSS, {
      headers: { ...ASSET_HEADERS, 'content-type': 'text/css; charset=utf-8' },
    });
  }
  return null;
}
