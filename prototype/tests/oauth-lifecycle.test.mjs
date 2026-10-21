import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalOAuth } from '../server/oauth-local.js';

const sample = { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh', expires: 1, clientId: 'synthetic-client', scopes: ['chatgpt.tokens.use.direct'] };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function memoryStore(initial) {
  const values = new Map(initial ? [['openai', structuredClone(initial)]] : []); let queue = Promise.resolve();
  const serialized = fn => { const next = queue.then(fn); queue = next.catch(() => {}); return next; };
  return {
    async read(id) { return structuredClone(values.get(id)); },
    async list() { return [...values].map(([providerId, item]) => ({ providerId, type: item.type })); },
    modify(id, fn) { return serialized(async () => { const value = await fn(structuredClone(values.get(id))); if (value !== undefined) values.set(id, structuredClone(value)); return structuredClone(values.get(id)); }); },
    delete(id) { return serialized(() => values.delete(id)); },
    async flush() { await queue; },
  };
}
async function setup(t, { initial, login, factory, reset } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'oauth-lifecycle-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = memoryStore(initial); let calls = 0;
  const options = { credentialStoreFactory: factory || (async () => store), credentialStoreReset: reset || (async () => memoryStore()), runtimeFactory: (_config, { credentials }) => ({ providerId: 'openai', models: { login: async (_provider, _auth, interaction) => { calls++; await login?.(credentials, interaction); } } }) };
  const oauth = await createLocalOAuth(directory, options);
  return { oauth, store, directory, options, calls: () => calls };
}

test('restored expired credentials keep all refresh metadata and start reuses them without login', async t => {
  const { oauth, calls } = await setup(t, { initial: sample });
  assert.equal(oauth.status().status, 'connected'); assert.equal((await oauth.start()).persisted, true);
  assert.equal(calls(), 0); assert.deepEqual(await oauth.credentials.read('openai'), sample);
  assert.ok(!JSON.stringify(oauth.status()).includes(sample.refresh));
});

test('login persists through the store before reporting connected and shutdown retains it', async t => {
  const saved = deferred();
  const { oauth, store, directory, options } = await setup(t, { login: async credentials => { await credentials.modify('openai', () => sample); saved.resolve(); } });
  await oauth.start(); await saved.promise; await new Promise(resolve => setImmediate(resolve));
  assert.equal(oauth.status().status, 'connected');
  await oauth.shutdown(); assert.deepEqual(await store.read('openai'), sample);
  const restored = await createLocalOAuth(directory, options); assert.equal(restored.status().status, 'connected');
});

test('cancel preserves an existing authorization', async t => {
  const { oauth, store } = await setup(t, { initial: sample });
  await oauth.cancel(); assert.equal(oauth.status().status, 'connected'); assert.deepEqual(await store.read('openai'), sample);
});

test('cancel and disconnect prevent a late login from resurrecting stored authorization', async t => {
  for (const action of ['cancel', 'disconnect']) {
    const delayed = deferred(), finished = deferred();
    const { oauth, store } = await setup(t, { login: async credentials => { await delayed.promise; try { await credentials.modify('openai', () => sample); } finally { finished.resolve(); } } });
    await oauth.start(); await oauth[action](); delayed.resolve(); await finished.promise; await new Promise(resolve => setImmediate(resolve));
    assert.equal(await store.read('openai'), undefined); assert.equal(oauth.status().status, 'idle');
  }
});

test('disconnect waits for started token rotation and removes its result last', async t => {
  const started = deferred(), finish = deferred(); const { oauth, store } = await setup(t, { initial: sample });
  const refresh = oauth.credentials.modify('openai', async value => { started.resolve(); await finish.promise; return { ...value, refresh: 'synthetic-rotated' }; });
  await started.promise; const disconnected = oauth.disconnect(); finish.resolve(); await Promise.all([refresh, disconnected]);
  assert.equal(await store.read('openai'), undefined); assert.equal(oauth.status().status, 'idle');
});

test('shutdown drains an in-progress rotation and rejects new writes without deleting saved tokens', async t => {
  const started = deferred(), finish = deferred(); const { oauth, store } = await setup(t, { initial: sample });
  const refresh = oauth.credentials.modify('openai', async value => { started.resolve(); await finish.promise; return { ...value, refresh: 'synthetic-rotated' }; });
  await started.promise; let closed = false; const shutdown = oauth.shutdown().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  assert.throws(() => oauth.credentials.modify('openai', () => sample), { name: 'AbortError' });
  finish.resolve(); await Promise.all([refresh, shutdown]); assert.equal((await store.read('openai')).refresh, 'synthetic-rotated');
});

test('damaged storage keeps the product available and only explicit disconnect resets it', async t => {
  let resets = 0;
  const { oauth } = await setup(t, { factory: async () => { throw new Error('synthetic private storage detail'); }, reset: async () => { resets++; return memoryStore(); } });
  assert.equal(oauth.status().status, 'error'); assert.doesNotMatch(JSON.stringify(oauth.status()), /synthetic private/);
  await assert.rejects(oauth.start()); await oauth.cancel(); assert.equal(resets, 0);
  await oauth.disconnect(); assert.equal(resets, 1); assert.equal(oauth.status().status, 'idle');
});

test('failed credential deletion cannot claim success or leak its error body', async t => {
  const { oauth, store } = await setup(t, { initial: sample }); store.delete = async () => { throw new Error(sample.refresh); };
  await assert.rejects(oauth.disconnect(), /本地授权存储/); assert.equal(oauth.status().status, 'error');
  assert.deepEqual(await store.read('openai'), sample); assert.ok(!JSON.stringify(oauth.status()).includes(sample.refresh));
});

test('malformed restored OAuth cannot be reported connected or overwritten silently', async t => {
  const { oauth, store } = await setup(t, { initial: { type: 'oauth', access: 'synthetic-access' } });
  assert.equal(oauth.status().status, 'error'); await assert.rejects(oauth.start());
  await assert.rejects(oauth.credentials.modify('openai', () => ({ type: 'oauth' })));
  assert.deepEqual(await store.read('openai'), { type: 'oauth', access: 'synthetic-access' });
  await oauth.disconnect(); assert.equal(oauth.status().status, 'idle');
});
