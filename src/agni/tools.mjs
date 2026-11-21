/**
 * AGNi tool registry.
 *
 * Every entry has:
 *   name          — stable tool id (the only names the model may call)
 *   description   — what the tool does (sent to the model)
 *   inputSchema   — JSON-schema subset used for validation
 *   validate      — extra semantic checks on top of the schema
 *   execute       — the handler; returns { ok, result } or { ok:false, error }
 *
 * The registry IS the allow-list: `executeTool()` refuses anything that is not
 * registered here, so the model can never reach a function outside this file.
 */

import { validate as validateSchema, applyDefaults } from './schema.mjs';
import {
  ACTIVATIONS, forwardPass, summarizePass, applyActivation, scalarActivation,
  weightStats, quantize1Bit, trainStep, createInitialModel, denseForward,
  buildDenseModel, round,
} from './math-core.mjs';
import { runSandbox, SANDBOX_FUNCTIONS } from './sandbox.mjs';

const MAX_DIFF_ROWS = 40;

class ToolError extends Error {}

const numArray = (schema) => ({
  type: 'array',
  items: { type: 'number' },
  ...schema,
});

/* ── helpers ──────────────────────────────────────────────────────────── */

function requireModel(context) {
  const weights = context?.weights;
  if (!weights || !Array.isArray(weights.w1) || !Array.isArray(weights.b1) ||
      !Array.isArray(weights.w2) || !Array.isArray(weights.b2)) {
    throw new ToolError('इस पेज पर अभी weights उपलब्ध नहीं हैं (Lab playground खोलें)।');
  }
  return weights;
}

function diffArrays(before, after, prefix, limit = MAX_DIFF_ROWS) {
  const rows = [];
  const walk = (a, b, path) => {
    if (rows.length >= limit) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.max(a.length, b.length); i++) walk(a[i], b[i], `${path}[${i}]`);
      return;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        walk(a[key], b[key], path ? `${path}.${key}` : key);
      }
      return;
    }
    if (formatCell(a) === formatCell(b)) return;
    rows.push({ path, before: formatCell(a), after: formatCell(b) });
  };
  walk(before, after, prefix);
  return rows;
}

function formatCell(value) {
  if (value === undefined) return '—';
  if (typeof value === 'number') return String(round(value, 6));
  return String(value);
}

/* ── the registry ─────────────────────────────────────────────────────── */

