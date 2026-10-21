import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStore } from '../server/local-store.js';
import { createJourney } from '../src/journey-state.js';

const owner = 'local-test-owner';
const state = question => ({ ...createJourney(), question });
const run = () => ({ id: crypto.randomUUID(), result: { text: '测试分析，仅使用构造材料。' }, createdAt: '2025-09-20T10:00:00Z' });
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function directory(t) {
  const prefix = resolve(tmpdir(), 'huikan-store-test-');
  const path = await mkdtemp(prefix);
  t.after(async () => { if (!resolve(path).startsWith(prefix)) throw new Error('Unexpected test cleanup path'); await rm(path, { recursive: true, force: true }); });
  return path;
}

test('file commits survive restart and preserve per-owner workspaces and immutable analysis reads', async t => {
  const dir = await directory(t); const store = await new FileStore(dir).load();
  await store.put(owner, state('first'), 0); await store.put('other-owner', state('other'), 0);
  const savedRun = run(); await store.saveRun(owner, savedRun);
  const restarted = await new FileStore(dir).load();
  assert.equal((await restarted.get(owner)).revision, 1);
  assert.equal((await restarted.get(owner)).state.question, 'first');
  assert.equal((await restarted.get('other-owner')).state.question, 'other');
  assert.equal(await restarted.getRun('other-owner', savedRun.id), null);
  const detached = await restarted.getRun(owner, savedRun.id); detached.result.text = 'mutated';
  assert.equal((await restarted.getRun(owner, savedRun.id)).result.text, savedRun.result.text);
});

test('simultaneous writes against one revision have exactly one durable winner', async t => {
  const dir = await directory(t); const store = await new FileStore(dir).load();
  const results = await Promise.allSettled([store.put(owner, state('A'), 0), store.put(owner, state('B'), 0)]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.find(item => item.status === 'rejected').reason.status, 409);
  const loaded = await new FileStore(dir).load();
  assert.equal((await loaded.get(owner)).revision, 1);
  assert.equal((await loaded.get(owner)).state.question, 'A');
});

test('actual write failure rolls back memory, leaves disk untouched and permits a later successful commit', async t => {
  const dir = await directory(t); const store = await new FileStore(dir).load();
  await store.put(owner, state('committed'), 0);
  const original = await readFile(join(dir, 'workspace.json'), 'utf8');
  const obstructed = join(dir, 'workspace.json.tmp'); await mkdir(obstructed);
  await assert.rejects(store.put(owner, state('must roll back'), 1));
  const rejectedRun = run(); await assert.rejects(store.saveRun(owner, rejectedRun));
  assert.equal((await store.get(owner)).revision, 1);
  assert.equal((await store.get(owner)).state.question, 'committed');
  assert.equal(await store.getRun(owner, rejectedRun.id), null);
  assert.equal(await readFile(join(dir, 'workspace.json'), 'utf8'), original);
  // This is the single empty test directory created above, not a computed tree.
  await rm(obstructed, { recursive: true });
  await store.put(owner, state('retry succeeded'), 1);
  assert.equal((await (await new FileStore(dir).load()).get(owner)).revision, 2);
});

test('reads during a failed commit cannot observe an uncommitted revision or run', async t => {
  const dir = await directory(t); const store = await new FileStore(dir).load();
  await store.put(owner, state('committed'), 0);
  const originalPersist = store.persist.bind(store);
  const entered = defer(), release = defer();
  store.persist = async () => { entered.resolve(); await release.promise; throw new Error('disk error'); };
  const pending = store.put(owner, state('uncommitted'), 1);
  const rejection = assert.rejects(pending, /disk error/);
  await entered.promise;
  let readFinished = false; const reading = store.get(owner).then(value => { readFinished = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readFinished, false);
  release.resolve(); await rejection;
  assert.equal((await reading).revision, 1);
  assert.equal((await reading).state.question, 'committed');

  const enteredRun = defer(), releaseRun = defer();
  store.persist = async () => { enteredRun.resolve(); await releaseRun.promise; throw new Error('run disk error'); };
  const item = run(); const pendingRun = store.saveRun(owner, item); const runRejection = assert.rejects(pendingRun, /run disk error/);
  await enteredRun.promise; const readRun = store.getRun(owner, item.id);
  releaseRun.resolve(); await runRejection; assert.equal(await readRun, null);
  store.persist = originalPersist;
});

test('valid JSON with invalid collections cannot be silently accepted as an empty local database', async t => {
  const dir = await directory(t); const store = await new FileStore(dir).load();
  await store.put(owner, state('keep in memory'), 0);
  const invalid = [{}, [], { workspaces: [], runs: null }, { workspaces: null, runs: [] }, { workspaces: [[owner, { state: state('bad'), revision: -1 }]], runs: [] }, { workspaces: [[owner, { state: {}, revision: 1 }]], runs: [] }, { workspaces: [[owner, { state: state('a'), revision: 1 }], [owner, { state: state('b'), revision: 1 }]], runs: [] }, { workspaces: [], runs: [['owner:wrong', { id: 'other', result: {} }]] }];
  for (const value of invalid) {
    const content = JSON.stringify(value); await writeFile(join(dir, 'workspace.json'), content);
    await assert.rejects(store.load(), /保留文件/);
    assert.equal((await store.get(owner)).state.question, 'keep in memory');
    assert.equal(await readFile(join(dir, 'workspace.json'), 'utf8'), content);
  }
});

test('workspace credentials are absent from persisted file and restored state', async t => {
  const dir = await directory(t); const store = await new FileStore(dir).load();
  const secret = 'never-persist-fixture-secret';
  await store.put(owner, { ...state('safe record'), config: { apiKey: secret }, api_key: secret, token: secret, extra: { access_token: secret, refreshToken: secret, client_secret: secret, authorization: secret, password: secret } }, 0);
  assert.equal((await readFile(join(dir, 'workspace.json'), 'utf8')).includes(secret), false);
  assert.equal(JSON.stringify(await (await new FileStore(dir).load()).get(owner)).includes(secret), false);
});
