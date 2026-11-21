/**
 * HTTP routes for the AGNi Development Assistant.
 *
 *   POST /api/agni/assistant/challenge   → human-check question (same table +
 *                                             TTL semantics as the legacy chat)
 *   POST /api/agni/assistant/chat         → the assistant turn (tools + answer)
 *   POST /api/agni/assistant/approve      → hand back an approved change
 *   GET  /api/agni/assistant/tools        → tool registry (public descriptors)
 *   GET  /api/agni/assistant/client.js    → assistant UI script
 *   GET  /api/agni/assistant/client.css   → assistant UI styles
 *
 * The legacy `/api/chat` + `/api/chat/challenge` endpoints are NOT touched.
 */

import { buildContext, systemPrompt } from './context.mjs';
import { toolDefinitions, executeTool } from './tools.mjs';
import { runAssistantTurn } from './llm.mjs';
import { storeProposal, consumeProposal, isValidProposalId } from './proposals.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGE_CHARS = 4000;
const MAX_HISTORY = 8;
const CHALLENGE_TTL_SECONDS = 300;

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });

const clientIp = (request) =>
  request.headers.get('CF-Connecting-IP') ||
  request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
  '0.0.0.0';

async function readJson(request) {
  const contentLength = Number(request.headers.get('content-length') || '0');
  if (contentLength && contentLength > MAX_BODY_BYTES) throw new Error('Request बहुत बड़ा है।');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('Request बहुत बड़ा है।');
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new Error('JSON body पढ़ा नहीं जा सका।');
  }
}

/* ── human-check challenge (mirrors the legacy chat's behaviour) ───────── */

async function sha256Hex(text) {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function createChallenge(env) {
  if (!env.COMMUNITY_DB || typeof env.COMMUNITY_DB.prepare !== 'function') {
    throw new Error('चैट सुरक्षा सेवा अभी उपलब्ध नहीं है।');
  }
  const random = crypto.getRandomValues(new Uint32Array(2));
  const first = (random[0] % 9) + 1;
  const second = (random[1] % 9) + 1;
  const id = randomHex(16);
  const answerHash = await sha256Hex(`${id}:${first + second}`);
  const now = Math.floor(Date.now() / 1000);
  await env.COMMUNITY_DB.prepare(
    'DELETE FROM ai_chat_challenges WHERE expires_at <= ?'
  ).bind(now).run();
  await env.COMMUNITY_DB.prepare(
    'INSERT INTO ai_chat_challenges (challenge_id, answer_hash, expires_at, created_at) VALUES (?, ?, ?, ?)'
  ).bind(id, answerHash, now + CHALLENGE_TTL_SECONDS, now).run();
  return { id, question: `${first} + ${second} = ?` };
}

async function consumeChallenge(env, challenge) {
  if (!env.COMMUNITY_DB || typeof env.COMMUNITY_DB.prepare !== 'function') {
    throw new Error('चैट सुरक्षा सेवा अभी उपलब्ध नहीं है।');
  }
  if (!challenge || typeof challenge.id !== 'string' || !/^[a-f0-9]{32}$/.test(challenge.id) ||
      typeof challenge.answer !== 'string' || !/^\d{1,2}$/.test(challenge.answer.trim())) {
    throw new Error('पहले मानव-जाँच का सही उत्तर दें।');
  }
  const now = Math.floor(Date.now() / 1000);
  const row = await env.COMMUNITY_DB.prepare(
    'DELETE FROM ai_chat_challenges WHERE challenge_id = ? AND expires_at > ? RETURNING answer_hash'
  ).bind(challenge.id, now).first();
  if (!row?.answer_hash) throw new Error('मानव-जाँच समाप्त या अमान्य है। नया सवाल लें।');
  const submitted = await sha256Hex(`${challenge.id}:${challenge.answer.trim()}`);
  if (submitted !== row.answer_hash) {
    throw new Error('मानव-जाँच का उत्तर गलत है। नया सवाल लेकर फिर प्रयास करें।');
  }
}

/* ── handlers ─────────────────────────────────────────────────────────── */

export async function handleAssistantChallenge(request, env) {
  if (request.method !== 'POST') return json({ error: 'केवल POST अनुरोध उपलब्ध है।' }, 405, { allow: 'POST' });
  try {
    await limit(env, request, 'challenge');
    const challenge = await createChallenge(env);
    return json(challenge);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, error?.statusCode || 503);
  }
}

