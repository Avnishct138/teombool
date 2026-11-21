/**
 * AGNi math core — server side.
 *
 * The `forwardPass` / `validateModel` / `createInitialModel` semantics here are a
 * 1:1 mirror of the browser core that ships inside the AGNi Lab page
 * (`AGNiCore` inside src/original-teom.mjs → AGNI_LAB_PAGE). Numbers produced by
 * the assistant tool `agni.forward_pass` therefore match what the user sees in
 * the playground, bit for bit (same seed, same order of operations).
 *
 * Everything on top of that (generic architectures, training steps, 1-bit
 * quantisation) is deterministic and side-effect free — no I/O, no globals.
 */

export const INPUTS = 4;
export const HIDDEN = 16;
export const OUTPUTS = 3;
export const DEFAULT_SEED = 0x0a61c0de;
export const ACTIVATIONS = new Set(['relu', 'sigmoid', 'tanh', 'linear', 'softmax']);

/* ── deterministic seeded weights ─────────────────────────────────────── */

export function seededRandom(seed) {
  let state = seed >>> 0;
  if (state === 0) state = 0x6d2b79f5;
  return function next() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

export function createInitialModel(seed) {
  const random = seededRandom(seed === undefined ? DEFAULT_SEED : seed);
  const limit1 = Math.sqrt(6 / (INPUTS + HIDDEN));
  const limit2 = Math.sqrt(6 / (HIDDEN + OUTPUTS));
  const w1 = Array.from({ length: HIDDEN }, () =>
    Array.from({ length: INPUTS }, () => (random() * 2 - 1) * limit1)
  );
  const w2 = Array.from({ length: OUTPUTS }, () =>
    Array.from({ length: HIDDEN }, () => (random() * 2 - 1) * limit2)
  );
  return { w1, b1: Array(HIDDEN).fill(0), w2, b2: Array(OUTPUTS).fill(0) };
}

/* ── validation ───────────────────────────────────────────────────────── */

export function assertVector(value, length, label) {
  if (!Array.isArray(value) || value.length !== length ||
      value.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new Error(`${label} में ठीक ${length} finite संख्या चाहिए।`);
  }
}

export function assertMatrix(value, rows, cols, label) {
  if (!Array.isArray(value) || value.length !== rows) {
    throw new Error(`${label} का आकार ${rows} × ${cols} होना चाहिए।`);
  }
  value.forEach((row, index) => assertVector(row, cols, `${label} की row ${index + 1}`));
}

export function validateModel(model, input) {
  if (!model || typeof model !== 'object') throw new Error('Weights और biases का JSON object पढ़ा नहीं गया।');
  assertVector(input, INPUTS, 'Input vector');
  assertMatrix(model.w1, HIDDEN, INPUTS, 'W1');
  assertVector(model.b1, HIDDEN, 'b1');
  assertMatrix(model.w2, OUTPUTS, HIDDEN, 'W2');
  assertVector(model.b2, OUTPUTS, 'b2');
  return true;
}

/* ── activations ──────────────────────────────────────────────────────── */

export function scalarActivation(value, name) {
  switch (name) {
    case 'linear': return value;
    case 'relu': return Math.max(0, value);
    case 'tanh': return Math.tanh(value);
    case 'sigmoid':
      if (value >= 0) return 1 / (1 + Math.exp(-value));
      const expValue = Math.exp(value);
      return expValue / (1 + expValue);
    default: throw new Error(`Unknown scalar activation: ${name}`);
  }
}

export function applyActivation(values, name) {
  if (!ACTIVATIONS.has(name)) throw new Error('कृपया उपलब्ध activation function चुनें।');
  if (name !== 'softmax') return values.map((value) => scalarActivation(value, name));
  const maxValue = Math.max(...values);
  const exps = values.map((value) => Math.exp(value - maxValue));
  const sum = exps.reduce((total, value) => total + value, 0);
  return exps.map((value) => value / sum);
}

function finiteVector(values, label) {
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error(`${label} में overflow हुआ। Input/weights को छोटा करें और फिर चलाएँ।`);
  }
  return values;
}

