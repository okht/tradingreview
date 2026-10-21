import test from 'node:test';
import assert from 'node:assert/strict';
import { createJourney } from '../src/journey-state.js';
import { modelMetadata, modelTransitionPatch, safeModelBaseUrl } from '../src/model-connection.js';
import { clearSessionConfig, getSessionConfig, setSessionConfig } from '../src/services/api.js';
import { workspaceSnapshot } from '../src/useWorkspaceSync.js';

const model = { mode: 'live', provider: 'openai-compatible', model: 'model-a', auth: 'api', baseUrl: 'https://api.deepseek.com/v1' };
const analyzed = () => ({ ...createJourney(), model, reached: 5, step: 0, analyzed: true, question: '旧问题', questionKind: 'custom', liveReviewChat: { messages: ['旧回答'] }, learning: { title: '旧检查项', trigger: '旧情景', action: '旧动作', exception: '', analysisRunId: 'old-run', evidenceIds: ['old-evidence'] }, activeLearningId: 'saved-1', editingLearningId: 'saved-1', trades: [{ id: 'kept-trade' }], contexts: { 'kept-trade': { reason: '保留背景' } }, savedItems: [{ id: 'saved-1' }] });

test('changing mode, provider, model, authentication or endpoint invalidates current analysis only', () => {
  for (const next of [{ mode: 'demo' }, { ...model, provider: 'openai' }, { ...model, model: 'model-b' }, { ...model, auth: 'oauth' }, { ...model, baseUrl: 'https://openrouter.ai/api/v1' }]) {
    const state = analyzed(); const updated = { ...state, ...modelTransitionPatch(state, next) };
    assert.equal(updated.analyzed, false); assert.equal(updated.liveReviewChat, null); assert.equal(updated.question, ''); assert.equal(updated.activeLearningId, null); assert.equal(updated.editingLearningId, null);
    assert.equal(updated.step, 0); assert.equal(updated.reached, 3); assert.equal(updated.learning.analysisRunId, undefined);
    assert.equal(updated.trades, state.trades); assert.equal(updated.contexts, state.contexts); assert.equal(updated.savedItems, state.savedItems);
  }
});

test('reconnecting the same public identity preserves current analysis and edited learning', () => {
  const state = analyzed(); const updated = { ...state, ...modelTransitionPatch(state, { ...model, baseUrl: `${model.baseUrl}/`, apiKey: 'must-not-save' }) };
  assert.equal(updated.analyzed, true); assert.equal(updated.learning, state.learning); assert.equal(updated.liveReviewChat, state.liveReviewChat);
  assert.equal(JSON.stringify(updated.model).includes('must-not-save'), false);
});

test('public metadata only keeps an allowed HTTPS endpoint without embedded credentials', () => {
  for (const url of ['https://u:p@api.deepseek.com/v1', 'https://api.deepseek.com/v1?key=secret', 'https://api.deepseek.com/v1#secret', 'https://elsewhere.test/v1', 'http://api.deepseek.com/v1', 'https://api.deepseek.com:8443/v1']) assert.equal(safeModelBaseUrl(url), undefined);
  assert.equal(modelMetadata({ ...model, apiKey: 'private', config: { token: 'private' } }).apiKey, undefined);
  assert.equal(workspaceSnapshot({ model }).model.baseUrl, model.baseUrl);
});

test('page credentials cannot be reused for another endpoint with the same model id', () => {
  setSessionConfig({ ...model, apiKey: 'page-only-key' });
  try {
    assert.equal(getSessionConfig(model).apiKey, 'page-only-key');
    assert.throws(() => getSessionConfig({ ...model, baseUrl: 'https://openrouter.ai/api/v1' }), /重新填写/);
  } finally { clearSessionConfig(); }
});
