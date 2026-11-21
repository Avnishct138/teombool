# AGNi Development Assistant — client assets

Three static files, served by the Cloudflare Worker and injected into the existing
AGNi pages (`/hi/agni` and `/hi/agni/lab`). Nothing on the host pages is modified.

| file | served as | purpose |
|---|---|---|
| `panel.html` | (inlined into the page `<body>`) | markup of the panel; no `<script>`, no `<style>` |
| `assistant.css` | `GET /api/agni/assistant/client.css` | styles only (AGNi design tokens) |
| `assistant.js` | `GET /api/agni/assistant/client.js` | behaviour only; classic script, loaded with `defer` |

## How the Worker serves them

1. The Worker reads the three files from `src/agni/client/` at request time
   (or bundles them at build time — either way the bytes are identical).
2. `GET /api/agni/assistant/client.js` → `assistant.js`
   `GET /api/agni/assistant/client.css` → `assistant.css`
   Both are returned with `cache-control: public, max-age=300`,
   `x-content-type-options: nosniff` and respectively
   `content-type: application/javascript; charset=utf-8` /
   `content-type: text/css; charset=utf-8`.
3. For the two AGNi pages only, the Worker injects into `<body>`:

   ```html
   <section id="agni-dev-assistant" data-agni-page="agni|agni-lab"> … panel.html … </section>
   <link rel="stylesheet" href="/api/agni/assistant/client.css">
   <script src="/api/agni/assistant/client.js" defer></script>
   ```

   `assistant.js` sets `data-agni-page` itself at runtime (`agni` or `agni-lab`)
   from `location.pathname`, so the injected value is only a placeholder.
4. The panel is inert until it is loaded: a fixed launcher button appears in the
   bottom-right corner; the panel itself is `hidden` until the launcher is clicked.
   On wide screens the panel is a fixed right drawer, on narrow screens a bottom sheet.
   The launcher and panel are `position: fixed`, so the host page layout never shifts.

## API used by the client

Only the endpoints of `docs/assistant-ui-contract.md`:

- `POST /api/agni/assistant/challenge`
- `POST /api/agni/assistant/chat`
- `POST /api/agni/assistant/approve`

No other network calls are made from the browser.

## Rules kept in the client

- Nothing is applied without an explicit **Approve**; only then is `payload`
  written back into the Lab playground (`#w1`, `#b1`, `#w2`, `#b2`, `#hidden-activation`,
  `#output-activation`) and `#run` is triggered so the result is visible at once.
- Context is read from the live page on **every** message
  (`#x1..#x4` or the shipped `#x0..#x3`, `#w1/#b1/#w2/#b2`, `#hidden-activation`,
  `#output-activation`); weights are parsed defensively as JSON — if parsing fails,
  no weights are sent and `projectState.dirty` is set to `true`.
- All DOM is built with `createElement` / `textContent`; no `eval`, no `innerHTML`
  with model output, no `document.write`.
- All user-visible copy is Hindi (Devanagari); English technical terms
  (forward pass, weights, bias, activation, tool, preview) stay in English.
