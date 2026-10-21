import { validateMethod } from '../server/strategy-engine.js';

const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export const RESEARCH_ACTIONS = ['infer', 'improve', 'compare', 'save_original', 'save_improved', 'batch'];
export function validateResearchIntent(input) {
  if (input == null) return null;
  if (!object(input) || !RESEARCH_ACTIONS.includes(input.action)) fail('交易方法操作无效。');
  const output = { action: input.action };
  for (const key of ['methodId', 'title']) if (input[key] != null) {
    if (typeof input[key] !== 'string' || input[key].length > 200) fail('交易方法引用无效。');
    output[key] = input[key];
  }
  if (input.method != null) output.method = validateMethod(input.method);
  if (input.changeIds != null) {
    if (!Array.isArray(input.changeIds) || !input.changeIds.length || input.changeIds.some(id => !['position', 'stop-loss', 'max-hold'].includes(id))) fail('改进项选择无效。');
    output.changeIds = [...new Set(input.changeIds)];
  }
  if (input.assumptions != null) output.assumptions = validateAssumptions(input.assumptions);
  if (input.datasetIds != null) {
    if (!Array.isArray(input.datasetIds) || input.datasetIds.length > 30 || input.datasetIds.some(id => typeof id !== 'string' || id.length > 120)) fail('回测标的范围无效。');
    output.datasetIds = [...new Set(input.datasetIds)];
  }
  return output;
}
export function validateAssumptions(input = {}) {
  if (!object(input)) fail('回测参数无效。');
  const output = {};
  for (const [key, min, max] of [['initialCapital', 1, 1e12], ['feeBps', 0, 1000], ['slippageBps', 0, 1000], ['lotSize', 1, 10000]]) {
    if (input[key] == null || input[key] === '') continue;
    const number = input[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max || (key === 'lotSize' && !Number.isInteger(number))) fail('请填写有效的资金、成本与交易单位。');
    output[key] = number;
  }
  for (const key of ['from', 'to']) if (input[key]) {
    if (typeof input[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input[key]) || !Number.isFinite(Date.parse(input[key])) || new Date(`${input[key]}T00:00:00Z`).toISOString().slice(0, 10) !== input[key]) fail('回测日期无效。');
    output[key] = input[key];
  }
  if (output.from && output.to && output.from > output.to) fail('开始日期应早于结束日期。');
  return output;
}
// Persist compact report snapshots; the server always recomputes a new run.
// Executions/curves are returned for inspection but do not inflate the workspace.
export function compactReport(value) {
  const cleaned = JSON.parse(JSON.stringify(value, (key, item) => {
    if (/^(?:apiKey|token|secret|password|authorization|config|equityCurve|executions)$/i.test(key)) return undefined;
    if (typeof item === 'number' && !Number.isFinite(item)) fail('计算结果含无效数值。');
    return item;
  }));
  if (JSON.stringify(cleaned).length > 120000) fail('计算报告超过保存范围，请缩小标的数量。');
  return cleaned;
}
export function validateResearch(input) {
  if (input == null) return null;
  if (!object(input) || !Array.isArray(input.methods) || input.methods.length > 8) fail('交易方法研究记录无效。');
  return {
    methods: input.methods.map(validateMethod),
    assumptions: validateAssumptions(input.assumptions || {}),
    comparison: input.comparison == null ? null : compactReport(input.comparison),
    batch: input.batch == null ? null : compactReport(input.batch),
    limitations: Array.isArray(input.limitations) ? input.limitations.slice(0, 20).map(item => String(item).slice(0, 2000)) : [],
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt.slice(0, 40) : '',
  };
}
export function saveMethodVersion(existing, method) {
  const clean = validateMethod(method);
  // An explicit save is idempotent; editing creates a different version/id.
  const saved = existing.find(item => item.id === clean.id);
  if (saved) {
    const previous = validateMethod(saved);
    if (previous.version !== clean.version || previous.parentId !== clean.parentId || previous.origin !== clean.origin || JSON.stringify(previous.rules) !== JSON.stringify(clean.rules)) fail('同一方法版本的规则发生冲突，请重新生成新版本；已有版本保留。');
    return existing;
  }
  if (existing.length >= 60) fail('交易方法已达到 60 个版本，请先导出整理。');
  return [...existing, clean];
}
export function saveMethodVersions(existing, methods) {
  return methods.reduce((versions, method) => saveMethodVersion(versions, method), existing);
}
