import { validateContext } from './contracts.js';
import { inferMethods, improveMethod, compareMethod, batchBacktest, validateMethod, evaluateCandidate } from './strategy-engine.js';
import { validateResearchIntent, validateResearch, compactReport, validateAssumptions } from '../src/research-state.js';

export function executeResearch(input) {
  const intent = validateResearchIntent(input.intent);
  if (!intent) throw Object.assign(new Error('请选择交易方法操作。'), { status: 400 });
  const context = validateContext(input.context);
  const previous = validateResearch(input.research) || { methods: [], assumptions: {}, limitations: [] };
  const assumptions = validateAssumptions({ feeBps: 3, slippageBps: 5, lotSize: 100, ...previous.assumptions, ...input.assumptions, ...intent.assumptions });
  const saved = (input.methods || []).slice(0, 60).map(validateMethod);
  const candidates = [...previous.methods, ...saved];
  let inferred;
  const infer = () => inferred ||= inferMethods(context);
  const known = candidates.find(item => item.id === (intent.methodId || intent.method?.id));
  let method = known || intent.method || (!intent.methodId ? previous.methods.find(item => item.origin !== 'improved') : null);
  if (intent.method && !known) {
    const supplied = intent.method;
    if (supplied.origin === 'improved') throw Object.assign(new Error('改进版本需要关联已有的原方法。'), { status: 400 });
    if (supplied.origin === 'inferred') method = evaluateCandidate({ rules: supplied.rules, title: supplied.title, description: supplied.description, context }).method;
    else {
      const times = context.trades.map(item => item.time).sort();
      method = validateMethod({ title: supplied.title, description: supplied.description, rules: supplied.rules, origin: 'user-described', status: 'candidate', derivation: { symbol: context.marketData?.symbol || context.trades[0]?.symbol || '', from: times[0] || '', to: times.at(-1) || '', tradeIds: context.trades.map(item => item.id) } });
    }
  }
  if (intent.methodId && !method) throw Object.assign(new Error('所选交易方法已变化，请重新选择。'), { status: 400 });
  if (intent.changeIds && ['improve', 'save_improved'].includes(intent.action) && method?.origin === 'improved') {
    // Selecting part of a proposal means applying only those changes to the
    // version it was proposed against, not inheriting every proposed change.
    const parent = candidates.find(candidate => candidate.id === method.parentId);
    if (!parent || parent.id === method.id) throw Object.assign(new Error('未找到改进候选对应的原版本，无法只采纳部分改进；请补回原版本后重试。'), { status: 400 });
    method = parent;
  }
  if (!method) method = infer().methods?.[0];
  const research = { ...previous, assumptions, updatedAt: new Date().toISOString(), limitations: inferred?.limitations || previous.limitations, comparison: null, batch: null };
  let save = null;
  if (intent.action === 'infer') {
    const result = infer(); research.methods = intent.method ? [method, ...(result.methods || []).filter(item => item.id !== method.id)] : result.methods || []; research.limitations = result.limitations || (result.reason ? [result.reason] : []);
  } else if (!method) {
    research.methods = []; research.limitations = inferred?.limitations || ['缺少连续行情，暂时无法提炼可执行的方法。'];
  } else if (intent.action === 'batch') {
    if (!Array.isArray(input.datasets) || input.datasets.length > 30) throw Object.assign(new Error('最多同时回测 30 份行情。'), { status: 400 });
    const datasets = input.datasets.filter(item => !intent.datasetIds?.length || intent.datasetIds.includes(item.id)).map(item => {
      const clean = validateContext(item.context);
      return { id: String(item.id).slice(0, 120), marketData: clean.marketData, trades: clean.trades };
    });
    research.methods = [method]; research.batch = compactReport(batchBacktest({ method, datasets, ...assumptions }));
  } else {
    let target = method;
    if (['improve', 'save_improved'].includes(intent.action)) {
      target = intent.action === 'save_improved' && method.origin === 'improved' && !intent.changeIds ? method : intent.changeIds ? improveMethod(method, intent.changeIds) : previous.methods.find(item => item.origin === 'improved' && item.parentId === method.id) || improveMethod(method);
      research.methods = method.id === target.id ? [method] : [method, target];
    } else research.methods = [...previous.methods.filter(item => item.id !== method.id), method].slice(-8);
    if (['improve', 'compare', 'save_improved'].includes(intent.action)) research.comparison = compactReport(compareMethod({ method: target, context, ...assumptions }));
    if (['save_original', 'save_improved'].includes(intent.action)) save = validateMethod({ ...target, ...(intent.title ? { title: intent.title } : {}) });
  }
  return { research: validateResearch(research), savedMethod: save };
}
