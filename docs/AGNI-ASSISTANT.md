# AGNi Development Assistant

AGNi project का chat अब सिर्फ "सवाल-जवाब" chatbot नहीं — यह एक **development agent** है:
सोचता है → plan बनाता है → अनुमत tools चलाता है → जाँचता है → समझाता है।

यह implementation `/hi/agni` और `/hi/agni/lab` दोनों pages में एकीकृत है, और original
`teom` Worker की कोई भी existing file (legacy `#agni-ai-chat` widget, `/api/chat`,
`AI_MODEL` binding, human-check challenge, 10 req/60 s rate limiter) बदली नहीं गई।

---

## 1. Architecture

```
Browser (AGNi page)
  └─ panel.html + assistant.css (inline) + assistant.js (same-origin script)
       ├─ POST /api/agni/assistant/challenge   → human-check (गणित का सवाल)
       ├─ POST /api/agni/assistant/chat         → assistant turn
       │     └─ tools → Tool Registry (allow-list) → deterministic AGNi math
       ├─ POST /api/agni/assistant/approve      → approved change (single use)
       └─ GET  /api/agni/assistant/tools        → registry (public descriptors)
Worker (src/worker.js — existing teombool shim)
  ├─ /hi/agni, /hi/agni/lab → original Worker से page + assistant panel inject
  └─ /api/agni/assistant/* → src/agni/routes.mjs
        ├─ context.mjs   → project context (untrusted, capped, sanitised)
        ├─ llm.mjs       → OpenAI-compatible LLM (xKiro) + tool loop
        ├─ tools.mjs     → tool registry (the allow-list)
        ├─ sandbox.mjs   → restricted math-DSL interpreter (no eval)
        ├─ proposals.mjs → KV-backed, single-use preview → approval
        └─ math-core.mjs → AGNi maths (browser core का 1:1 mirror)
```

### अपनी API key (settings window)

पैनल header में ⚙ बटन → **API सेटिंग्स** window:

| Field | क्या करता है |
|---|---|
| **API key** | आपकी अपनी key (OpenAI-compatible) — खाली छोड़ने पर Worker का secret इस्तेमाल होता है |
| **Provider** | allow-listed base URL (xKiro, OpenAI, MiniMax, Groq, DeepSeek, OpenRouter) |
| **Model** | model id, e.g. `mistralai/mistral-small-2603` |
| **इस browser में सेव करें** | default **बंद** — key सिर्फ़ page session में रहती है (reload पर मिट जाती है); चेक करने पर `localStorage` में रहती है |

Key सिर्फ़ chat request के साथ server को जाती है — server उसे **सेव, लॉग या browser वापस नहीं**
करता (response में सिर्फ़ `meta.usingUserKey: true/false` आता है), और error message से भी scrub
हो जाती है। Provider URL allow-list में है, ताकि browser से दी गई किसी भी URL पर server request
न कर सके (SSRF guard)।

### Files

| File | भूमिका |
|---|---|
| `src/agni/math-core.mjs` | 4→16→3 forward pass, activations, SGD training step, 1-bit quantisation, weight stats |
| `src/agni/schema.mjs` | JSON-Schema subset validator (tool input validation) |
| `src/agni/tools.mjs` | **Tool Registry** — name, description, inputSchema, validation, handler, result |
| `src/agni/sandbox.mjs` | सुरक्षित code execution — बिना `eval` के restricted DSL interpreter |
| `src/agni/context.mjs` | project context builder + system prompt (AGNi "no fake claims" नियम) |
| `src/agni/llm.mjs` | LLM client (OpenAI-compatible) + tool-calling loop + Workers AI fallback |
| `src/agni/proposals.mjs` | preview → approval (KV, 15 min TTL, single use) |
| `src/agni/routes.mjs` | HTTP handlers |
| `src/agni/inject.mjs` | page injection + CSP widening |
| `src/agni/client/*` | UI: panel, styles, behaviour (chat + settings window) |
| `tests/*.test.mjs` | 33 unit + integration tests (`node --test`) |

---

## 2. Tool Registry

Registry ही allow-list है — model registry के बाहर की किसी function को call नहीं कर सकता।

| Tool | क्या करता है |
|---|---|
| `agni.forward_pass` | 4→16→3 पर असली forward propagation (z₁, h₁, logits, output) |
| `agni.activation` | activation function के मान, formula और व्यवहार |
| `agni.architecture` | architecture chain validation, parameter count, वर्तमान model विवरण |
| `agni.weights_report` | weights/biases का विश्लेषण + 1-bit quantisation अनुमान |
| `agni.quantize_1bit` | sign quantisation (−1/0/+1) + RMSE; `apply=true` पर preview proposal |
| `agni.train_step` | एक SGD step (cross-entropy) + loss before/after; `apply=true` पर preview proposal |
| `agni.sandbox_eval` | छोटा numeric program सुरक्षित sandbox में चलाकर परिणाम |
| `agni.code_preview` | C/C++/JS/Python code का preview + syntax smoke-check (execute नहीं होता) |
| `agni.project_context` | फिलहाल का project state |

हर tool का result `status` (ok/error), input, timing और (ज़रूरत हो तो) `proposal` के साथ
UI में दिखता है।

---

## 3. Context awareness + Preview → Approval

- Client हर message के साथ current page state भेजता है: पेज (agni / agni-lab), model
  configuration (architecture + activations), inputs, weights, project state (section,
  hasRun, dirty, lastRun, lastError).
