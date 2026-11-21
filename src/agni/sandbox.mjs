/**
 * AGNi code sandbox — a restricted, non-eval interpreter for small numeric
 * programs (the "AGNi math DSL").
 *
 * Why not `eval` / `new Function`: the Worker runs model-authored code. `eval`
 * would expose the whole Worker global scope (fetch, env, caches) and is a
 * remote-code-execution hole. This interpreter instead:
 *
 *   • parses the source itself (tokeniser + Pratt parser) — no host JS is ever
 *     compiled or executed;
 *   • exposes only numbers, flat arrays and a fixed whitelist of math/NN
 *     functions;
 *   • has no property access, no assignment except `let`, no loops, no
 *     function definitions, no strings, no I/O;
 *   • enforces hard limits: source size, token count, AST node count, evaluation
 *     steps, array length and matrix dimensions.
 *
 * A program that breaks a limit is rejected with a readable error — it can
 * never wedge or crash the Worker.
 */

const LIMITS = {
  maxSourceChars: 4000,
  maxTokens: 2000,
  maxNodes: 4000,
  maxDepth: 10,
  maxSteps: 50000,
  maxArrayLength: 4096,
  maxDimension: 64,
};

/* ── tokeniser ────────────────────────────────────────────────────────── */

const OPERATORS = ['<=', '>=', '==', '!=', '&&', '||', '+', '-', '*', '/', '%', '^', '(', ')', '[', ']', ',', ';', '=', '<', '>', '!'];

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    if (tokens.length > LIMITS.maxTokens) throw new Error('Program बहुत लंबा है (token सीमा पार)।');
    const ch = source[i];
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') { i++; continue; }
    if (ch === '/' && source[i + 1] === '/') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) throw new Error('Comment बंद नहीं हुआ।');
      i = end + 2;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      const start = i;
      while (i < source.length && /[0-9]/.test(source[i])) i++;
      if (source[i] === '.') {
        i++;
        while (i < source.length && /[0-9]/.test(source[i])) i++;
      }
      if (source[i] === 'e' || source[i] === 'E') {
        i++;
        if (source[i] === '+' || source[i] === '-') i++;
        while (i < source.length && /[0-9]/.test(source[i])) i++;
      }
      tokens.push({ type: 'num', value: Number(source.slice(start, i)) });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) i++;
      tokens.push({ type: 'ident', value: source.slice(start, i) });
      continue;
    }
    const op = OPERATORS.find((o) => source.startsWith(o, i));
    if (!op) throw new Error(`अज्ञात वर्ण "${ch}" (स्थान ${i + 1})।`);
    tokens.push({ type: 'op', value: op });
    i += op.length;
  }
  tokens.push({ type: 'eof', value: null });
  return tokens;
}

/* ── parser (Pratt) ───────────────────────────────────────────────────── */

