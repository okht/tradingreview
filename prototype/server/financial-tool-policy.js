const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const forbiddenName = /(?:^|[_\-.])(?:create|delete|remove|update|write|submit|place|cancel|transfer|withdraw|deposit|execute|order|trade|buy|sell|approve|send|upload|download|shell|exec)(?:$|[_\-.])/i;

function scrubSchema(schema, depth = 0) {
  if (depth > 12 || !object(schema) || JSON.stringify(schema).length > 40000 || '$ref' in schema || '$dynamicRef' in schema) return null;
  const result = {};
  const scalarKeys = ['type', 'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'required'];
  for (const key of scalarKeys) if (schema[key] !== undefined) result[key] = clone(schema[key]);
  if (schema.properties !== undefined) {
    if (!object(schema.properties) || Object.keys(schema.properties).length > 100) return null;
    result.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      if (key.length > 100 || ['__proto__', 'prototype', 'constructor'].includes(key)) return null;
      const cleaned = scrubSchema(value, depth + 1); if (!cleaned) return null;
      Object.defineProperty(result.properties, key, { value: cleaned, enumerable: true });
    }
  }
  for (const key of ['items', 'additionalProperties', 'not']) if (schema[key] !== undefined) {
    if (typeof schema[key] === 'boolean') result[key] = schema[key];
    else { result[key] = scrubSchema(schema[key], depth + 1); if (!result[key]) return null; }
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (schema[key] !== undefined) {
    if (!Array.isArray(schema[key]) || schema[key].length > 12) return null;
    result[key] = schema[key].map(value => scrubSchema(value, depth + 1));
    if (result[key].some(value => !value)) return null;
  }
  return result;
}

// Discovery and Agent execution share this policy so a connection cannot claim
// callable tools that the Agent would subsequently discard.
export function readonlyFinancialToolSchema(entry) {
  if (!object(entry) || typeof entry.name !== 'string' || !/^[\w.\-]{1,200}$/.test(entry.name)
    || entry.annotations?.readOnlyHint !== true || entry.annotations?.destructiveHint === true
    || forbiddenName.test(entry.name) || entry.inputSchema?.type !== 'object') return null;
  return scrubSchema(entry.inputSchema);
}

export const MAX_FINANCIAL_TOOLS = 32;
