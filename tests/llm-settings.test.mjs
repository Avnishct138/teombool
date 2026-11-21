/**
 * Tests for user-supplied LLM settings (own API key / provider / model).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isAllowedBaseUrl, llmConfig, PROVIDER_ALLOWLIST } from '../src/agni/llm.mjs';

const ENV = {
  AGNI_LLM_BASE_URL: 'https://api.xkiro.com/v1',
  AGNI_LLM_MODEL: 'mistralai/mistral-small-2603',
  AGNI_LLM_API_KEY: 'server-secret-key',
};

test('allow-list accepts the known providers', () => {
  assert.equal(isAllowedBaseUrl('https://api.xkiro.com/v1', ENV), true);
  assert.equal(isAllowedBaseUrl('https://api.openai.com/v1', ENV), true);
  assert.equal(isAllowedBaseUrl('https://api.xkiro.com/v1/chat/completions', ENV), true);
});

test('allow-list refuses arbitrary URLs (SSRF guard)', () => {
  const bad = [
    'https://example.com/v1',
    'http://api.xkiro.com/v1',           // not https
    'https://api.xkiro.com.evil.test/v1', // look-alike host
    'https://169.254.169.254/latest',     // cloud metadata
    'http://127.0.0.1:8787/v1',
    'not-a-url',
    '',
    null,
  ];
  for (const url of bad) {
    assert.equal(isAllowedBaseUrl(url, ENV), false, `${url} allow-list में नहीं होना चाहिए`);
  }
});

test('allow-list also accepts the worker-configured provider', () => {
  assert.equal(isAllowedBaseUrl('https://api.minimax.io/v1', { AGNI_LLM_BASE_URL: 'https://api.minimax.io/v1' }), true);
});

test('user key wins over the server secret', () => {
  const config = llmConfig(ENV, { apiKey: 'sk-user-key' });
  assert.equal(config.apiKey, 'sk-user-key');
  assert.equal(config.usingUserKey, true);
});

test('without a user key the server secret is used', () => {
  const config = llmConfig(ENV, {});
  assert.equal(config.apiKey, 'server-secret-key');
  assert.equal(config.usingUserKey, false);
});

test('a disallowed base URL falls back to the configured provider', () => {
  const config = llmConfig(ENV, { apiKey: 'sk-user-key', baseUrl: 'https://evil.test/v1' });
  assert.equal(config.baseUrl, 'https://api.xkiro.com/v1');
  assert.equal(config.apiKey, 'sk-user-key');
});

test('a user model is used as the primary model', () => {
  const config = llmConfig(ENV, { model: 'openai/gpt-4o-mini' });
  assert.equal(config.primary, 'openai/gpt-4o-mini');
  assert.ok(config.models.includes('openai/gpt-4o-mini'));
});

test('provider allow-list is not empty and every entry is https', () => {
  assert.ok(PROVIDER_ALLOWLIST.length >= 3);
  for (const provider of PROVIDER_ALLOWLIST) {
    assert.match(provider.baseUrl, /^https:\/\//);
  }
});