export const TOOLS = [
  {
    name: 'agni.forward_pass',
    description:
      'AGNi Lab के 4 → 16 → 3 dense network पर वास्तविक forward propagation चलाएँ। ' +
      'z₁, hidden activation, logits और final output वापस मिलते हैं। ' +
      'Inputs: inputs (4 numbers), weights (w1,b1,w2,b2 — current page state से लिए जाते हैं), ' +
      'hiddenActivation, outputActivation.',
    inputSchema: {
      type: 'object',
      properties: {
        inputs: numArray({ minItems: 4, maxItems: 4, description: '4 input values' }),
        hiddenActivation: { type: 'string', enum: [...ACTIVATIONS], default: 'relu' },
        outputActivation: { type: 'string', enum: [...ACTIVATIONS], default: 'softmax' },
        useCurrentWeights: { type: 'boolean', default: true, description: 'true होने पर पेज के मौजूदा weights उपयोग होंगे' },
      },
      required: ['inputs'],
      additionalProperties: false,
    },
    validate(input) {
      if (!input.useCurrentWeights) {
        const weights = requireModel(input.__context);
        if (!weights.w1?.length) throw new ToolError('useCurrentWeights=false पर weights अनिवार्य हैं।');
      }
      return [];
    },
    async execute(input, ctx) {
      const model = requireModel(ctx.context);
      const pass = forwardPass(input.inputs, model, input.hiddenActivation, input.outputActivation);
      const winner = pass.output.indexOf(Math.max(...pass.output));
      return {
        ok: true,
        result: {
          ...summarizePass(pass),
          winnerIndex: winner,
          note: 'यह गणना untrained demo weights पर है—AGNi का trained model output नहीं।',
        },
      };
    },
  },

  {
    name: 'agni.activation',
    description:
      'किसी activation function (relu, sigmoid, tanh, linear, softmax) के मान और उसके ' +
      'derivative/व्यवहार की जाँच करें। Teaching Mode में formula समझाने के लिए उपयोगी है।',
    inputSchema: {
      type: 'object',
      properties: {
        activation: { type: 'string', enum: [...ACTIVATIONS] },
        values: numArray({ minItems: 1, maxItems: 64 }),
      },
      required: ['activation', 'values'],
      additionalProperties: false,
    },
    async execute(input) {
      const output = applyActivation(input.values, input.activation);
      const single = input.activation === 'softmax'
        ? null
        : { input: input.values[0], output: scalarActivation(input.values[0], input.activation) };
      return {
        ok: true,
        result: {
          activation: input.activation,
          input: input.values,
          output: output.map((v) => round(v, 6)),
          firstScalar: single,
          formula: {
            relu: 'max(0, z)',
            sigmoid: '1 / (1 + e^-z)',
            tanh: 'tanh(z)',
            linear: 'z',
            softmax: 'e^z / Σ e^z  (outputs का योग 1)',
          }[input.activation],
        },
      };
    },
  },

  {
    name: 'agni.architecture',
    description:
      'AGNi model architecture की जाँच और सारांश: dense layers की chain (in, out, activation) ' +
      'validate करें, parameter count निकालें, या मौजूदा 4-16-3 architecture का विवरण दें।',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['validate', 'describe', 'propose'], default: 'describe' },
        layers: {
          type: 'array',
          maxItems: 12,
          items: {
            type: 'object',
            properties: {
              in: { type: 'integer', minimum: 1, maximum: 64 },
              out: { type: 'integer', minimum: 1, maximum: 64 },
              activation: { type: 'string', enum: [...ACTIVATIONS] },
            },
            required: ['in', 'out', 'activation'],
            additionalProperties: false,
          },
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    validate(input) {
      if (input.action !== 'describe' && !Array.isArray(input.layers) || (input.action !== 'describe' && !input.layers?.length)) {
        throw new ToolError('layers दिए बिना validate/propose नहीं हो सकता।');
      }
      const layers = input.layers || [];
      for (let i = 1; i < layers.length; i++) {
        if (layers[i].in !== layers[i - 1].out) {
          throw new ToolError(`Layer ${i + 1} का input ${layers[i].in} है, पर पिछले layer का output ${layers[i - 1].out} है — chain टूटी है।`);
        }
      }
      return [];
    },
    async execute(input) {
      const layers = input.layers || [
        { in: 4, out: 16, activation: 'relu' },
        { in: 16, out: 3, activation: 'softmax' },
      ];
      let params = 0;
      const summary = layers.map((layer, index) => {
        params += layer.in * layer.out + layer.out;
        return {
          index: index + 1,
          shape: `${layer.in} → ${layer.out}`,
          activation: layer.activation,
          parameters: layer.in * layer.out + layer.out,
        };
      });
      return {
        ok: true,
        result: {
          action: input.action,
          layers: summary,
          totalParameters: params,
          currentPlayground: '4 → 16 → 3 (16 hidden neurons, ReLU hidden, Softmax output)',
          note: 'यह architecture का गणना है—यह trained model नहीं है।',
        },
      };
    },
  },

  {
    name: 'agni.weights_report',
    description:
      'मौजूदा weights और biases का विश्लेषण: shape validation, mean/std, sparsity, ' +
      'sign distribution और 1-bit sign quantisation का अनुमानित error।',
    inputSchema: {
      type: 'object',
      properties: {
        includeQuantization: { type: 'boolean', default: true },
      },
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const model = requireModel(ctx.context);
      const stats = weightStats(model);
      const quantization = input.includeQuantization ? quantize1Bit(model) : null;
      return {
        ok: true,
        result: {
          stats,
          quantization: quantization && {
            rmse: quantization.rmse,
            maxAbsError: quantization.maxAbsError,
            bitWidth: quantization.bitWidth,
            note: quantization.note,
          },
          note: 'ये demo/untrained weights के आँकड़े हैं, trained model के नहीं।',
        },
      };
    },
  },

  {
    name: 'agni.quantize_1bit',
    description:
      'Weights को 1-bit sign quantisation (−1 / 0 / +1) में बदलें और float से तुलना करें ' +
      '(RMSE, max absolute error)। AGNi के 1-bit direction का परीक्षण करने का तरीका। ' +
      'apply=true (default) पर बदलाव का preview proposal बनता है — वह user की मंज़ूरी के बिना लागू नहीं होता; apply=false से केवल report मिलता है ' +
      'जो user की मंज़ूरी के बिना लागू नहीं होता।',
    inputSchema: {
      type: 'object',
      properties: {
        apply: { type: 'boolean', default: true, description: 'true (default) होने पर बदलाव का preview/approval proposal बनता है — वह user की मंज़ूरी के बिना लागू नहीं होता' },
      },
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const model = requireModel(ctx.context);
      const result = quantize1Bit(model);
      if (!input.apply) {
        return {
          ok: true,
          result: {
            rmse: result.rmse,
            maxAbsError: result.maxAbsError,
            bitWidth: result.bitWidth,
            note: result.note,
            quantizedWeights: result.quantized,
          },
        };
      }
      return {
        ok: true,
        result: { rmse: result.rmse, maxAbsError: result.maxAbsError, note: result.note },
        proposal: {
          kind: 'weights',
          title: '1-bit sign quantisation लागू करें',
          summary: 'सभी weights/biases को −1 / 0 / +1 में बदला जाएगा।',
          payload: { type: 'set-weights', ...result.quantized },
          diff: diffArrays(
            { w1: model.w1, b1: model.b1, w2: model.w2, b2: model.b2 },
            result.quantized,
            'weights'
          ),
        },
      };
    },
  },

  {
    name: 'agni.train_step',
    description:
      'वर्तमान weights पर एक SGD training step (cross-entropy loss) चलाएँ और loss before/after ' +
      'बताएँ। apply=false (default) से केवल गणना होती है। apply=true पर server एक proposal बनाता है — ' +
      'वह proposal उपयोगकर्ता को preview के रूप में दिखता है और बिना approve किए लागू नहीं होता। ' +
      'बदलाव के लिए apply=true (default) भेजो — proposal preview में दिखेगा और approve होने पर ही लागू होगा।',
    inputSchema: {
      type: 'object',
      properties: {
        input: numArray({ minItems: 4, maxItems: 4 }),
        targetIndex: { type: 'integer', minimum: 0, maximum: 2 },
        learningRate: { type: 'number', minimum: 0.0001, maximum: 0.5, default: 0.05 },
        hiddenActivation: { type: 'string', enum: [...ACTIVATIONS], default: 'relu' },
        apply: { type: 'boolean', default: true, description: 'true (default) = preview proposal बनता है; apply नहीं होता जब तक user approve न करे' },
      },
      required: ['input', 'targetIndex'],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const model = requireModel(ctx.context);
      const step = trainStep({
        input: input.input,
        targetIndex: input.targetIndex,
        model,
        hiddenActivation: input.hiddenActivation,
        learningRate: input.learningRate,
      });
      const base = {
        lossBefore: round(step.lossBefore, 6),
        lossAfter: round(step.lossAfter, 6),
        learningRate: input.learningRate,
        output: step.pass.output.map((v) => round(v, 6)),
        note: 'यह एक demo training step है—labelled dataset या trained model नहीं।',
      };
      if (!input.apply) return { ok: true, result: base };
      return {
        ok: true,
        result: base,
        proposal: {
          kind: 'weights',
          title: 'SGD training step के बाद weights लागू करें',
          summary: `loss ${round(step.lossBefore, 4)} → ${round(step.lossAfter, 4)} (lr=${input.learningRate})`,
          payload: { type: 'set-weights', ...step.updated },
          diff: diffArrays(model, step.updated, 'weights'),
        },
      };
    },
  },

  {
    name: 'agni.sandbox_eval',
    description:
      'छोटा numeric/ML program सुरक्षित sandbox में चलाएँ और परिणाम लें। ' +
      'भाषा: AGNi math DSL (numbers, arrays, let, और whitelisted functions जैसे relu, ' +
      'sigmoid, tanh, softmax, matmul, dot, mse, crossentropy, forward_layer, sum, mean)। ' +
      'कोई file/network/process access नहीं।',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', minLength: 1, maxLength: 4000 },
        explanation: { type: 'string', maxLength: 400 },
      },
      required: ['code'],
      additionalProperties: false,
    },
    async execute(input) {
      const result = runSandbox(input.code);
      return {
        ok: true,
        result: {
          sandboxed: true,
          success: result.ok,
          value: result.ok ? result.value : null,
          error: result.ok ? null : result.error,
          steps: result.steps,
          ms: result.ms,
          availableFunctions: SANDBOX_FUNCTIONS,
          note: 'Program Worker के sandboxed interpreter में चला; Worker का कोई global scope उसे नहीं मिला।',
        },
      };
    },
  },

  {
    name: 'agni.code_preview',
    description:
      'C / C++ / JavaScript / Python में छोटा implementation code तैयार करें और उसका ' +
      'preview दें (syntax smoke-check + diff summary)। Code यहाँ execute नहीं होता — ' +
      'जाँच और लागू करने का काम user करे।',
    inputSchema: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: ['c', 'cpp', 'javascript', 'python'] },
        source: { type: 'string', minLength: 10, maxLength: 8000 },
        purpose: { type: 'string', maxLength: 300 },
      },
      required: ['language', 'source'],
      additionalProperties: false,
    },
    async execute(input) {
      const lines = input.source.split('\n');
      const checks = [
        { name: 'braces balanced', ok: countOf(input.source, '{') === countOf(input.source, '}') },
        { name: 'parens balanced', ok: countOf(input.source, '(') === countOf(input.source, ')') },
        { name: 'no obvious placeholder', ok: !/\bTODO\b|\bFIXME\b|\.\.\./.test(input.source) },
      ];
      return {
        ok: true,
        result: {
          language: input.language,
          purpose: input.purpose || '',
          lineCount: lines.length,
          charCount: input.source.length,
          checks,
          source: input.source,
          note: 'यह preview है—यह code server पर compile/run नहीं हुआ। दाँवा यहाँ से चलाना user की ज़िम्मेदारी है।',
        },
      };
    },
  },

  {
    name: 'agni.project_context',
    description:
      'फिलहाल खुले AGNi page की current project state लें: architecture, activations, ' +
      'inputs, weights का summary और last run की जानकारी।',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_input, ctx) {
      const context = ctx.context || {};
      const model = context.weights;
      return {
        ok: true,
        result: {
          page: context.page || 'unknown',
          model: context.model || null,
          inputs: context.inputs || null,
          weightsSummary: model
            ? { shapes: weightStats(model).shapes, parameterCount: model.w1.length * model.w1[0].length + model.b1.length + model.w2.length * model.w2[0].length + model.b2.length }
            : null,
          projectState: context.projectState || null,
        },
      };
    },
  },
];

