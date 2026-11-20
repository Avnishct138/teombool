# Te'o bool

**स्पष्टता का सार** — a decision-clarity chat window that runs on Cloudflare Workers.

Ask a question in Hindi, get a verdict, two options with pros and cons, and a next step.
Behind it sits a hand-written **SVG oracle stage** (frosted-glass prisms + a glossy 8-ball)
and the same answer rendered a second time as **ASCII** in a live console.

Live: **https://teom.avnishchandrathapliyal.workers.dev/hi/teombool**

---

## What's in here

| Path | What it is |
|---|---|
| `src/app.html` | The whole app — markup, CSS and JS in one file. Single-page, no build tooling, no dependencies. |
| `src/gate.html` | The standalone "पता डालो" page. Shown when a shared link is opened from a different IP, or when the interface itself is locked. |
| `src/worker.js` | Route shim + the share/owner API. This is the only new logic on the Worker. |
| `src/original-teom.mjs` | The pre-existing `teom` Worker bundle, **verbatim**. Everything it served still works. |
| `public/` | The pre-existing static assets of the `teom` site, byte-for-byte. Re-deployed as-is so nothing 404s. |
| `src/generated/` | Build output (`build.mjs` inlines the HTML into JS modules). Regenerated, not hand-edited. |
| `wrangler.toml` | Bindings, assets config and rate limiters — a faithful copy of the live worker plus the new ones. |
| `build.mjs` | Inlines `app.html` / `gate.html` into `src/generated/*.js`. |
| `build-standalone.mjs` | Writes `dist/te-o-bool.html` — the app as one portable file you can open straight from disk. |

## Routes added

```
GET  /hi/teombool                → the app (gated by the owner address, if one is set)
GET  /hi/teombool/api/state      → { locked, isOwner }
POST /hi/teombool/api/claim      → bind a 🪪 user ID to this IP
POST /hi/teombool/api/share      → create a short share link + its पता
GET  /hi/teombool/api/share/:id  → resolve a share (same IP, or with the पता)
POST /hi/teombool/api/unlock     → exchange the पता for a 30-day cookie
POST /hi/teombool/api/owner      → set / change / remove the owner पता
GET  /s/:id                      → short share link → share page or पता prompt
```

Every other route is delegated untouched to `src/original-teom.mjs`.

## The पता (address) model

- **Sharing** produces a short link (`/s/bool-9926`) plus a **पता** (`NOVA-8326`).
- The link opens directly for the **same IP**. From any **other IP** it asks for the पता;
  the correct पता unlocks it. Wrong attempts are rate-limited and rejected.
- The **owner पता** is optional and separate: set it in *सेटिंग्स → पता सुरक्षा* to lock the
  whole interface. From another IP the app then shows the same पता prompt, and a 30-day
  signed cookie (`HttpOnly`, `SameSite=Lax`, `Secure`) keeps the browser unlocked.
- The 🪪 **user ID** (`TB-4WV9-JXZC`) is minted in the browser, bound to the IP on the server,
  and **never** appears in a shared URL — shares only ever carry a share ID.

The पता is stored as a SHA-256 hash, never in plaintext. Share records live in KV with a
7-day TTL; the owner record with a 1-year TTL.

## Deploying

```bash
npm install
npm run build
npx wrangler deploy --keep-vars
```

`--keep-vars` matters: `COMMUNITY_TURNSTILE_SECRET` is a dashboard secret and is not in
`wrangler.toml`. Without the flag, Wrangler would delete it.

The `teom` Worker is shared with an existing site, so the deploy must keep every binding and
every asset. `public/` holds the original assets; `scripts/fetch-original-assets.mjs` can
re-download them from the live Worker if you ever need to rebuild that directory.

## Interactive APIs used

`SpeechRecognition` (hi-IN) · `speechSynthesis` · `Clipboard` · `Share` · `Vibration` ·
`localStorage` · `crypto.randomUUID` · `History` · `AudioContext` · `Notifications` ·
`HTMLRewriter` · Workers KV · Workers D1 · Workers AI · native rate limiters.

The *स्रोत* tab reports which of them are actually available in the current browser.

## Notes

- Fonts (Baloo 2, Mukta, JetBrains Mono) load from Google Fonts; Devanagari falls back to the
  system UI font offline.
- The ASCII art is strictly 7-bit on purpose — Google's *latin* subset ships no block or
  box-drawing glyphs, so `█` would fall back to a font with a different advance width and
  the wordmark would break.
