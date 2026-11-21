/**
 * Integration tests for the assistant HTTP routes.
 *
 * Everything external is mocked: D1 (challenge table), KV (proposals) and the
 * LLM endpoint (global fetch). No network, no Cloudflare account needed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleAssistantChallenge,
  handleAssistantChat,
  handleAssistantApprove,
  handleAssistantTools,
} from '../src/agni/routes.mjs';

/* ── mocks ────────────────────────────────────────────────────────────── */

function makeD1() {
  const rows = new Map();
  const exec = (sql, args) => {
    if (sql.includes('INSERT INTO ai_chat_challenges')) {
      rows.set(args[0], { answer_hash: args[1], expires_at: args[2] });
      return { run: async () => ({ success: true }) };
    }
    if (sql.includes('DELETE FROM ai_chat_challenges WHERE challenge_id')) {
      const row = rows.get(args[0]);
      if (!row || row.expires_at <= args[1]) return { first: async () => null };
      rows.delete(args[0]);
      return { first: async () => row };
    }
    if (sql.includes('DELETE FROM ai_chat_challenges WHERE expires_at')) {
      return { run: async () => ({ success: true }) };
    }
    throw new Error('unexpected SQL: ' + sql);
  };
  return {
    prepare(sql) {
      return {
        bind: (...args) => exec(sql, args),
        run: async () => ({ success: true }),
        first: async () => null,
      };
    },
  };
}

function makeKV() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      if (!store.has(key)) return null;
      const value = store.get(key);
      return type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
}

function makeEnv(extra = {}) {
  return {
    COMMUNITY_DB: makeD1(),
    TMB_SHARES: makeKV(),
    TMB_RL: { limit: async () => ({ success: true }) },
    ...extra,
  };
}

function post(body, headers = {}) {
  return new Request('https://example.test/api/agni/assistant/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** Solve the human-check question that the challenge endpoint returns. */
function solve(question) {
  const [a, b] = question.match(/(\d+)\s*\+\s*(\d+)/).slice(1).map(Number);
  return String(a + b);
}

async function fetchChallenge(env) {
  const response = await handleAssistantChallenge(post({}, { 'x-test': '1' }), env);
  const data = await response.json();
  return data;
}

/* ── tests ─────────────────────────────────────────────────────────────── */

test('challenge endpoint returns an id and a question', async () => {
  const env = makeEnv();
  const challenge = await fetchChallenge(env);
  assert.match(challenge.id, /^[a-f0-9]{32}$/);
  assert.match(challenge.question, /\d+ \+ \d+ = \?/);
});

test('chat rejects a request without a valid human-check answer', async () => {
  const env = makeEnv();
  const response = await handleAssistantChat(post({ message: 'नमस्ते' }), env);
  assert.equal(response.status, 403);
  const data = await response.json();
  assert.match(data.error, /मानव-जाँच/);
});

test('chat rejects an empty or oversized message', async () => {
  const env = makeEnv();
  const empty = await handleAssistantChat(post({ message: '   ' }), env);
  assert.equal(empty.status, 400);

  const long = await handleAssistantChat(post({ message: 'x'.repeat(5000) }), env);
  assert.equal(long.status, 400);
});

test('chat runs a registered tool and returns its result', async () => {
  const env = makeEnv({
    AGNI_LLM_API_KEY: 'test-key',
    AGNI_LLM_BASE_URL: 'https://llm.test/v1',
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.messages.some((m) => m.role === 'tool')) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Forward pass चल गया: output [0.1, 0.2, 0.7]।' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: '',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'agni.forward_pass', arguments: JSON.stringify({ inputs: [1, 0, 1, 0] }) },
          }],
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const challenge = await fetchChallenge(env);
    const response = await handleAssistantChat(post({
      message: 'inputs [1,0,1,0] पर forward pass चलाओ',
      challenge: { id: challenge.id, answer: solve(challenge.question) },
      context: {
        page: 'agni-lab',
        model: { architecture: '4-16-3', hiddenActivation: 'relu', outputActivation: 'softmax' },
        inputs: [1, 0, 1, 0],
        weights: {
          w1: Array.from({ length: 16 }, () => [0.1, 0.2, 0.3, 0.4]),
          b1: Array(16).fill(0),
          w2: Array.from({ length: 3 }, () => Array(16).fill(0.05)),
          b2: [0, 0, 0],
        },
      },
    }), env);

    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.ok, true);
    assert.match(data.reply, /Forward pass चल गया/);
    assert.equal(data.toolCalls.length, 1);
    assert.equal(data.toolCalls[0].name, 'agni.forward_pass');
    assert.equal(data.toolCalls[0].status, 'ok');
    assert.equal(data.toolCalls[0].result.output.length, 3);
    assert.equal(data.proposal, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a tool proposal is stored server side and only released after approval', async () => {
  const env = makeEnv({
    AGNI_LLM_API_KEY: 'test-key',
    AGNI_LLM_BASE_URL: 'https://llm.test/v1',
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.messages.some((m) => m.role === 'tool')) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Training step तैयार है — preview देखें।' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: '',
          tool_calls: [{
            id: 'call_2',
            type: 'function',
            function: {
              name: 'agni.train_step',
              arguments: JSON.stringify({ input: [1, 0, 1, 0], targetIndex: 0, apply: true }),
            },
          }],
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const challenge = await fetchChallenge(env);
    const response = await handleAssistantChat(post({
      message: 'एक training step लगाओ',
      challenge: { id: challenge.id, answer: solve(challenge.question) },
      context: {
        page: 'agni-lab',
        weights: {
          w1: Array.from({ length: 16 }, () => [0.1, 0.2, 0.3, 0.4]),
          b1: Array(16).fill(0),
          w2: Array.from({ length: 3 }, () => Array(16).fill(0.05)),
          b2: [0, 0, 0],
        },
      },
    }), env);

    const data = await response.json();
    assert.ok(data.proposal, 'proposal आना चाहिए');
    assert.equal(data.proposal.kind, 'weights');
    assert.ok(Array.isArray(data.proposal.diff));

    // approving returns the authoritative payload…
    const approve = await handleAssistantApprove(post({
      proposalId: data.proposal.id,
      approve: true,
    }), env);
    const approved = await approve.json();
    assert.equal(approved.ok, true);
    assert.equal(approved.approved, true);
    assert.equal(approved.payload.type, 'set-weights');
    assert.equal(approved.payload.b1.length, 16);

    // …and the proposal cannot be replayed.
    const replay = await handleAssistantApprove(post({
      proposalId: data.proposal.id,
      approve: true,
    }), env);
    assert.equal(replay.status, 404);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('approve rejects an unknown proposal id', async () => {
  const env = makeEnv();
  const response = await handleAssistantApprove(post({ proposalId: 'nope', approve: true }), env);
  assert.equal(response.status, 400);
});

test('tools endpoint lists the registry without leaking handlers', async () => {
  const response = await handleAssistantTools(new Request('https://example.test/api/agni/assistant/tools'));
  const data = await response.json();
  assert.ok(data.tools.length >= 9);
  for (const tool of data.tools) {
    assert.equal(tool.type, 'function');
    assert.ok(tool.function.name.startsWith('agni.'));
    assert.equal(tool.function.execute, undefined);
    assert.equal(tool.function.handler, undefined);
  }
});

test('rate limit responses surface as 429', async () => {
  const env = makeEnv({ TMB_RL: { limit: async () => ({ success: false }) } });
  const response = await handleAssistantChat(post({ message: 'नमस्ते' }), env);
  assert.equal(response.status, 429);
});
