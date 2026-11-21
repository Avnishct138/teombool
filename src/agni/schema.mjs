/**
 * Minimal JSON-Schema subset validator used by the AGNi tool registry.
 *
 * Supported keywords: type, properties, required, additionalProperties, items,
 * enum, minimum, maximum, exclusiveMinimum/Maximum, minItems, maxItems,
 * minLength, maxLength, pattern, default, nullable.
 *
 * It never throws on bad input — it returns a list of readable errors so the
 * assistant can show the user *why* a tool call was rejected.
 */

const TYPE_CHECKS = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
};

const MAX_DEPTH = 12;

export function validate(schema, value, path = '$', depth = 0) {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;
  if (depth > MAX_DEPTH) return [`${path}: schema nesting बहुत गहरी है।`];

  if (Array.isArray(schema.type)) {
    if (!schema.type.some((t) => TYPE_CHECKS[t]?.(value))) {
      errors.push(`${path}: type ${schema.type.join('|')} अपेक्षित था।`);
      return errors;
    }
  } else if (schema.type) {
    if (schema.nullable && value === null) return errors;
    const check = TYPE_CHECKS[schema.type];
    if (!check) {
      errors.push(`${path}: अज्ञात schema type "${schema.type}".`);
      return errors;
    }
    if (!check(value)) {
      errors.push(`${path}: ${schema.type} अपेक्षित था।`);
      return errors;
    }
  }

  if (schema.enum && !schema.enum.some((e) => e === value)) {
    errors.push(`${path}: इनमें से एक होना चाहिए — ${schema.enum.join(', ')}।`);
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: ${schema.minimum} से कम नहीं हो सकता।`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: ${schema.maximum} से अधिक नहीं हो सकता।`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(`${path}: ${schema.exclusiveMinimum} से बड़ा होना चाहिए।`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) errors.push(`${path}: ${schema.exclusiveMaximum} से छोटा होना चाहिए।`);
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: कम से कम ${schema.minLength} अक्षर।`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: अधिकतम ${schema.maxLength} अक्षर।`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: pattern मेल नहीं खाता।`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: कम से कम ${schema.minItems} items।`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: अधिकतम ${schema.maxItems} items।`);
    if (schema.items) {
      value.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}[${i}]`, depth + 1)));
    }
  }

  if (TYPE_CHECKS.object(value)) {
    for (const key of schema.required || []) {
      if (!(key in value) || value[key] === undefined) errors.push(`${path}.${key}: यह field ज़रूरी है।`);
    }
    const props = schema.properties || {};
    for (const [key, sub] of Object.entries(props)) {
      if (value[key] === undefined) continue;
      errors.push(...validate(sub, value[key], `${path}.${key}`, depth + 1));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${path}.${key}: यह field मंज़ूर नहीं है।`);
      }
    }
  }

  return errors;
}

/** Apply schema defaults (shallow, top level only — enough for tool inputs). */
export function applyDefaults(schema, value) {
  if (!schema || typeof schema !== 'object' || !TYPE_CHECKS.object(value)) return value;
  const out = { ...value };
  for (const [key, sub] of Object.entries(schema.properties || {})) {
    if (out[key] === undefined && sub && 'default' in sub) out[key] = sub.default;
  }
  return out;
}