function countOf(text, char) {
  let n = 0;
  for (const c of text) if (c === char) n++;
  return n;
}

export const TOOL_MAP = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** OpenAI-style function-calling descriptors for the LLM. */
export function toolDefinitions() {
  return TOOLS.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

/**
 * Execute a tool by name. Unknown names are refused — the model can only run
 * tools that are registered in this file.
 */
export async function executeTool(name, rawInput, ctx) {
  const tool = TOOL_MAP.get(name);
  if (!tool) {
    return { ok: false, error: `"${name}" एक अनुमत tool नहीं है।`, tool: name, status: 'error' };
  }
  const input = applyDefaults(tool.inputSchema, rawInput && typeof rawInput === 'object' ? { ...rawInput } : {});
  const schemaErrors = validateSchema(tool.inputSchema, input);
  if (schemaErrors.length) {
    return { ok: false, error: schemaErrors.join(' '), tool: name, status: 'error', input };
  }
  try {
    const extra = tool.validate ? tool.validate({ ...input, __context: ctx.context }) : [];
    if (extra.length) return { ok: false, error: extra.join(' '), tool: name, status: 'error', input };
    const outcome = await tool.execute(input, ctx);
    return { ...outcome, tool: name, status: outcome.ok ? 'ok' : 'error', input };
  } catch (error) {
    return {
      ok: false,
      status: 'error',
      tool: name,
      input,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export { ToolError, diffArrays };
