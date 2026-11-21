# AGNi Development Assistant — UI Contract (authoritative)

The backend is built against this document. Do not change the API shapes or the DOM ids
without updating this file in the same change.

## Where the UI lives

The assistant UI is injected by the Worker into the **existing** AGNi pages:

- `/hi/agni` (AGNi main page)
- `/hi/agni/lab` (AGNi Lab · Neural Network Playground)

Nothing else on those pages may change: no removal, no reordering, no restyle of existing
sections, no edit of the legacy `#agni-ai-chat` widget (that one keeps working untouched).

## Files

- `src/agni/client/panel.html` — markup of the assistant panel (no `<script>`, no `<style>`).
- `src/agni/client/assistant.css` — styles only.
- `src/agni/client/assistant.js` — behaviour only. Must work when loaded with `defer`.

The Worker serves them as:

- `GET /api/agni/assistant/client.js` → `assistant.js`
- `GET /api/agni/assistant/client.css` → `assistant.css`

and injects `panel.html` + `<link rel="stylesheet" href="/api/agni/assistant/client.css">` +
`<script src="/api/agni/assistant/client.js" defer></script>` into `<body>` of both AGNi pages.

## DOM contract (ids the backend/JS rely on)

Root element: `<section id="agni-dev-assistant" data-agni-page="agni|agni-lab">`

Inside it:

| id | purpose |
|---|---|
| `agni-assistant-toggle` | button that opens/closes the panel |
| `agni-assistant-panel` | the panel body (hidden when closed) |
| `agni-assistant-messages` | scrollable chat log, `role="log"` |
| `agni-assistant-form` | chat form |
| `agni-assistant-input` | textarea for the user message (`maxlength=4000`) |
| `agni-assistant-send` | submit button |
| `agni-assistant-challenge-question` | text of the human-check question |
| `agni-assistant-challenge-answer` | numeric input for the challenge answer |
| `agni-assistant-challenge-refresh` | button → fetch a new challenge |
| `agni-assistant-status` | `role="status"` line for errors / progress |
| `agni-assistant-context` | container for project-context chips |
| `agni-assistant-tools` | container for tool-execution status rows |
| `agni-assistant-preview` | container for code/change preview blocks |
| `agni-assistant-teaching-toggle` | checkbox that enables Teaching Mode |
| `agni-assistant-nexi` | container for the NEXI Penguin mascot (SVG) |
| `agni-assistant-nexi-status` | text line under the mascot (what NEXI is doing) |
| `agni-assistant-settings` | button that opens the settings window |
| `agni-assistant-settings-window` | the settings window (hidden by default) |
| `agni-assistant-api-key` | password input for the user's own API key |
| `agni-assistant-base-url` | provider select (allow-listed base URLs only) |
| `agni-assistant-model` | model id input |
| `agni-assistant-save-key` | checkbox: persist the key in localStorage (default off) |
| `agni-assistant-settings-save` / `-clear` / `-close` | save / clear / close buttons |
| `agni-assistant-settings-status` | status line inside the settings window |

Message bubbles use `data-role="user" | "assistant" | "system"` and `data-error="true"` on errors.

## API

All calls are `POST` with `Content-Type: application/json` unless stated.

### `POST /api/agni/assistant/challenge`

Request: `{}`
Response: `{ "id": "32 hex chars", "question": "3 + 4 = ?" }`

### `POST /api/agni/assistant/chat`

Request:

```json
{
  "message": "string, required, <= 4000 chars",
  "challenge": { "id": "hex32", "answer": "7" },
  "page": "agni" | "agni-lab",
  "teachingMode": true,
  "context": {
    "model": { "architecture": "4-16-3", "hiddenActivation": "relu", "outputActivation": "softmax" },
    "inputs": [1, 0, 1, 0],
    "weights": { "w1": [[...]], "b1": [...], "w2": [[...]], "b2": [...] },
    "projectState": { "lastRun": "...", "hasRun": true, "dirty": false }
  },
  "history": [{ "role": "user" | "assistant", "content": "..." }],
  "settings": { "apiKey": "sk-…", "baseUrl": "https://api.xkiro.com/v1", "model": "mistralai/mistral-small-2603" }
}
```