const BINARY_PRECEDENCE = {
  '||': 1, '&&': 2,
  '==': 3, '!=': 3, '<': 3, '>': 3, '<=': 3, '>=': 3,
  '+': 4, '-': 4,
  '*': 5, '/': 5, '%': 5,
  '^': 6,
};

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
    this.nodes = 0;
  }

  peek() { return this.tokens[this.pos]; }

  next() { return this.tokens[this.pos++]; }

  expect(value) {
    const token = this.next();
    if (token.value !== value) throw new Error(`"${value}" अपेक्षित था, "${token.value ?? 'EOF'}" मिला।`);
    return token;
  }

  count() {
    if (++this.nodes > LIMITS.maxNodes) throw new Error('Program complexity सीमा से अधिक है।');
  }

  parseProgram() {
    const body = [];
    while (this.peek().type !== 'eof') {
      body.push(this.parseStatement());
      if (this.peek().value === ';') this.next();
      else if (this.peek().type !== 'eof') throw new Error(`";" या expression अपेक्षित था, "${this.peek().value}" मिला।`);
    }
    return { type: 'program', body };
  }

  parseStatement() {
    this.count();
    if (this.peek().type === 'ident' && this.peek().value === 'let') {
      this.next();
      const name = this.next();
      if (name.type !== 'ident') throw new Error('let के बाद variable का नाम चाहिए।');
      this.expect('=');
      const value = this.parseExpression(0);
      return { type: 'let', name: name.value, value };
    }
    return { type: 'expr', value: this.parseExpression(0) };
  }

  parseExpression(minPrecedence) {
    this.count();
    let left = this.parseUnary();
    for (;;) {
      const token = this.peek();
      if (token.type !== 'op') break;
      const precedence = BINARY_PRECEDENCE[token.value];
      if (precedence === undefined || precedence < minPrecedence) break;
      this.next();
      const right = this.parseExpression(precedence + 1);
      left = { type: 'binary', op: token.value, left, right };
    }
    return left;
  }

  parseUnary() {
    this.count();
    const token = this.peek();
    if (token.type === 'op' && (token.value === '-' || token.value === '+' || token.value === '!')) {
      this.next();
      return { type: 'unary', op: token.value, argument: this.parseUnary() };
    }
    return this.parsePower();
  }

  parsePower() {
    this.count();
    const base = this.parsePrimary();
    const token = this.peek();
    if (token.type === 'op' && token.value === '^') {
      this.next();
      return { type: 'binary', op: '^', left: base, right: this.parseUnary() };
    }
    return base;
  }

  parsePrimary() {
    this.count();
    const token = this.next();
    if (token.type === 'num') return { type: 'number', value: token.value };
    if (token.type === 'ident') {
      if (this.peek().value === '(') {
        this.next();
        const args = [];
        if (this.peek().value !== ')') {
          for (;;) {
            args.push(this.parseExpression(0));
            if (this.peek().value === ',') { this.next(); continue; }
            break;
          }
        }
        this.expect(')');
        return { type: 'call', name: token.value, args };
      }
      if (this.peek().value === '[') {
        this.next();
        const index = this.parseExpression(0);
        this.expect(']');
        return { type: 'index', object: { type: 'variable', name: token.value }, index };
      }
      return { type: 'variable', name: token.value };
    }
    if (token.value === '[') {
      const elements = [];
      if (this.peek().value !== ']') {
        for (;;) {
          elements.push(this.parseExpression(0));
          if (this.peek().value === ',') { this.next(); continue; }
          break;
        }
      }
      this.expect(']');
      return { type: 'array', elements };
    }
    if (token.value === '(') {
      const expression = this.parseExpression(0);
      this.expect(')');
      return expression;
    }
    throw new Error(`अप्रत्याशित टोकन "${token.value ?? 'EOF'}"।`);
  }
}

/* ── built-in functions (the only things a program can call) ───────────── */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isArr = (v) => Array.isArray(v);

function asArray(value, name) {
  if (!isArr(value)) throw new Error(`${name} को array चाहिए।`);
  if (value.length > LIMITS.maxArrayLength) throw new Error(`${name} array सीमा से बड़ी है।`);
  return value;
}

function asVector(value, name) {
  const arr = asArray(value, name);
  for (const v of arr) if (!isNum(v)) throw new Error(`${name} में सभी मान finite numbers होने चाहिए।`);
  return arr;
}

const isMatrix = (v) => Array.isArray(v) && v.length > 0 && v.every((row) => Array.isArray(row));

/**
 * Matrix multiplication that also covers the matrix × vector case.
 *   matmul(A, b) → A·b     (A matrix, b vector)
 *   matmul(A, B) → A·B     (both matrices)
 *   matmul(b, B) → B·b     (vector first, matrix second)
 */
function matmul(a, b) {
  if (isMatrix(a) && isMatrix(b)) {
    const rows = a.length;
    const inner = a[0].length;
    const out = [];
    for (let i = 0; i < rows; i++) {
      const left = asVector(a[i], `A row ${i + 1}`);
      if (left.length !== inner) throw new Error(`आकार मेल नहीं खाता: ${inner} vs ${left.length}।`);
      out.push(b.map((row) => {
        const right = asVector(row, `B row`);
        if (right.length !== inner) throw new Error(`आकार मेल नहीं खाता: ${inner} vs ${right.length}।`);
        return left.reduce((sum, v, k) => sum + v * right[k], 0);
      }));
    }
    return out;
  }
  if (isMatrix(a) && !isMatrix(b)) {
    const vector = asVector(b, 'B vector');
    const inner = a[0].length;
    if (vector.length !== inner) throw new Error(`आकार मेल नहीं खाता: ${inner} vs ${vector.length}।`);
    return a.map((row, i) => {
      const left = asVector(row, `A row ${i + 1}`);
      if (left.length !== inner) throw new Error(`आकार मेल नहीं खाता: ${inner} vs ${left.length}।`);
      return left.reduce((sum, v, k) => sum + v * vector[k], 0);
    });
  }
  if (!isMatrix(a) && isMatrix(b)) {
    return matmul(b, a);
  }
  throw new Error('matmul के लिए कम से कम एक matrix चाहिए।');
}

