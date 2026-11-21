/**
 * Unit tests for the AGNi math core, the tool registry and the sandbox.
 * Run with:  node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createInitialModel, forwardPass, applyActivation, trainStep, weightStats,
  quantize1Bit, crossEntropyLoss, summarizePass, round,
} from '../src/agni/math-core.mjs';
import { executeTool, toolDefinitions, TOOL_MAP } from '../src/agni/tools.mjs';
import { runSandbox, SANDBOX_FUNCTIONS } from '../src/agni/sandbox.mjs';
import { buildContext, summarizeContext } from '../src/agni/context.mjs';
import { validate as validateSchema } from '../src/agni/schema.mjs';

/* ── math core ─────────────────────────────────────────────────────────── */

test('seeded model is deterministic and matches the browser shape', () => {
  const a = createInitialModel();
  const b = createInitialModel();
  assert.deepEqual(a.w1, b.w1);
  assert.deepEqual(a.w2, b.w2);
  assert.equal(a.w1.length, 16);
  assert.equal(a.w1[0].length, 4);
  assert.equal(a.w2.length, 3);
  assert.equal(a.w2[0].length, 16);
  assert.equal(a.b1.length, 16);
  assert.equal(a.b2.length, 3);
});

test('forward pass returns z1/h1/logits/output with the expected sizes', () => {
  const model = createInitialModel();
  const pass = forwardPass([1, 0, 1, 0], model, 'relu', 'softmax');
  assert.equal(pass.z1.length, 16);
  assert.equal(pass.h1.length, 16);
  assert.equal(pass.logits.length, 3);
  assert.equal(pass.output.length, 3);
  const sum = pass.output.reduce((t, v) => t + v, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, 'softmax output का योग 1 होना चाहिए');
  assert.ok(pass.h1.every((v) => v >= 0), 'relu hidden non-negative होना चाहिए');
});

test('forward pass rejects a wrong input size', () => {
  const model = createInitialModel();
  assert.throws(() => forwardPass([1, 2, 3], model, 'relu', 'softmax'), /4 finite/);
});

test('activations behave as documented', () => {
  assert.deepEqual(applyActivation([-2, 0, 3], 'relu'), [0, 0, 3]);
  const soft = applyActivation([1, 2, 3], 'softmax');
  assert.ok(Math.abs(soft.reduce((t, v) => t + v, 0) - 1) < 1e-12);
  assert.equal(applyActivation([0], 'sigmoid')[0], 0.5);
});

test('one training step reduces the loss', () => {
  const model = createInitialModel();
  const step = trainStep({ input: [1, 0, 1, 0], targetIndex: 0, model, learningRate: 0.05 });
  assert.ok(step.lossAfter < step.lossBefore, 'loss कम होना चाहिए');
  assert.equal(step.updated.w1.length, 16);
  assert.equal(step.updated.b2.length, 3);
});

test('training step rejects an out-of-range learning rate', () => {
  const model = createInitialModel();
  assert.throws(
    () => trainStep({ input: [1, 0, 1, 0], targetIndex: 0, model, learningRate: 5 }),
    /learning rate/
  );
});

test('cross entropy rejects a bad target index', () => {
  assert.throws(() => crossEntropyLoss([0.1, 0.9], 5), /Target index/);
});

test('weight stats and 1-bit quantisation', () => {
  const model = createInitialModel();
  const stats = weightStats(model);
  assert.equal(stats.count, 16 * 4 + 16 + 3 * 16 + 3);
  const quant = quantize1Bit(model);
  assert.ok(quant.quantized.w1.flat().every((v) => v === 1 || v === -1 || v === 0));
  assert.ok(quant.rmse > 0);
});

/* ── tool registry ─────────────────────────────────────────────────────── */

test('tool registry exposes the documented tools with schemas', () => {
  const names = toolDefinitions().map((t) => t.function.name);
  for (const expected of [
    'agni.forward_pass', 'agni.activation', 'agni.architecture', 'agni.weights_report',
    'agni.quantize_1bit', 'agni.train_step', 'agni.sandbox_eval', 'agni.code_preview',
    'agni.project_context',
  ]) {
    assert.ok(names.includes(expected), `${expected} registry में होना चाहिए`);
  }
  for (const tool of toolDefinitions()) {
    assert.ok(tool.function.description && tool.function.description.length > 20);
    assert.equal(tool.function.parameters.type, 'object');
  }
});

test('unknown tools are refused', async () => {
  const outcome = await executeTool('rm -rf', {}, { context: {}, env: {} });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /अनुमत tool नहीं/);
});

test('forward_pass tool runs against the page weights', async () => {
  const model = createInitialModel();
  const ctx = { context: { weights: model }, env: {} };
  const outcome = await executeTool('agni.forward_pass', { inputs: [1, 0, 1, 0] }, ctx);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.output.length, 3);
  const direct = forwardPass([1, 0, 1, 0], model, 'relu', 'softmax');
  assert.deepEqual(outcome.result.output, summarizePass(direct).output);
});

