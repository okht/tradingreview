import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createWorkspace, validateWorkspace, WORKSPACE_KEY } from '../src/agent-workspace-state.js';
import { learningDraftFromMessage, learningDraftFromSaved, persistLearningDraft, saveLearningDraft } from '../src/learning-actions.js';

const stamp = '2026-10-22T08:00:00.000Z';
function fixture() {
  const state = createWorkspace(), conversation = state.conversations[0];
  conversation.trades = [{ id: 'T1', symbol: '600519.SH', name: '贵州茅台', time: '2025-03-03T10:00', side: 'buy', quantity: 100, price: 100, fee: 5 }];
  conversation.selectedIds = ['T1']; conversation.contextRevision = 2;
  const learning = { title: '核对依据', trigger: '下一次决策前', action: '记录来源和形成时间', exception: '资料不足时继续核实', analysisRunId: 'run-1', evidenceIds: ['trade-T1'] };
  conversation.messages = [
    { id: 'question-1', role: 'user', text: '请给出一条可执行的检查项。', refs: [], suggestions: [], contextRevision: 2 },
    { id: 'answer-1', role: 'assistant', text: '请先核对资料来源。', refs: [], suggestions: [], contextRevision: 2, analysisRunId: 'run-1', learning,
      evidence: [{ id: 'trade-T1', tradeId: 'T1', type: 'trade', timeClass: 'before', title: '成交 T1', text: '模拟买入 100 股。', source: '合成测试数据', publishedAt: '2025-03-03T10:00:00+08:00', recordedAt: null }] },
  ];
  return validateWorkspace(state);
}
const open = state => learningDraftFromMessage(state, state.conversations[0].id, 'answer-1');
const options = () => { let id = 0; return { now: () => stamp, createId: () => `saved-${++id}` }; };
const message = state => state.conversations[0].messages[1];

test('opening an AI candidate never saves it; explicit save preserves message, run, question and evidence links through roundtrip', () => {
  const state = fixture(), before = structuredClone(state), draft = open(state);
  assert.equal(state.savedItems.length, 0); assert.deepEqual(state, before);
  const saved = saveLearningDraft(state, draft, options()), item = saved.savedItems[0];
  assert.equal(item.messageId, 'answer-1'); assert.equal(item.analysisRunId, 'run-1'); assert.equal(item.conversationId, state.activeId);
  assert.equal(item.question, '请给出一条可执行的检查项。'); assert.deepEqual(item.evidenceIds, ['trade-T1']);
  assert.deepEqual(validateWorkspace(JSON.parse(JSON.stringify(saved))).savedItems[0], item);
  assert.equal(item._source, undefined); assert.equal(item._baseSaved, undefined); assert.deepEqual(state, before);
  assert.throws(() => saveLearningDraft(state, message(state).learning), /从已核对的复盘回答/);
});

test('reopening the same answer reuses saved ID and user edits instead of replacing them with the AI candidate', () => {
  const state = fixture(), draft = { ...open(state), title: '用户自定名称', action: '先核对原始记录，再列待确认事项', exception: '急需操作时只记录缺口' };
  const saved = saveLearningDraft(state, draft, options());
  const reopened = open(saved);
  assert.equal(reopened.id, saved.savedItems[0].id); assert.equal(reopened.title, draft.title); assert.equal(reopened.action, draft.action); assert.equal(reopened.exception, draft.exception);
  assert.equal(saveLearningDraft(saved, reopened, options()), saved);
  const updated = saveLearningDraft(saved, { ...reopened, trigger: '调整仓位之前' }, options());
  assert.equal(updated.savedItems.length, 1); assert.equal(updated.savedItems[0].id, reopened.id); assert.equal(updated.savedItems[0].trigger, '调整仓位之前');
});

test('repeated stale pre-save clicks are idempotent and cannot overwrite edits saved in the meantime', () => {
  const state = fixture(), draft = open(state), config = options();
  const saved = saveLearningDraft(state, draft, config);
  assert.equal(saveLearningDraft(saved, draft, config), saved);
  const edited = saveLearningDraft(saved, { ...learningDraftFromSaved(saved, saved.savedItems[0].id), action: '后来手动改过的检查动作' }, config);
  assert.throws(() => saveLearningDraft(edited, draft, config), /已经保存/);
  assert.equal(edited.savedItems[0].action, '后来手动改过的检查动作'); assert.equal(edited.savedItems.length, 1);
});