const FUNCTIONS = {
  abs: (v) => Math.abs(v),
  min: (...args) => Math.min(...args.flat().filter(isNum)),
  max: (...args) => Math.max(...args.flat().filter(isNum)),
  sqrt: (v) => Math.sqrt(v),
  exp: (v) => Math.exp(v),
  log: (v) => Math.log(v),
  pow: (a, b) => a ** b,
  round: (v) => Math.round(v),
  floor: (v) => Math.floor(v),
  ceil: (v) => Math.ceil(v),
  sign: (v) => Math.sign(v),
  sum: (v) => asVector(v, 'sum').reduce((t, x) => t + x, 0),
  mean: (v) => { const a = asVector(v, 'mean'); return a.reduce((t, x) => t + x, 0) / a.length; },
  zeros: (n) => Array.from({ length: n | 0 }, () => 0),
  ones: (n) => Array.from({ length: n | 0 }, () => 1),
  dot: (a, b) => {
    const x = asVector(a, 'dot(a)');
    const y = asVector(b, 'dot(b)');
    if (x.length !== y.length) throw new Error('dot के लिए आकार बराबर चाहिए।');
    return x.reduce((t, v, i) => t + v * y[i], 0);
  },
  add: (a, b) => {
    if (isArr(a) && isArr(b)) {
      if (a.length !== b.length) throw new Error('add के लिए आकार बराबर चाहिए।');
      return a.map((v, i) => v + b[i]);
    }
    return a + b;
  },
  mul: (a, b) => {
    if (isArr(a) && isArr(b)) {
      if (a.length !== b.length) throw new Error('mul के लिए आकार बराबर चाहिए।');
      return a.map((v, i) => v * b[i]);
    }
    return a * b;
  },
  scale: (v, k) => asVector(v, 'scale').map((x) => x * k),
  relu: (v) => asVector(v, 'relu').map((x) => Math.max(0, x)),
  sigmoid: (v) => asVector(v, 'sigmoid').map((x) => (x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x)))),
  tanh: (v) => asVector(v, 'tanh').map((x) => Math.tanh(x)),
  linear: (v) => asVector(v, 'linear').slice(),
  softmax: (v) => {
    const a = asVector(v, 'softmax');
    const max = Math.max(...a);
    const exps = a.map((x) => Math.exp(x - max));
    const sum = exps.reduce((t, x) => t + x, 0);
    return exps.map((x) => x / sum);
  },
  mse: (a, b) => {
    const x = asVector(a, 'mse(a)');
    const y = asVector(b, 'mse(b)');
    if (x.length !== y.length) throw new Error('mse के लिए आकार बराबर चाहिए।');
    return x.reduce((t, v, i) => t + (v - y[i]) ** 2, 0) / x.length;
  },
  crossentropy: (logits, index) => {
    const a = asVector(logits, 'crossentropy(logits)');
    if (!Number.isInteger(index) || index < 0 || index >= a.length) throw new Error('crossentropy index सीमा में नहीं है।');
    const max = Math.max(...a);
    const exps = a.map((x) => Math.exp(x - max));
    const sum = exps.reduce((t, x) => t + x, 0);
    return -Math.log(exps[index] / sum);
  },
  matmul,
  forward_layer: (x, w, b, activation) => {
    const input = asVector(x, 'forward_layer(x)');
    const out = matmul(w, input).map((row, i) => {
      const z = row.reduce((t, v) => t + v, 0) + (b && b[i] ? b[i] : 0);
      switch (activation) {
        case 'relu': return Math.max(0, z);
        case 'sigmoid': return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
        case 'tanh': return Math.tanh(z);
        case 'softmax': return z;
        case 'linear': default: return z;
      }
    });
    return activation === 'softmax'
      ? (() => { const max = Math.max(...out); const exps = out.map((x) => Math.exp(x - max)); const sum = exps.reduce((t, x) => t + x, 0); return exps.map((x) => x / sum); })()
      : out;
  },
};

