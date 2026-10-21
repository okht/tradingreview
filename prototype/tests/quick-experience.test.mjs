import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { experienceMode, experienceStorage } from '../src/experience-mode.js';
import { initializeQuickExperience } from '../src/quick-experience.js';
import { WORKSPACE_KEY, readWorkspace, validateWorkspace } from '../src/agent-workspace-state.js';
import { conversationContext } from '../src/agent-conversation-state.js';
import { learningDraftFromMessage, learningDraftFromSaved, persistLearningDraft } from '../src/learning-actions.js';
import { executeResearchWorkflow } from '../src/research-workflow.js';
import { executeResearch } from '../server/research-service.js';
import { runAgent } from '../src/services/api.js';

const seed = JSON.parse(await readFile(new URL('../public/demo/quick-workspace.json', import.meta.url), 'utf8'));
function memory() {
  const data = new Map();
  return { getItem: key => data.has(key) ? data.get(key) : null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}
const fetchSeed = async () => ({ ok: true, json: async () => structuredClone(seed) });

test('quick mode uses an exact route boundary and independent workspace storage', async () => {
  assert.equal(experienceMode('/quick'), 'quick');
  assert.equal(experienceMode('/quick/'), 'quick');
  assert.equal(experienceMode('/quickly'), 'full');
  const local = memory(), quick = experienceStorage(local, 'quick'), full = experienceStorage(local, 'full');
  await initializeQuickExperience(quick, { fetchSeed });
  assert.equal(readWorkspace(full).conversations[0].trades.length, 0);
  assert.equal(readWorkspace(quick).conversations[0].trades.length, 20);
  const updated = readWorkspace(quick);
  updated.conversations[0].title = '我的演示复盘';
  quick.setItem(WORKSPACE_KEY, JSON.stringify(updated));
  await initializeQuickExperience(quick, { fetchSeed: () => { throw new Error('must not reload existing data'); } });
  assert.equal(readWorkspace(quick).conversations[0].title, '我的演示复盘');
  assert.equal(readWorkspace(full).conversations[0].trades.length, 0);
});

test('a later seed response cannot replace edits made in another quick tab', async () => {
  const storage = memory();
  let release;
  const loading = initializeQuickExperience(storage, { fetchSeed: () => new Promise(resolve => { release = resolve; }) });
  storage.setItem(WORKSPACE_KEY, 'user-created-workspace');
  release({ ok: true, json: async () => seed });
  assert.equal(await loading, false);
  assert.equal(storage.getItem(WORKSPACE_KEY), 'user-created-workspace');
});

test('failed initialization leaves the workspace untouched and permits retry', async () => {
  const storage = memory();
  await assert.rejects(initializeQuickExperience(storage, { fetchSeed: async () => ({ ok: false }) }), /加载成功/);
  assert.equal(storage.getItem(WORKSPACE_KEY), null);
  assert.equal(await initializeQuickExperience(storage, { fetchSeed }), true);
});

test('public classic case has complete evidence-backed history, editable checklist and no live model', () => {
  const state = validateWorkspace(seed), c = state.conversations[0];
  assert.equal(state.model, null);
  assert.equal(c.messages.length, 4);
  assert.equal(c.marketData.provider, 'synthetic');
  assert.equal(c.marketData.reviewInterval, '15m');
  assert.equal(c.lastRequest, null);
  assert.equal(c.pendingTrades, null);
  assert.equal(state.methods.length, 2);
  assert(c.messages.at(-1).text.includes('82,179.41'));
  assert(c.messages.at(-1).evidence.length > 0);
  const item = state.savedItems[0];
  assert(c.messages.some(message => message.id === item.messageId && message.analysisRunId === item.analysisRunId));
  const quick = experienceStorage(memory(), 'quick');
  const draft = learningDraftFromSaved(state, item.id);
  const saved = persistLearningDraft(state, { ...draft, action: `${draft.action}\n体验者补充：记录核对时间。` }, quick);
  assert(readWorkspace(quick).savedItems[0].action.includes('体验者补充'));
  assert.equal(saved.conversations[0].messages.at(-1).text, c.messages.at(-1).text);
});

test('quick case replays both saved methods without connecting or calling a model', async () => {
  const state = validateWorkspace(seed), c = state.conversations[0];
  const improved = state.methods.find(method => method.origin === 'improved');
  const result = await executeResearchWorkflow({ intent: { action: 'compare', methodId: improved.id }, context: conversationContext(c), research: c.research, methods: state.methods, assumptions: c.research.assumptions }, async body => executeResearch(body));
  assert.equal(result.research.comparison.status, 'ok');
  assert.deepEqual(result.research.comparison.baseline.metrics, c.research.comparison.baseline.metrics);
  assert.deepEqual(result.research.comparison.alternative.metrics, c.research.comparison.alternative.metrics);
  await assert.rejects(runAgent({ task: 'review', model: state.model, context: conversationContext(c), text: '继续复盘' }), /连接模型/);
});

test('initial historical answers use their original material revision and permit saving a checklist', () => {
  const state = validateWorkspace(seed), c = state.conversations[0];
  assert.equal(c.contextRevision, 4);
  assert.deepEqual(Object.keys(c.contexts), ['EQ01-T01']);
  for (const message of c.messages.filter(value => value.role === 'assistant')) {
    assert.equal(message.contextRevision, c.contextRevision, 'Initial answer must not be marked as material-stale');
    const draft = learningDraftFromMessage(state, c.id, message.id);
    const storage = experienceStorage(memory(), 'quick');
    const saved = persistLearningDraft(state, { ...draft, exception: `${draft.exception}\n体验者补充的例外。` }, storage);
    assert(saved.savedItems.some(item => item.messageId === message.id && item.exception.includes('体验者补充')));
    assert.deepEqual(readWorkspace(storage), saved);
  }
});
