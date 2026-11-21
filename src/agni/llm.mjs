/**
 * LLM client for the AGNi Development Assistant.
 *
 * Primary: any OpenAI-compatible chat-completions endpoint (the project is
 * configured for xKiro: https://api.xkiro.com/v1). The API key lives only in a
 * Worker secret — it is never sent to the browser and never written to a file.
 *
 * Fallback: Cloudflare Workers AI (env.AI + env.AI_MODEL) when no external key
 * is configured. Workers AI has no function-calling here, so the assistant then
 * runs in "explain only" mode and the UI shows that no tool ran.
 */

export const DEFAULT_BASE_URL = 'https://api.xkiro.com/v1';
export const DEFAULT_MODEL = 'mistralai/mistral-small-2603';
export const FALLBACK_MODELS = [
  'mistralai/mistral-small-2603',
  'mistralai/mistral-medium-3.5',
  'mistralai/ministral-8b',
  'cohere/command-a',
];

/**
 * Providers a browser-supplied key may be used against.
 *
 * The Worker fetches this URL on the user's behalf, so an arbitrary URL would
 * be a server-side request forgery hole (and could be pointed at Cloudflare's
 * own metadata endpoints). Only these known, public, https endpoints are
 * accepted; anything else falls back to the Worker-configured provider.
 */
export const PROVIDER_ALLOWLIST = [
  { baseUrl: 'https://api.xkiro.com/v1', label: 'xKiro (OpenAI-compatible)' },
  { baseUrl: 'https://api.openai.com/v1', label: 'OpenAI' },
  { baseUrl: 'https://api.minimax.io/v1', label: 'MiniMax' },
  { baseUrl: 'https://api.groq.com/openai/v1', label: 'Groq' },
  { baseUrl: 'https://api.deepseek.com/v1', label: 'DeepSeek' },
  { baseUrl: 'https://openrouter.ai/api/v1', label: 'OpenRouter' },
];

const MAX_TOOL_ROUNDS = 4;
const REQUEST_TIMEOUT_MS = 45000;

/** Is this base URL one we are willing to fetch on the caller's behalf? */
export function isAllowedBaseUrl(baseUrl, env) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return false;
  let url;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const configured = env?.AGNI_LLM_BASE_URL || DEFAULT_BASE_URL;
  const allowed = new Set();
  for (const base of [...PROVIDER_ALLOWLIST.map((p) => p.baseUrl), configured]) {
    try { allowed.add(new URL(base).origin); } catch { /* ignore malformed */ }
  }
  return allowed.has(url.origin);
}

/**
 * Resolve the effective LLM configuration.
 * A browser-supplied key is used for that one request only — it is never
 * written to storage, never logged and never returned to the browser.
 */