export async function handleAssistantChat(request, env) {
  if (request.method !== 'POST') return json({ error: 'केवल POST अनुरोध उपलब्ध है।' }, 405, { allow: 'POST' });
  try {
    await limit(env, request, 'chat');

    const payload = await readJson(request);
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    if (!message) return json({ error: 'संदेश खाली है।' }, 400);
    if (message.length > MAX_MESSAGE_CHARS) {
      return json({ error: `संदेश ${MAX_MESSAGE_CHARS} अक्षरों से लंबा है।` }, 400);
    }

    await consumeChallenge(env, payload.challenge);

    const { context, summary, warnings } = buildContext(payload.context);
    const teachingMode = payload.teachingMode === true;

    const history = Array.isArray(payload.history)
      ? payload.history
          .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
          .slice(-MAX_HISTORY)
          .map((item) => ({ role: item.role, content: item.content.slice(0, 2000) }))
      : [];

    const messages = [
      { role: 'system', content: systemPrompt(summary, teachingMode) },
      ...history,
      { role: 'user', content: message },
    ];

    const turn = await runAssistantTurn({
      env,
      messages,
      tools: toolDefinitions(),
      executeTool: (name, args) => executeTool(name, args, { context, env }),
      // A user-supplied key is honoured for this request only: it is used to
      // call the provider, never stored, never logged and never sent back.
      override: {
        apiKey: typeof payload.settings?.apiKey === 'string' ? payload.settings.apiKey : '',
        baseUrl: typeof payload.settings?.baseUrl === 'string' ? payload.settings.baseUrl : '',
        model: typeof payload.settings?.model === 'string' ? payload.settings.model : '',
      },
    });

    // Collect a proposal from the tool round (if any) and persist it server side.
    let proposal = null;
    const withProposal = turn.toolCalls.find((call) => call.proposal);
    if (withProposal?.proposal) {
      const stored = await storeProposal(env, withProposal.proposal);
      if (stored) {
        proposal = {
          id: stored.id,
          kind: stored.kind,
          title: stored.title,
          summary: stored.summary,
          diff: stored.diff,
          payload: stored.payload,
          expiresAt: stored.expiresAt,
        };
      }
    }

    const errors = [...warnings];
    if (turn.error) errors.push(turn.error);

    // When the provider failed, the error bubble carries the message — do not
    // add a generic "no answer" line on top of it.
    const reply = turn.reply && turn.reply.trim()
      ? turn.reply.trim()
      : (turn.error
        ? ''
        : 'मैं इस संदेश पर कोई उत्तर नहीं बना पाया। दूसरी कोशिश करें या Teaching Mode में "क्यों" पूछें।');

    const teaching = teachingMode
      ? buildTeachingNote(turn, context)
      : undefined;

    return json({
      ok: true,
      reply,
      teaching,
      toolCalls: turn.toolCalls.map((call) => ({
        name: call.name,
        status: call.status,
        input: call.input,
        result: call.result,
        error: call.error,
        ms: call.ms,
      })),
      proposal,
      errors,
      meta: {
        model: turn.model,
        mode: turn.mode,
        // only whether a user key was used — never the key itself
        usingUserKey: Boolean(turn.usingUserKey),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error?.statusCode || (/मानव-जाँच/.test(message) ? 403 : 500);
    return json({ error: message }, status);
  }
}

export async function handleAssistantApprove(request, env) {
  if (request.method !== 'POST') return json({ error: 'केवल POST अनुरोध उपलब्ध है।' }, 405, { allow: 'POST' });
  try {
    await limit(env, request, 'approve');
    const payload = await readJson(request);
    const id = payload.proposalId;
    if (!isValidProposalId(id)) return json({ error: 'proposal id अमान्य है।' }, 400);
    if (payload.approve !== true) {
      const record = await consumeProposal(env, id);
      if (!record) return json({ error: 'यह proposal अब उपलब्ध नहीं है (समय समाप्त या पहले ही उपयोग हो चुका)।' }, 404);
      return json({ ok: true, approved: false, payload: null });
    }
    const record = await consumeProposal(env, id);
    if (!record) {
      return json({ error: 'यह proposal अब उपलब्ध नहीं है (समय समाप्त या पहले ही उपयोग हो चुका)।' }, 404);
    }
    return json({ ok: true, approved: true, payload: record.payload, kind: record.kind, title: record.title });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, error?.statusCode || 500);
  }
}

export async function handleAssistantTools(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'केवल GET अनुरोध उपलब्ध है।' }, 405, { allow: 'GET, HEAD' });
  }
  return json({ tools: toolDefinitions() });
}