/* ── forward pass (4 → 16 → 3, browser-identical) ─────────────────────── */

export function forwardPass(input, model, hiddenActivation, outputActivation) {
  validateModel(model, input);
  if (!ACTIVATIONS.has(hiddenActivation)) throw new Error('Hidden-layer activation उपलब्ध सूची में नहीं है।');
  if (!ACTIVATIONS.has(outputActivation)) throw new Error('Output activation उपलब्ध सूची में नहीं है।');

  const z1 = Array.from({ length: HIDDEN }, (_, j) =>
    model.w1[j].reduce((sum, weight, i) => sum + weight * input[i], model.b1[j])
  );
  finiteVector(z1, 'z₁');
  const h1 = finiteVector(applyActivation(z1, hiddenActivation), 'h₁');
  const logits = Array.from({ length: OUTPUTS }, (_, k) =>
    model.w2[k].reduce((sum, weight, j) => sum + weight * h1[j], model.b2[k])
  );
  finiteVector(logits, 'Logits');
  const output = finiteVector(applyActivation(logits, outputActivation), 'Output');
  return { z1, h1, logits, output };
}

/* ── generic dense network (any layer sizes) ──────────────────────────── */

export function denseForward(x, layers) {
  // layers: [{ w: [[..]], b: [..], activation: 'relu' }]
  let a = x.slice();
  const trace = [];
  for (const layer of layers) {
    const z = layer.w.map((row, i) => row.reduce((sum, w, j) => sum + w * a[j], layer.b[i] ?? 0));
    const h = applyActivation(z, layer.activation);
    trace.push({ z, h });
    a = h;
  }
  return { output: a, trace };
}

export function buildDenseModel(spec, seed) {
  // spec: { layers: [{ in, out, activation }] }
  const random = seededRandom(seed === undefined ? DEFAULT_SEED : seed);
  const layers = spec.layers.map((layer) => {
    const limit = Math.sqrt(6 / (layer.in + layer.out));
    const w = Array.from({ length: layer.out }, () =>
      Array.from({ length: layer.in }, () => (random() * 2 - 1) * limit)
    );
    return { w, b: Array(layer.out).fill(0), activation: layer.activation };
  });
  return { layers, seed: seed === undefined ? DEFAULT_SEED : seed };
}

/* ── training (single dense layer stack, plain SGD) ───────────────────── */

export function mseLoss(predicted, target) {
  assertVector(predicted, target.length, 'Predicted vector');
  assertVector(target, target.length, 'Target vector');
  let sum = 0;
  for (let i = 0; i < target.length; i++) sum += (predicted[i] - target[i]) ** 2;
  return sum / target.length;
}

export function crossEntropyLoss(logits, targetIndex) {
  const max = Math.max(...logits);
  const exps = logits.map((v) => Math.exp(v - max));
  const sum = exps.reduce((t, v) => t + v, 0);
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= logits.length) {
    throw new Error('Target index logits की सीमा में नहीं है।');
  }
  return -Math.log(exps[targetIndex] / sum);
}

/**
 * One SGD step on a 2-layer network (input → hidden → output), softmax output,
 * cross-entropy loss. Returns updated weights plus loss before/after.
 */