test('material revision or source changes after opening block submission without mutating the draft', () => {
  const state = fixture(), draft = open(state), before = structuredClone(draft);
  const revised = structuredClone(state); revised.conversations[0].contextRevision++;
  assert.throws(() => saveLearningDraft(revised, draft), /材料已更新/);
  const replaced = structuredClone(state); message(replaced).learning.action = '替换的候选';
  assert.throws(() => saveLearningDraft(replaced, draft), /来源已更新/);
  const removed = structuredClone(state); removed.conversations[0].messages = [];
  assert.throws(() => saveLearningDraft(removed, draft), /已不存在/);
  assert.deepEqual(draft, before); assert.equal(state.savedItems.length, 0);
});

test('missing or mismatched evidence and analysis sources cannot be promoted into saved reminders', () => {
  for (const mutate of [value => { message(value).learning.evidenceIds = []; }, value => { message(value).learning.evidenceIds = ['unknown']; }, value => { message(value).learning.analysisRunId = 'another-run'; }]) {
    const state = fixture(); mutate(state); assert.throws(() => open(state), /来源|证据|不一致/); assert.equal(state.savedItems.length, 0);
  }
  const state = fixture(), draft = { ...open(state), analysisRunId: 'forged-run', evidenceIds: ['forged-proof'], messageId: 'forged-message', conversationId: 'forged-conversation' };
  const saved = saveLearningDraft(state, draft, options()).savedItems[0];
  assert.equal(saved.analysisRunId, 'run-1'); assert.equal(saved.messageId, 'answer-1'); assert.equal(saved.conversationId, state.activeId); assert.deepEqual(saved.evidenceIds, ['trade-T1']);
  const otherSource = { ...state, savedItems: [{ ...saved, id: 'other-item', messageId: 'another-answer', analysisRunId: 'another-run' }] };
  assert.throws(() => saveLearningDraft(otherSource, { ...open(state), id: 'other-item' }), /来源与保存记录不一致/);
});

test('legacy saved items with a unique matching run retain their ID and edits and gain message attribution', () => {
  const state = fixture(); state.savedItems = [{ ...message(state).learning, id: 'legacy-1', conversationId: state.activeId, title: '旧检查项的人工名称', savedAt: stamp }];
  const draft = open(state); assert.equal(draft.id, 'legacy-1'); assert.equal(draft.title, '旧检查项的人工名称');
  const saved = saveLearningDraft(state, draft, options()); assert.equal(saved.savedItems.length, 1); assert.equal(saved.savedItems[0].messageId, 'answer-1');
  const duplicates = structuredClone(state); duplicates.savedItems.push({ ...duplicates.savedItems[0], id: 'legacy-2' });
  assert.throws(() => open(duplicates), /多个检查项/);
});

test('saved library items remain editable after material changes or source conversation removal without accepting changed provenance', () => {
  const state = fixture(), saved = saveLearningDraft(state, open(state), options());
  const original = saved.savedItems[0], draft = learningDraftFromSaved(saved, original.id);
  const changed = structuredClone(saved); changed.conversations[0].contextRevision++;
  const edited = saveLearningDraft(changed, { ...draft, action: '独立编辑已有检查项', analysisRunId: 'forged', evidenceIds: ['forged'] }, options());
  assert.equal(edited.savedItems[0].action, '独立编辑已有检查项'); assert.equal(edited.savedItems[0].analysisRunId, original.analysisRunId); assert.deepEqual(edited.savedItems[0].evidenceIds, original.evidenceIds);
  const removed = { ...createWorkspace(), savedItems: edited.savedItems };
  const afterRemoval = saveLearningDraft(removed, { ...learningDraftFromSaved(removed, original.id), exception: '原会话已移除，保留来源标识' }, options());
  assert.equal(afterRemoval.savedItems[0].conversationId, original.conversationId); assert.equal(afterRemoval.savedItems[0].exception, '原会话已移除，保留来源标识');
});