- Server उस context को **untrusted data** मानता है: size caps, shape checks, activation
  allow-list; system prompt में साफ़ लिखा है कि यह instruction नहीं है।
- जो tool बदलाव propose करता है (`train_step`, `quantize_1bit`), वह **proposal** बनाता है।
  Proposal server side (KV) में 15 मिनट के TTL के साथ रहता है; browser को सिर्फ preview
  (title, summary, diff) दिखता है।
- **बिना user की मंज़ूरी के कुछ भी लागू नहीं होता।** `/approve` call होने पर ही server
  authoritative payload देता है, और तभी client उसे Lab page के weights/activation textareas
  में लिखता है और playground दोबारा चलाता है।
- Proposal single-use है — approve करते ही delete; replay 404 देता है।

---

## 4. UI

`/hi/agni` और `/hi/agni/lab` में एक side-drawer panel (mobile पर bottom sheet):

- Chat panel (user / assistant / system / error bubbles)
- Project context chips (पेज, architecture, activation, weights, last run)
- Tool execution status rows (नाम, ok/error, समय, one-line result)
- Code/change preview + **स्वीकारें / अस्वीकारें** buttons
- Error surface (कभी भी निगला नहीं जाता)
- **NEXI Penguin** mascot + status line (idle / thinking / running tool / error / done)
- **Teaching Mode** checkbox → server अतिरिक्त `teaching` block भेजता है

सभी user-visible copy हिंदी (देवनागरी) में है; तकनीकी शब्द English में रहते हैं।
Model output `innerHTML`/`eval` से कभी render नहीं होता — DOM `textContent` से बनता है
(बस `**bold**` और `` `code` `` का safe parsing)।

---

## 5. Security

| जोखिम | बदलाव |
|---|---|
| **API key leak** | key सिर्फ Worker secret `AGNI_LLM_API_KEY` में; कभी `[vars]`, code, git या browser को नहीं मिलता |
| **Model द्वारा code चलाना** | `eval`/`Function` का कोई इस्तेमाल नहीं; `sandbox.mjs` का अपना tokenizer + parser + evaluator, whitelist functions, source/token/node/step/array limits |
| **बाहरी tool access** | registry allow-list; unknown tool → तुरंत error; कोई file/network/process access नहीं |
| **Prompt injection via context** | context untrusted data के रूप में capped + sanitised; prompt में explicitly instruction नहीं बनाया गया |
| **Production files में सीधा बदलाव** | original `teom` Worker (src/original-teom.mjs.gz.b64) byte-for-byte अपरिवर्तित; नया कोड अलग `src/agni/` में; homepage/JIT assets अपरिवर्तित |
| **Chat history का D1 में सेव होना** | नहीं — कोई chat/message row नहीं लिखा जाता; केवल human-check challenge rows (पहले से मौजूद table, वही TTL/one-use semantics) |
| **Untrusted generated output** | proposal payload केवल user approve करने पर लागू; client untrusted data की तरह render करता है |
| **Abuse** | human-check challenge (one-use, 5 min TTL) + rate limiter (`TMB_RL`, 60 req/60 s/IP) + body size cap (64 KB) + message cap (4000 chars) |
| **CSP** | मौजूदा hardening बनी रहती है; सिर्फ `script-src`/`connect-src` में `'self'` जुड़ता है; styles inline हैं (`style-src 'unsafe-inline'` पहले से allowed) |

### CSP परिवर्तन (दोनों AGNi pages)

```
पहले (/hi/agni)        script-src https://www.ascii-magic.com;  connect-src https://www.ascii-magic.com
बाद (/hi/agni)        script-src https://www.ascii-magic.com 'self';  connect-src https://www.ascii-magic.com 'self'

पहले (/hi/agni/lab)   script-src 'unsafe-inline';  connect-src 'none'
बाद (/hi/agni/lab)   script-src 'unsafe-inline' 'self';  connect-src 'self'
```

`'none'` को `'self'` से replace किया गया (एक directive में `none` + दूसरा source मिल नहीं सकता)।

---

## 6. चलाना और जाँचना

```bash
npm install
npm run build          # src/generated/* बनाता है (git-ignored)
npm test               # 33 unit + integration tests
npm run dev            # local Wrangler (D1 + KV local)

# लाइव smoke test (deploy के बाद)
bash scripts/check-assistant-local.sh "एक forward pass चलाकर output बताओ" https://teom.avnishchandrathapliyal.workers.dev
python3 scripts/visual-check.py https://teom.avnishchandrathapliyal.workers.dev   # UI screenshots
```

### Secret

```bash
npx wrangler secret put AGNI_LLM_API_KEY     # key यहाँ डालें (git में कभी नहीं)
```

Configurable vars (`wrangler.toml`): `AGNI_LLM_BASE_URL`, `AGNI_LLM_MODEL`.
LLM key न होने पर assistant Workers AI (`AI_MODEL`) पर explain-only mode में चलता है।

---

## 7. सीमाएँ (साफ़)

- यह **trained AGNi model नहीं** है — जो भी आँकड़े आते हैं वो demo/untrained weights पर हैं।
- Tool `agni.code_preview` code **compile/run नहीं** करता; वह preview और smoke-check है।
- `agni.sandbox_eval` सिर्फ restricted math DSL चलाता है — full language नहीं।
- Approved बदलाव browser में locally लागू होते हैं; वे server पर persist नहीं होते और
  production assets को नहीं छूते।
- Model: `mistralai/mistral-small-2603` (OpenAI-compatible endpoint) — free tier पर चलता है;
  premium models को plan/balance चाहिए।