export function trainStep({ input, targetIndex, model, hiddenActivation = 'relu', learningRate = 0.05 }) {
  if (!Number.isFinite(learningRate) || learningRate <= 0 || learningRate > 1) {
    throw new Error('learning rate 0 से बड़ा और 1 से छोटा या बराबर होना चाहिए।');
  }
  const pass = forwardPass(input, model, hiddenActivation, 'softmax');
  const lossBefore = crossEntropyLoss(pass.logits, targetIndex);
  const p = pass.output;

  // dL/dz2 for softmax + cross entropy = (p - onehot)
  const dz2 = p.map((v, k) => v - (k === targetIndex ? 1 : 0));
  const dw2 = model.w2.map((row, k) => row.map((w, j) => w - learningRate * dz2[k] * pass.h1[j]));
  const db2 = model.b2.map((b, k) => b - learningRate * dz2[k]);

  // dz1 = W2ᵀ · dz2 , then activation derivative
  const dz1 = Array.from({ length: HIDDEN }, (_, j) => {
    let sum = 0;
    for (let k = 0; k < OUTPUTS; k++) sum += model.w2[k][j] * dz2[k];
    return sum * activationDerivative(pass.z1[j], hiddenActivation);
  });
  const dw1 = model.w1.map((row, j) => row.map((w, i) => w - learningRate * dz1[j] * input[i]));
  const db1 = model.b1.map((b, j) => b - learningRate * dz1[j]);

  const updated = { w1: dw1, b1: db1, w2: dw2, b2: db2 };
  const lossAfter = crossEntropyLoss(forwardPass(input, updated, hiddenActivation, 'softmax').logits, targetIndex);
  return { updated, lossBefore, lossAfter, pass };
}

export function activationDerivative(value, name) {
  switch (name) {
    case 'linear': return 1;
    case 'relu': return value > 0 ? 1 : 0;
    case 'tanh': {
      const t = Math.tanh(value);
      return 1 - t * t;
    }
    case 'sigmoid': {
      const s = scalarActivation(value, 'sigmoid');
      return s * (1 - s);
    }
    default: throw new Error(`Unknown activation derivative: ${name}`);
  }
}

/* ── weights & bias analysis ──────────────────────────────────────────── */

export function flatten(model) {
  return {
    w1: model.w1.flat(),
    b1: model.b1.slice(),
    w2: model.w2.flat(),
    b2: model.b2.slice(),
  };
}

export function weightStats(model) {
  const all = flatten(model);
  const values = [...all.w1, ...all.b1, ...all.w2, ...all.b2];
  const n = values.length;
  const mean = values.reduce((t, v) => t + v, 0) / n;
  const variance = values.reduce((t, v) => t + (v - mean) ** 2, 0) / n;
  const absValues = values.map(Math.abs);
  const sumAbs = absValues.reduce((t, v) => t + v, 0);
  const zeros = values.filter((v) => v === 0).length;
  const negatives = values.filter((v) => v < 0).length;
  return {
    count: n,
    mean: round(mean),
    stdDev: round(Math.sqrt(variance)),
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
    meanAbs: round(sumAbs / n),
    zeros,
    negatives,
    sparsity: round(zeros / n),
    shapes: { w1: [HIDDEN, INPUTS], b1: [HIDDEN], w2: [OUTPUTS, HIDDEN], b2: [OUTPUTS] },
  };
}

/* ── 1-bit (sign) quantisation ────────────────────────────────────────── */

export function quantize1Bit(model) {
  const source = flatten(model);
  const quantize = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
  const q = {
    w1: model.w1.map((row) => row.map(quantize)),
    b1: model.b1.map(quantize),
    w2: model.w2.map((row) => row.map(quantize)),
    b2: model.b2.map(quantize),
  };
  const all = [...source.w1, ...source.b1, ...source.w2, ...source.b2];
  const qAll = [...q.w1.flat(), ...q.b1, ...q.w2.flat(), ...q.b2];
  let sqErr = 0;
  let maxErr = 0;
  for (let i = 0; i < all.length; i++) {
    const e = all[i] - qAll[i];
    sqErr += e * e;
    maxErr = Math.max(maxErr, Math.abs(e));
  }
  return {
    quantized: q,
    rmse: round(Math.sqrt(sqErr / all.length)),
    maxAbsError: round(maxErr),
    bitWidth: 1,
    note: 'Sign quantisation: weights → {−1, 0, +1}. यह trained model नहीं है—demo/untrained weights पर देखा गया effect है।',
  };
}

/* ── helpers ──────────────────────────────────────────────────────────── */

export function round(value, digits = 6) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function summarizePass(pass, digits = 4) {
  const f = (v) => round(v, digits);
  return {
    z1: pass.z1.map(f),
    h1: pass.h1.map(f),
    logits: pass.logits.map(f),
    output: pass.output.map(f),
  };
}
