import { conversationContext, conversationScopeKey } from './agent-conversation-state.js';
import { executeResearchWorkflow } from './research-workflow.js';

const activeConversation = state => state.conversations.find(item => item.id === state.activeId);
const selectedDatasets = (state, options) => options.intent.action === 'batch'
  ? state.conversations.filter(item => item.marketData && (!options.datasetIds || options.datasetIds.includes(item.id))) : [];

function scopeKey(state, options) {
  const active = activeConversation(state);
  if (!active) return null;
  return JSON.stringify([
    conversationScopeKey(active, state.model), active.research || null, state.methods || [],
    selectedDatasets(state, options).map(item => conversationScopeKey(item, state.model)),
  ]);
}

function requestInput(state, options) {
  const active = activeConversation(state);
  if (!active) throw new Error('当前复盘已变化，请重新选择。');
  return structuredClone({
    intent: { ...options.intent, ...(options.datasetIds ? { datasetIds: options.datasetIds } : {}) },
    assumptions: options.assumptions,
    context: conversationContext(active), research: active.research, methods: state.methods || [],
    ...(options.intent.action === 'batch' ? { datasets: selectedDatasets(state, options).map(item => ({ id: item.id, context: conversationContext(item) })) } : {}),
  });
}

/** A cancelled calculation can finish at the transport, but can never save or render its result. */
export function createResearchRequestController({ readState, request, onBusyChange = () => {} }) {
  let pending = null;
  function cancel({ notify = true } = {}) {
    if (!pending) return;
    const previous = pending;
    pending = null;
    previous.controller.abort();
    if (notify) onBusyChange(false);
  }
  function refresh() {
    if (pending && scopeKey(readState(), pending.options) !== pending.scope) cancel();
  }
  async function run(options, commit) {
    const snapshot = readState();
    const input = requestInput(snapshot, options);
    cancel();
    const operation = { options: structuredClone(options), targetId: snapshot.activeId, scope: scopeKey(snapshot, options), controller: new AbortController() };
    pending = operation;
    onBusyChange(true);
    const current = () => {
      refresh();
      return pending === operation && !operation.controller.signal.aborted;
    };
    const guard = () => { if (!current()) throw Object.assign(new Error('本次研究已取消。'), { name: 'AbortError' }); };
    try {
      const result = await executeResearchWorkflow(input, async body => {
        guard();
        const response = await request(body, operation.controller.signal);
        guard();
        return response;
      });
      if (!current()) return null;
      // The caller commits both saved versions and the report synchronously,
      // only after the final material/method check has passed.
      commit(result, operation.targetId);
      return result;
    } catch (error) {
      if (!current()) return null;
      throw error;
    } finally {
      if (pending === operation) { pending = null; onBusyChange(false); }
    }
  }
  return { run, refresh, cancel };
}