`settings` is optional. `apiKey` is used for that request only — it is never stored, never logged
and never returned; `baseUrl` is ignored unless it is on the provider allow-list.

Response:

```json
{
  "ok": true,
  "reply": "assistant text (may contain markdown-ish plain text)",
  "teaching": "optional extra explanation when teachingMode was on",
  "toolCalls": [
    { "name": "agni.forward_pass", "status": "ok" | "error", "input": {}, "result": {}, "ms": 12 }
  ],
  "proposal": {
    "id": "hex16",
    "kind": "weights" | "activation" | "architecture" | "code",
    "title": "short title",
    "summary": "what will change and why",
    "diff": [{ "path": "b1[3]", "before": "0.12", "after": "-0.04" }],
    "payload": { "type": "set-weights", "b1": [...] },
    "expiresAt": 1730000000000
  },
  "errors": ["string"]
}
```

### `POST /api/agni/assistant/approve`

Request: `{ "proposalId": "hex16", "approve": true }`
Response: `{ "ok": true, "approved": true, "payload": { ... } }` — `payload` is the change the
client applies locally (never auto-applied by the server).

### `GET /api/agni/assistant/tools`

Response: `{ "tools": [{ "name": "...", "description": "...", "inputSchema": {...} }] }`

## Behaviour rules

1. **Nothing is applied without approval.** A `proposal` renders as a preview block with
   *Approve* / *Reject* buttons. Approve posts to `/approve`; only on success does the client
   apply `payload` to the page state and say so.
2. **Context is read from the page, not guessed.** On `/hi/agni/lab` read the live playground
   values: `#x1..#x4` inputs, `#w1`, `#b1`, `#w2`, `#b2` textareas, `#hidden-activation`,
   `#output-activation`. On `/hi/agni` send `projectState` with the current visible section only.
   Send context with every message.
3. **Tool status is visible.** Every tool call is rendered as a row in `#agni-assistant-tools`
   with the tool name, ok/error state and a one-line result summary.
4. **Errors are surfaced, never swallowed.** Any non-2xx response shows `data-error="true"`
   bubble with the server message.
5. **NEXI Penguin** is a small inline SVG mascot in `#agni-assistant-nexi`; `#agni-assistant-nexi-status`
   reflects the current state (`idle`, `thinking`, `running tool`, `error`, `done`). It is decorative
   but must have `aria-hidden="true"` and must never block interaction.
6. **Teaching Mode** is a checkbox. When on, the request sets `teachingMode: true` and the server
   returns an extra `teaching` block, rendered as a distinct "शिक्षण" bubble.
7. All user-visible text is **Hindi (Devanagari)**, with English technical terms kept in English
   (`forward pass`, `weights`, `bias`, `activation`, `tool`, `preview`).
8. No external network calls from the client other than the two same-origin API paths above.
9. The panel must not break the host page on small screens: use a responsive layout,
   `position: sticky`/fixed launcher, and never overflow horizontally.
10. Style with the AGNi design tokens already used by the pages:
    `--bg:#07111c; --panel:#101d2b; --panel2:#142537; --ink:#eff8ff; --muted:#adbdcc;
    --line:#294255; --cyan:#69e5d0; --blue:#8ab9ff; --amber:#ffd27a; --green:#79e4a2; --red:#ff9b8f;`
    and the same fonts (`system-ui, -apple-system, "Noto Sans Devanagari", Mangal, sans-serif`).
    The AGNi Lab page does **not** define `--green` / `--red`; define fallbacks inside the panel.
11. Do not use `eval`, `innerHTML` with untrusted content, or `document.write`. Build DOM with
    `createElement` / `textContent` so model output can never inject markup.

## Out of scope

- The legacy `#agni-ai-chat` widget and `/api/chat` endpoints.
- Any change to the AGNi Lab playground maths (`core.validateModel`, `core.forwardPass`).