export function llmConfig(env, override = {}) {
  const configured = (env.AGNI_LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const overrideUrl = typeof override.baseUrl === 'string' ? override.baseUrl.trim().replace(/\/+$/, '') : '';
  const baseUrl = overrideUrl && isAllowedBaseUrl(overrideUrl, env) ? overrideUrl : configured;

  const overrideKey = typeof override.apiKey === 'string' ? override.apiKey.trim() : '';
  const apiKey = overrideKey || (typeof env.AGNI_LLM_API_KEY === 'string' ? env.AGNI_LLM_API_KEY.trim() : '');

  const primary = (typeof override.model === 'string' && override.model.trim()) || env.AGNI_LLM_MODEL || DEFAULT_MODEL;
  const models = [primary, ...FALLBACK_MODELS.filter((m) => m !== primary)];
  return { baseUrl, apiKey, primary, models, usingUserKey: Boolean(overrideKey) };
}

async function postJson(url, body, headers, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { ok: response.ok, status: response.status, data, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One chat-completions call.
 * @returns {{ok:boolean, content:string, toolCalls:Array, model:string, error?:string, status?:number}}
 */
export async function chatCompletion({ env, messages, tools, model, temperature = 0.3, maxTokens = 1200, override }) {
  const config = llmConfig(env, override);
  const body = { model, messages, temperature, max_tokens: maxTokens };
  if (tools && tools.length) body.tools = tools;
  body.tool_choice = 'auto';

  const result = await postJson(
    `${config.baseUrl}/chat/completions`,
    body,
    { authorization: `Bearer ${config.apiKey}` }
  );

  if (!result.ok) {
    const message = result.data?.error?.message || result.text?.slice(0, 300) || `HTTP ${result.status}`;
    return { ok: false, content: '', toolCalls: [], model, error: scrubKey(message, config.apiKey), status: result.status };
  }

  const message = result.data?.choices?.[0]?.message;
  const toolCalls = (message?.tool_calls || []).map((call) => ({
    id: call.id,
    name: call.function?.name || '',
    arguments: parseArguments(call.function?.arguments),
  }));
  return {
    ok: true,
    content: typeof message?.content === 'string' ? message.content : '',
    toolCalls,
    model,
    usage: result.data?.usage || null,
  };
}

/** Never let a key leak into an error message that goes back to the browser. */
function scrubKey(text, key) {
  let out = String(text || '');
  if (key && out.includes(key)) out = out.split(key).join('[key]');
  return out.replace(/sk-[A-Za-z0-9._-]{8,}/g, '[key]');
}

function parseArguments(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Run the assistant turn: model → (tool calls → execute → feed back) → final answer.
 *
 * @param {object} options
 * @param {object} options.env
 * @param {Array}  options.messages  full message array (system first)
 * @param {Array}  options.tools    OpenAI-style tool descriptors
 * @param {Function} options.executeTool  async (name, args) => tool outcome
 */
export async function runAssistantTurn({ env, messages, tools, executeTool, override }) {
  const config = llmConfig(env, override);
  const toolCalls = [];
  const conversation = [...messages];
  let lastError = '';
  let usedModel = config.primary;
  let mode = 'external';

  if (!config.apiKey) {
    // No external key: fall back to Workers AI (explain-only, no tools).
    const workersAi = await runWorkersAi(env, conversation);
    return {
      reply: workersAi.content,
      toolCalls,
      model: workersAi.model,
      mode: 'workers-ai',
      error: workersAi.error,
      usingUserKey: false,
    };
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let response = null;
    let lastFailure = '';
    for (const model of config.models) {
      response = await chatCompletion({ env, messages: conversation, tools, model, override });
      if (response.ok) { usedModel = model; break; }
      lastFailure = response.error || 'LLM call failed';
      // 401/403 = key or plan problem: trying another model will not help.
      if (response.status === 401 || response.status === 403) break;
    }
    if (!response || !response.ok) {
      lastError = lastFailure;
      break;
    }

    if (!response.toolCalls.length) {
      return {
        reply: response.content || '',
        toolCalls,
        model: usedModel,
        mode,
        error: lastError || undefined,
        usingUserKey: config.usingUserKey,
      };
    }

    conversation.push({
      role: 'assistant',
      content: response.content || '',
      tool_calls: response.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    });

    for (const call of response.toolCalls) {
      const started = Date.now();
      const outcome = await executeTool(call.name, call.arguments);
      const record = {
        name: call.name,
        status: outcome.status || (outcome.ok ? 'ok' : 'error'),
        input: outcome.input ?? call.arguments,
        result: outcome.ok ? outcome.result : undefined,
        error: outcome.ok ? undefined : outcome.error,
        proposal: outcome.proposal || null,
        ms: Date.now() - started,
      };
      toolCalls.push(record);
      conversation.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(
          outcome.ok
            ? { ok: true, result: outcome.result, proposal: outcome.proposal || null }
            : { ok: false, error: outcome.error }
        ).slice(0, 8000),
      });
    }
  }

  // Tool loop exhausted — ask for a final answer without tools.
  const final = await chatCompletion({ env, messages: conversation, tools: null, model: usedModel, override });
  return {
    reply: final.ok ? final.content : '',
    toolCalls,
    model: usedModel,
    mode,
    error: lastError || (final.ok ? undefined : final.error),
    truncated: true,
    usingUserKey: config.usingUserKey,
  };
}

async function runWorkersAi(env, messages) {
  if (!env.AI || typeof env.AI.run !== 'function' || !env.AI_MODEL) {
    return { content: '', model: null, error: 'कोई AI provider कॉन्फ़िगर नहीं है (AGNI_LLM_API_KEY secret या Workers AI binding चाहिए)।' };
  }
  try {
    const result = await env.AI.run(env.AI_MODEL, {
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: 800,
    });
    const content = result?.response || result?.choices?.[0]?.message?.content || '';
    return { content: String(content), model: env.AI_MODEL, error: '' };
  } catch (error) {
    return { content: '', model: env.AI_MODEL, error: error instanceof Error ? error.message : String(error) };
  }
}