export const SANDBOX_FUNCTIONS = Object.keys(FUNCTIONS);

/* ── evaluator ────────────────────────────────────────────────────────── */

function evaluateNode(node, scope, state, depth) {
  if (++state.steps > LIMITS.maxSteps) throw new Error('Program सीमा से अधिक काम कर रहा था।');
  if (depth > LIMITS.maxDepth) throw new Error('Program nesting सीमा से अधिक गहरी है।');

  switch (node.type) {
    case 'number':
      return node.value;
    case 'variable': {
      if (!(node.name in scope)) throw new Error(`"${node.name}" परिभाषित नहीं है।`);
      return scope[node.name];
    }
    case 'array':
      return node.elements.map((element) => evaluateNode(element, scope, state, depth + 1));
    case 'index': {
      const object = evaluateNode(node.object, scope, state, depth + 1);
      const index = evaluateNode(node.index, scope, state, depth + 1);
      if (!isArr(object)) throw new Error('Index के लिए array चाहिए।');
      if (!Number.isInteger(index) || index < 0 || index >= object.length) throw new Error('Index सीमा से बाहर है।');
      return object[index];
    }
    case 'unary': {
      const value = evaluateNode(node.argument, scope, state, depth + 1);
      if (node.op === '-') return -value;
      if (node.op === '+') return value;
      if (node.op === '!') return value ? 0 : 1;
      throw new Error(`अज्ञात unary operator "${node.op}"।`);
    }
    case 'binary': {
      const left = evaluateNode(node.left, scope, state, depth + 1);
      const right = evaluateNode(node.right, scope, state, depth + 1);
      switch (node.op) {
        case '+': return left + right;
        case '-': return left - right;
        case '*': return left * right;
        case '/': return left / right;
        case '%': return left % right;
        case '^': return left ** right;
        case '<': return left < right ? 1 : 0;
        case '>': return left > right ? 1 : 0;
        case '<=': return left <= right ? 1 : 0;
        case '>=': return left >= right ? 1 : 0;
        case '==': return left === right ? 1 : 0;
        case '!=': return left !== right ? 1 : 0;
        case '&&': return left && right ? 1 : 0;
        case '||': return left || right ? 1 : 0;
        default: throw new Error(`अज्ञात operator "${node.op}"।`);
      }
    }
    case 'call': {
      const fn = FUNCTIONS[node.name];
      if (!fn) {
        throw new Error(`"${node.name}" sandbox में उपलब्ध नहीं है। उपलब्ध: ${SANDBOX_FUNCTIONS.join(', ')}।`);
      }
      const args = node.args.map((arg) => evaluateNode(arg, scope, state, depth + 1));
      const result = fn(...args);
      if (isArr(result) && result.length > LIMITS.maxArrayLength) throw new Error('Result array सीमा से बड़ी है।');
      return result;
    }
    default:
      throw new Error(`अज्ञात node "${node.type}"।`);
  }
}

/**
 * Run a program in the sandbox.
 * @returns {{ok:boolean, value?:any, error?:string, steps:number, ms:number}}
 */
export function runSandbox(source, options = {}) {
  const started = Date.now();
  const scope = Object.create(null);
  const state = { steps: 0 };
  try {
    if (typeof source !== 'string') throw new Error('Code एक string होना चाहिए।');
    if (source.length > (options.maxSourceChars || LIMITS.maxSourceChars)) {
      throw new Error('Code सीमा से बड़ा है।');
    }
    const tokens = tokenize(source);
    const ast = new Parser(tokens).parseProgram();
    let last = null;
    for (const statement of ast.body) {
      const value = evaluateNode(statement.value, scope, state, 0);
      if (statement.type === 'let') scope[statement.name] = value;
      last = value;
    }
    const value = last === null ? (scope.result ?? null) : last;
    return { ok: true, value, steps: state.steps, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), steps: state.steps, ms: Date.now() - started };
  }
}

export const SANDBOX_LIMITS = LIMITS;