test('forward_pass tool validates its input schema', async () => {
  const outcome = await executeTool('agni.forward_pass', { inputs: [1, 2] }, { context: {}, env: {} });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /items|4/);
});

test('train_step proposes a change by default and only returns it after apply', async () => {
  const model = createInitialModel();
  const ctx = { context: { weights: model }, env: {} };
  const dry = await executeTool('agni.train_step', { input: [1, 0, 1, 0], targetIndex: 0, apply: false }, ctx);
  assert.equal(dry.proposal, undefined);
  const wet = await executeTool('agni.train_step', { input: [1, 0, 1, 0], targetIndex: 0 }, ctx);
  assert.ok(wet.proposal, 'apply=true पर proposal बनना चाहिए');
  assert.equal(wet.proposal.kind, 'weights');
  assert.ok(Array.isArray(wet.proposal.diff));
  assert.ok(wet.proposal.diff.every((row) => typeof row.path === 'string' && !row.path.includes('[object Object]')));
  assert.equal(wet.proposal.payload.type, 'set-weights');
});

test('architecture tool rejects a broken chain', async () => {
  const outcome = await executeTool('agni.architecture', {
    action: 'validate',
    layers: [{ in: 4, out: 16, activation: 'relu' }, { in: 8, out: 3, activation: 'softmax' }],
  }, { context: {}, env: {} });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /chain/);
});

test('code_preview never executes the source', async () => {
  const outcome = await executeTool('agni.code_preview', {
    language: 'javascript',
    source: 'function f(){ return 1; }',
  }, { context: {}, env: {} });
  assert.equal(outcome.ok, true);
  assert.ok(outcome.result.checks.every((c) => typeof c.ok === 'boolean'));
});

/* ── sandbox ───────────────────────────────────────────────────────────── */

test('sandbox evaluates a small numeric program', () => {
  const result = runSandbox('let h = relu([-1, 2, 3]); sum(h)');
  assert.equal(result.ok, true);
  assert.equal(result.value, 5);
});

test('sandbox supports matmul and softmax', () => {
  const result = runSandbox('softmax(matmul([[1,2],[3,4]], [1,1]))');
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.value.reduce((t, v) => t + v, 0) - 1) < 1e-12);
});

test('sandbox refuses unknown functions and property access', () => {
  const unknown = runSandbox('fetch("https://example.com")');
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /उपलब्ध नहीं|अज्ञात वर्ण/);

  const property = runSandbox('globalThis');
  assert.equal(property.ok, false);
});

test('sandbox refuses infinite recursion style constructs', () => {
  const result = runSandbox('let x = 1 + 1; function f(){ return f(); }');
  assert.equal(result.ok, false);
});

test('sandbox enforces a source size limit', () => {
  const result = runSandbox('1 + '.repeat(3000) + '1');
  assert.equal(result.ok, false);
});

test('sandbox exposes a fixed function whitelist', () => {
  assert.ok(SANDBOX_FUNCTIONS.includes('relu'));
  assert.ok(!SANDBOX_FUNCTIONS.includes('fetch'));
  assert.ok(!SANDBOX_FUNCTIONS.includes('eval'));
});

/* ── context ───────────────────────────────────────────────────────────── */

test('context drops malformed weights and keeps the rest', () => {
  const { context, warnings } = buildContext({
    page: 'agni-lab',
    model: { architecture: '4-16-3', hiddenActivation: 'relu', outputActivation: 'softmax' },
    inputs: [1, 2, 3, 4],
    weights: { w1: 'nope', b1: [], w2: [], b2: [] },
  });
  assert.equal(context.weights, undefined);
  assert.ok(warnings.length > 0);
  assert.deepEqual(context.inputs, [1, 2, 3, 4]);
});

test('context clamps unknown activations and marks data untrusted', () => {
  const { context } = buildContext({
    page: 'whatever',
    model: { hiddenActivation: 'evil', outputActivation: 'softmax' },
  });
  assert.equal(context.page, 'unknown');
  assert.equal(context.model.hiddenActivation, 'relu');
  assert.equal(context.trust, 'untrusted-client-data');
});

test('context summary stays inside the size cap', () => {
  const { summary } = buildContext({
    page: 'agni',
    projectState: { section: 'x'.repeat(5000), lastRun: 'y'.repeat(5000) },
  });
  assert.ok(summary.length <= 20000);
});

/* ── schema validator ──────────────────────────────────────────────────── */

test('schema validator reports the expected problems', () => {
  const schema = {
    type: 'object',
    properties: { n: { type: 'number', minimum: 0, maximum: 10 } },
    required: ['n'],
    additionalProperties: false,
  };
  assert.equal(validateSchema(schema, { n: 5 }).length, 0);
  assert.ok(validateSchema(schema, { n: 50 }).length > 0);
  assert.ok(validateSchema(schema, {}).length > 0);
  assert.ok(validateSchema(schema, { n: 1, extra: 2 }).length > 0);
});