/** Index of the assistant namespace — handy for anyone poking at the API. */
export async function handleAssistantIndex(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'केवल GET अनुरोध उपलब्ध है।' }, 405, { allow: 'GET, HEAD' });
  }
  return json({
    name: 'AGNi Development Assistant',
    description: 'AGNi project के लिए development agent — chat, tools, preview और approval.',
    endpoints: [
      { method: 'GET', path: '/api/agni/assistant', description: 'यह index' },
      { method: 'GET', path: '/api/agni/assistant/tools', description: 'Tool registry के public descriptors' },
      { method: 'POST', path: '/api/agni/assistant/challenge', description: 'मानव-जाँच challenge (एक बार इस्तेमाल)' },
      { method: 'POST', path: '/api/agni/assistant/chat', description: 'Assistant turn — message + context + challenge' },
      { method: 'POST', path: '/api/agni/assistant/approve', description: 'Preview बदलाव की मंज़ूरी (single use)' },
      { method: 'GET', path: '/api/agni/assistant/client.js', description: 'Assistant UI script' },
      { method: 'GET', path: '/api/agni/assistant/client.css', description: 'Assistant UI styles' },
    ],
    pages: ['/hi/agni', '/hi/agni/lab'],
    note: 'कोई chat history सेव नहीं होती; बदलाव केवल user की मंज़ूरी के बाद लागू होते हैं।',
  });
}

/* ── helpers ──────────────────────────────────────────────────────────── */

async function limit(env, request, scope) {
  const limiter = env.TMB_RL || env.CHAT_RATE_LIMITER;
  if (!limiter || typeof limiter.limit !== 'function') return;
  const { success } = await limiter.limit({ key: `${scope}:${clientIp(request)}` });
  if (!success) {
    const error = new Error('बहुत सारे अनुरोध — थोड़ा रुककर फिर कोशिश करें।');
    error.statusCode = 429;
    throw error;
  }
}

function buildTeachingNote(turn, context) {
  const tools = turn.toolCalls.map((call) => `${call.name} (${call.status})`).join(', ');
  const model = context.model
    ? `${context.model.architecture} · hidden=${context.model.hiddenActivation} · output=${context.model.outputActivation}`
    : 'मौजूदा page पर कोई model config नहीं।';
  return [
    'शिक्षण बिंदु:',
    `• आज का context: ${model}`,
    tools ? `• चलाए गए tool: ${tools}` : '• इस उत्तर में कोई tool नहीं चला।',
    '• ये आँकड़े demo/untrained weights पर हैं — trained model का output नहीं।',
    '• किसी भी बदलाव के लिए पहले preview और मंज़ूरी चाहिए।',
  ].join('\n');
}