test('concurrent saved-item updates are rejected while unrelated latest workspace changes are preserved', () => {
  const state = fixture(), saved = saveLearningDraft(state, open(state), options());
  const first = learningDraftFromSaved(saved, saved.savedItems[0].id), second = structuredClone(first);
  const latest = structuredClone(saved); latest.conversations[0].draft = '保存窗口打开后输入的草稿';
  const edited = saveLearningDraft(latest, { ...first, action: '第一次编辑' }, options());
  assert.equal(edited.conversations[0].draft, '保存窗口打开后输入的草稿');
  assert.throws(() => saveLearningDraft(edited, { ...second, action: '迟到的编辑' }), /已被更新/);
  assert.equal(edited.savedItems[0].action, '第一次编辑');
});

test('failed durable writes leave workspace and editing draft intact, and a later retry saves exactly once', () => {
  const state = fixture(), draft = { ...open(state), action: '人工补充动作' }, beforeState = structuredClone(state), beforeDraft = structuredClone(draft);
  const config = options(); let writes = 0, stored;
  const storage = { setItem(key, value) { assert.equal(key, WORKSPACE_KEY); writes++; if (writes === 1) throw new Error('存储空间不足'); stored = value; } };
  assert.throws(() => persistLearningDraft(state, draft, storage, config), /存储空间不足/);
  assert.deepEqual(state, beforeState); assert.deepEqual(draft, beforeDraft); assert.equal(stored, undefined);
  const next = persistLearningDraft(state, draft, storage, config);
  assert.equal(next.savedItems.length, 1); assert.equal(JSON.parse(stored).savedItems[0].action, draft.action);
  assert.equal(persistLearningDraft(next, draft, storage, config), next); assert.equal(writes, 2);
});

test('invalid fields and removed saved targets fail before the durable write', () => {
  const state = fixture(), draft = open(state); let writes = 0;
  const storage = { setItem() { writes++; } };
  assert.throws(() => persistLearningDraft(state, { ...draft, title: '  ' }, storage), /title/);
  assert.throws(() => persistLearningDraft(state, { ...draft, action: 'x'.repeat(3001) }, storage), /action/);
  const saved = saveLearningDraft(state, draft, options()), editing = learningDraftFromSaved(saved, saved.savedItems[0].id);
  assert.throws(() => persistLearningDraft({ ...saved, savedItems: [] }, editing, storage), /已不存在/);
  assert.equal(writes, 0);
});

function saveHandler(state, editing, latest, storage) {
  const source = readFileSync(new URL('../src/AgentWorkspace.jsx', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('  function saveLearning() {'), source.indexOf('  function openLearning('));
  const updates = [], editingChanges = [], successes = [], errors = [];
  const scope = { state, editing, latestState: { current: latest }, storage, loadError: '', persistLearningDraft,
    setState: value => updates.push(value), setEditing: value => editingChanges.push(value), toast: { success: value => successes.push(value), error: value => errors.push(value) } };
  vm.createContext(scope); vm.runInContext(code, scope);
  return { scope, updates, editingChanges, successes, errors, save: () => scope.saveLearning() };
}

test('actual save handler uses latest state and handles two pre-render clicks with one durable item', () => {
  const state = fixture(), editing = open(state), latest = structuredClone(state); latest.conversations[0].draft = '最新输入';
  let writes = 0; const handler = saveHandler(state, editing, latest, { setItem() { writes++; } });
  handler.save(); handler.save();
  assert.equal(writes, 1); assert.equal(handler.scope.latestState.current.savedItems.length, 1);
  assert.equal(handler.scope.latestState.current.conversations[0].draft, '最新输入'); assert.equal(handler.errors.length, 0);
});

test('actual save handler leaves editor open and emits no success on write failure, then permits retry', () => {
  const state = fixture(), editing = { ...open(state), exception: '保留未保存的例外' }; let fail = true;
  const handler = saveHandler(state, editing, state, { setItem() { if (fail) throw new Error('存储空间不足'); } });
  handler.save(); assert.equal(handler.updates.length, 0); assert.equal(handler.editingChanges.length, 0); assert.equal(handler.successes.length, 0); assert.equal(handler.scope.latestState.current, state);
  assert.match(handler.errors[0], /存储空间不足/); assert.equal(editing.exception, '保留未保存的例外');
  fail = false; handler.save(); assert.equal(handler.updates.length, 1); assert.equal(handler.editingChanges[0], null); assert.equal(handler.successes.length, 1);
});
