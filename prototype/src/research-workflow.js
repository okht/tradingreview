import { compactReport, saveMethodVersion, saveMethodVersions } from './research-state.js';

const list = value => Array.isArray(value) ? value : [];
const uniqueMethods = methods => [...new Map(methods.map(method => [method.id, method])).values()];
const metricKeys = ['netPnl', 'returnPct', 'maxDrawdownPct', 'sharpe', 'fees', 'tradeCount'];
const finite = value => typeof value === 'number' && Number.isFinite(value);

// This only recognizes explicit percentage/stop-loss phrases. It is a narrow
// mismatch guard, not a general natural-language parameter parser.
function explicitStopLoss(text) {
  const values = new Set();
  const patterns = [/止损(?:阈值|条件|比例|幅度|线)?(?:设为|设成|改为|改成|调整为|调至|设置为|设置成|到|为|是|：|:)?\s*(\d+(?:\.\d+)?)\s*[%％]/g, /(\d+(?:\.\d+)?)\s*[%％]\s*(?:的)?(?:收盘确认|收盘|确认|触发)?止损/g];
  for (const pattern of patterns) for (const match of String(text || '').matchAll(pattern)) {
    if (/(?:原|原本|原来|已有)(?:的)?$|(?:不要|不采用|排除|不是)(?:用|采用|设置)?$/.test(String(text).slice(Math.max(0, match.index - 6), match.index))) continue;
    values.add(Number(match[1]));
  }
  return values.size === 1 ? [...values][0] : null;
}

function verifyRequestedStopLoss(improved, { requestText, replyText } = {}) {
  for (const [text, label] of [[requestText, '你指定'], [replyText, '回复中提出']]) {
    const requested = explicitStopLoss(text);
    if (requested != null && requested !== improved.rules.stopLossPct) throw new Error(`${label}的止损为 ${requested}%，当前可执行方案${improved.rules.stopLossPct == null ? '未设置止损' : `的止损为 ${improved.rules.stopLossPct}%`}。本次未保存改进版，已有方法保留；请核对支持的规则后再采纳。`);
  }
}

function pairReport(original, improved, originalReport, improvedReport, context, error) {
  const baseline = originalReport?.alternative || null, alternative = improvedReport?.alternative || null;
  const sameConditions = baseline?.symbol === alternative?.symbol && JSON.stringify(baseline?.assumptions) === JSON.stringify(alternative?.assumptions);
  const sameVersions = baseline?.methodId === original.id && alternative?.methodId === improved.id;
  const ready = !error && baseline?.status === 'ok' && alternative?.status === 'ok' && baseline.metrics && alternative.metrics && sameConditions && sameVersions;
  return compactReport({
    mode: 'method-pair', status: ready ? 'ok' : 'unavailable',
    reason: ready ? null : error || baseline?.reason || alternative?.reason || (baseline?.metrics && alternative?.metrics && (!sameConditions || !sameVersions) ? '两次回放的方法版本、资金、成本或区间不一致，请重新运行。' : '补齐资金和行情后，才能比较原方法与改进方法。'),
    baseline, alternative, originalMethodId: original.id, improvedMethodId: improved.id,
    actualReference: improvedReport?.baseline || null,
    assumptions: alternative?.assumptions || null,
    interval: context.marketData?.provider === 'synthetic' ? '4H' : context.marketData?.interval || '',
    reviewInterval: context.marketData?.reviewInterval || context.marketData?.interval || '',
    delta: ready ? Object.fromEntries(metricKeys.map(key => [key, finite(baseline.metrics[key]) && finite(alternative.metrics[key]) ? Math.round((alternative.metrics[key] - baseline.metrics[key]) * 10000) / 10000 : null])) : null,
    warnings: [...new Set([...list(originalReport?.alternative?.warnings), ...list(improvedReport?.alternative?.warnings), '两版回放仅在资金、成本、行情、区间与执行规则一致时展示差额；差额仅描述这段历史，不能保证未来改善。'])],
  });
}

// Existing research API calls are calculations only. Both validated versions are
// returned together for one local persistence operation after all save checks pass.
export async function executeResearchWorkflow(input, request, requested = {}) {
  const result = await request(input);
  const candidates = uniqueMethods([...list(input.methods), ...list(input.research?.methods), ...list(result.research?.methods)]);
  const targetId = result.savedMethod?.id || result.research?.comparison?.alternative?.methodId || input.intent.methodId;
  const target = result.savedMethod || (input.intent.action === 'improve' ? list(result.research?.methods).at(-1) : null) || candidates.find(method => method.id === targetId);
  const improved = target?.origin === 'improved' && target.parentId ? target : null;
  const original = improved ? candidates.find(method => method.id === improved.parentId) : null;
  const savingImproved = input.intent.action === 'save_improved';
  if (savingImproved && (!improved || !original)) throw new Error('未找到改进方案对应的原方法，两版均未保存。请重新生成或补回原方法。');
  if (improved && ['improve', 'save_improved'].includes(input.intent.action)) verifyRequestedStopLoss(improved, requested);
  // A reused ID must mean the same immutable rule version in both the library
  // and the research snapshot used by the server for replay.
  for (const method of [original, improved].filter(Boolean)) if (list(input.methods).some(saved => saved.id === method.id)) saveMethodVersion(input.methods, method);

  let savedMethods = result.savedMethod ? [result.savedMethod] : [];
  if (savingImproved) {
    let originalSaved = list(input.methods).find(method => method.id === original.id);
    if (!originalSaved) {
      const originalResult = await request({ ...input, intent: { action: 'save_original', methodId: original.id }, research: result.research, methods: candidates });
      originalSaved = originalResult.savedMethod;
      if (originalSaved?.id !== original.id) throw new Error('原方法保存校验未完成，两版均未保存，请重试。');
    }
    savedMethods.unshift(originalSaved);
  }
  // Capacity and schema errors must happen before the caller writes either version.
  const persisted = saveMethodVersions(list(input.methods), savedMethods);
  savedMethods = savedMethods.map(method => persisted.find(saved => saved.id === method.id));

  let research = result.research;
  if (improved && ['improve', 'compare', 'save_improved'].includes(input.intent.action)) {
    if (!original) {
      research = { ...research, comparison: { mode: 'method-pair', status: 'unavailable', reason: '缺少对应的原方法，暂时无法进行两版回放对比。', baseline: null, alternative: research.comparison?.alternative || null, delta: null } };
    } else {
      let originalResult, error;
      if (research.comparison?.alternative?.status === 'ok') {
        try {
          originalResult = await request({ ...input, intent: { action: 'compare', methodId: original.id }, assumptions: research.assumptions, research, methods: candidates });
        } catch (cause) {
          if (cause?.name === 'AbortError') throw cause;
          error = `原方法回放未完成：${cause?.message || '请重试'}`;
        }
      }
      research = { ...research, methods: uniqueMethods([original, ...list(research.methods), improved]).slice(-8), comparison: pairReport(original, improved, originalResult?.research?.comparison, research.comparison, input.context, error) };
    }
  }
  if (savedMethods.length) research = { ...research, methods: list(research.methods).map(method => savedMethods.find(saved => saved.id === method.id) || method) };
  return { ...result, research, savedMethod: result.savedMethod ? savedMethods.find(method => method.id === result.savedMethod.id) : null, savedMethods };
}
