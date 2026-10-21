import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createLocalCredentialStore, createWindowsDpapiProtector, resetLocalCredentialStore, LOCAL_CREDENTIAL_FILE } from '../server/local-credential-store.js';

// These are explicitly public fixture strings; no account is accessed.
const fixture = n => ({ type: 'oauth', access: `public-fixture-access-${n}`, refresh: `public-fixture-refresh-${n}`, expires: 1000 + n, clientId: 'public-fixture-client', scopes: ['openid', 'chatgpt.tokens.use.direct'], accountId: 'public-fixture-account', providerMetadata: { revision: n } });
const tick = () => new Promise(resolveTick => setImmediate(resolveTick));
const deferred = () => { let resolveValue; const promise = new Promise(resolveNow => { resolveValue = resolveNow; }); return { promise, resolve: resolveValue }; };
async function directory(t) {
  const path = await fs.mkdtemp(join(tmpdir(), 'huikan-credential-store-test-'));
  t.after(async () => {
    // Never recursively remove a computed target outside the test temp root.
    assert.equal(dirname(resolve(path)), resolve(tmpdir()));
    assert.ok(basename(path).startsWith('huikan-credential-store-test-'));
    await fs.rm(path, { recursive: true, force: true });
  });
  return path;
}
function mockProtector() {
  const key = randomBytes(32);
  return {
    protects: 0, unprotects: 0, failProtect: false, failUnprotect: false,
    async protect(clear) {
      this.protects++;
      if (this.failProtect) throw new Error(fixture(99).access);
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
      const body = Buffer.concat([cipher.update(clear), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), body]);
    },
    async unprotect(encrypted) {
      this.unprotects++;
      if (this.failUnprotect) throw new Error(fixture(99).refresh);
      const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12));
      decipher.setAuthTag(encrypted.subarray(12, 28));
      return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]);
    },
  };
}

test('encrypted store preserves complete OAuth fields, metadata-only listing and detached reads across reconstruction', async t => {
  const path = await directory(t), protector = mockProtector();
  const store = await createLocalCredentialStore(path, { protector });
  assert.equal(await store.read('openai'), undefined); assert.deepEqual(await store.list(), []);
  const supplied = fixture(1); await store.modify('openai', async () => supplied);
  supplied.scopes.push('must-not-leak');
  const saved = await store.read('openai'); assert.deepEqual(saved, fixture(1)); saved.providerMetadata.revision = 999;
  assert.deepEqual(await store.read('openai'), fixture(1));
  assert.deepEqual(await store.list(), [{ providerId: 'openai', type: 'oauth' }]);
  const raw = await fs.readFile(join(path, LOCAL_CREDENTIAL_FILE), 'utf8');
  assert.doesNotMatch(raw, /public-fixture|clientId|access|refresh|chatgpt\.tokens/);
  const rebuilt = await createLocalCredentialStore(path, { protector });
  assert.deepEqual(await rebuilt.read('openai'), fixture(1)); assert.equal(protector.unprotects, 1);
  await rebuilt.modify('openai', async current => ({ ...current, ...fixture(2) }));
  assert.deepEqual(await store.read('openai'), fixture(2));
});

test('same-directory instances serialize refresh, other providers and logout, while flush waits for durable completion', async t => {
  const path = await directory(t), protector = mockProtector();
  const first = await createLocalCredentialStore(path, { protector });
  await first.modify('openai', async () => fixture(1));
  const second = await createLocalCredentialStore(path, { protector }), gate = deferred(), started = deferred();
  const order = [];
  const refresh = first.modify('openai', async current => { order.push(current.expires); started.resolve(); await gate.promise; return fixture(2); });
  await started.promise;
  const other = second.modify('other', async () => { order.push('other'); return { type: 'api_key', key: 'public-fixture-api-key' }; });
  const logout = second.delete('openai');
  let flushed = false; const flushing = first.flush().then(() => { flushed = true; });
  await tick(); assert.equal(flushed, false); assert.deepEqual(await first.read('openai'), fixture(1));
  gate.resolve(); await Promise.all([refresh, other, logout, flushing]);
  assert.deepEqual(order, [1001, 'other']); assert.equal(await first.read('openai'), undefined);
  assert.deepEqual(await first.list(), [{ providerId: 'other', type: 'api_key' }]);
  assert.equal(await (await createLocalCredentialStore(path, { protector })).read('openai'), undefined);
});

test('abort before the queued callback prevents refresh; abort after it starts still saves the rotated token', async t => {
  const path = await directory(t), protector = mockProtector(), store = await createLocalCredentialStore(path, { protector });
  await store.modify('openai', async () => fixture(1));
  const gate = deferred(), started = deferred(), activeAbort = new AbortController();
  const active = store.modify('openai', async () => { started.resolve(); await gate.promise; return fixture(2); }, { signal: activeAbort.signal });
  await started.promise; activeAbort.abort();
  const waitingAbort = new AbortController(); let called = false;
  const cancelled = store.modify('openai', async () => { called = true; return fixture(3); }, { signal: waitingAbort.signal });
  const rejected = assert.rejects(cancelled, { name: 'AbortError' }); waitingAbort.abort();
  gate.resolve(); await active; await rejected;
  assert.equal(called, false); assert.deepEqual(await store.read('openai'), fixture(2));
  await assert.rejects(store.read('openai', { signal: waitingAbort.signal }), { name: 'AbortError' });
  await assert.rejects(store.list({ signal: waitingAbort.signal }), { name: 'AbortError' });
});

test('no-op and callback failure leave storage untouched, and failed operations do not poison the queue', async t => {
  const path = await directory(t), protector = mockProtector(), store = await createLocalCredentialStore(path, { protector });
  await store.modify('openai', async () => fixture(1)); const before = await fs.readFile(join(path, LOCAL_CREDENTIAL_FILE));
  const count = protector.protects;
  assert.deepEqual(await store.modify('openai', async value => { value.access = 'local-edit-not-returned'; }), fixture(1));
  await assert.rejects(store.modify('openai', async () => { throw new Error('public callback failure'); }), /public callback failure/);
  assert.equal(protector.protects, count); assert.deepEqual(await fs.readFile(join(path, LOCAL_CREDENTIAL_FILE)), before);
  await store.modify('openai', async () => fixture(2)); assert.deepEqual(await store.read('openai'), fixture(2));
});

test('encryption or rename failure leaves both the previous memory and file intact, removes temporary files and hides protector errors', async t => {
  const path = await directory(t), protector = mockProtector(); let failRename = false;
  const fileSystem = { ...fs, rename: async (...args) => { if (failRename) throw new Error(fixture(99).access); return fs.rename(...args); } };
  const store = await createLocalCredentialStore(path, { protector, fileSystem }); await store.modify('openai', async () => fixture(1));
  const file = join(path, LOCAL_CREDENTIAL_FILE), before = await fs.readFile(file);
  for (const phase of ['protect', 'rename']) {
    protector.failProtect = phase === 'protect'; failRename = phase === 'rename';
    await assert.rejects(store.modify('openai', async () => fixture(2)), error => { assert.equal(error.code, 'CREDENTIAL_SAVE_FAILED'); assert.doesNotMatch(error.message, /public-fixture/); return true; });
    assert.deepEqual(await store.read('openai'), fixture(1)); assert.deepEqual(await fs.readFile(file), before);
    assert.deepEqual(await fs.readdir(path), [LOCAL_CREDENTIAL_FILE]);
  }
  protector.failProtect = false; failRename = false;
  await store.modify('openai', async () => fixture(3)); assert.deepEqual(await store.read('openai'), fixture(3));
});

test('fsync failure never publishes an in-memory credential or replaces the previous ciphertext', async t => {
  const path = await directory(t), protector = mockProtector(); let failSync = false;
  const fileSystem = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    return { writeFile: (...values) => handle.writeFile(...values), close: () => handle.close(), sync: async () => { if (failSync) throw new Error('public-fsync-fixture'); await handle.sync(); } };
  } };
  const store = await createLocalCredentialStore(path, { protector, fileSystem }); await store.modify('openai', async () => fixture(1));
  const before = await fs.readFile(join(path, LOCAL_CREDENTIAL_FILE)); failSync = true;
  await assert.rejects(store.modify('openai', async () => fixture(2)), { code: 'CREDENTIAL_SAVE_FAILED' });
  assert.deepEqual(await store.read('openai'), fixture(1)); assert.deepEqual(await fs.readFile(join(path, LOCAL_CREDENTIAL_FILE)), before);
  assert.deepEqual(await fs.readdir(path), [LOCAL_CREDENTIAL_FILE]);
});

test('logout failure retains the old authorization and subsequent logout durably removes it', async t => {
  const path = await directory(t), protector = mockProtector(), store = await createLocalCredentialStore(path, { protector });
  await store.modify('openai', async () => fixture(1)); protector.failProtect = true;
  await assert.rejects(store.delete('openai'), { code: 'CREDENTIAL_SAVE_FAILED' }); assert.deepEqual(await store.read('openai'), fixture(1));
  protector.failProtect = false; await store.delete('openai');
  assert.equal(await (await createLocalCredentialStore(path, { protector })).read('openai'), undefined);
});

test('malformed or undecryptable files never silently reset; explicit reset removes only the credential file', async t => {
  const path = await directory(t), protector = mockProtector(), store = await createLocalCredentialStore(path, { protector });
  await store.modify('openai', async () => fixture(1)); const file = join(path, LOCAL_CREDENTIAL_FILE);
  const valid = await fs.readFile(file); await fs.writeFile(join(path, 'workspace-preserve.txt'), 'public workspace fixture');
  for (const invalid of ['not-json', JSON.stringify({ version: 1, protection: 'plaintext', credentials: [fixture(99)] }), JSON.stringify({ version: 1, protection: 'windows-dpapi-current-user', ciphertext: 'AAAA' })]) {
    await fs.writeFile(file, invalid);
    await assert.rejects(createLocalCredentialStore(path, { protector }), error => { assert.equal(error.code, 'CREDENTIAL_LOAD_FAILED'); assert.doesNotMatch(error.message, /public-fixture/); return true; });
    assert.equal(await fs.readFile(file, 'utf8'), invalid); assert.deepEqual(await store.read('openai'), fixture(1));
  }
  await fs.writeFile(file, valid); protector.failUnprotect = true;
  await assert.rejects(createLocalCredentialStore(path, { protector }), { code: 'CREDENTIAL_LOAD_FAILED' });
  assert.deepEqual(await fs.readFile(file), valid);
  const cleared = await resetLocalCredentialStore(path, { protector });
  assert.deepEqual(await cleared.list(), []); assert.equal(await store.read('openai'), undefined);
  assert.deepEqual(await fs.readdir(path), ['workspace-preserve.txt']);
  protector.failUnprotect = false; await cleared.modify('openai', async () => fixture(2));
  assert.deepEqual(await (await createLocalCredentialStore(path, { protector })).read('openai'), fixture(2));
});

test('reset deletion failure cannot claim a cleared authorization and reset waits for a pending refresh', async t => {
  const path = await directory(t), protector = mockProtector(), store = await createLocalCredentialStore(path, { protector });
  await store.modify('openai', async () => fixture(1)); const before = await fs.readFile(join(path, LOCAL_CREDENTIAL_FILE));
  await assert.rejects(resetLocalCredentialStore(path, { protector, fileSystem: { ...fs, unlink: async () => { throw new Error('public-delete-fixture'); } } }), { code: 'CREDENTIAL_DELETE_FAILED' });
  assert.deepEqual(await store.read('openai'), fixture(1)); assert.deepEqual(await fs.readFile(join(path, LOCAL_CREDENTIAL_FILE)), before);
  const gate = deferred(), started = deferred();
  const refreshing = store.modify('openai', async () => { started.resolve(); await gate.promise; return fixture(2); }); await started.promise;
  const clearing = resetLocalCredentialStore(path, { protector }); gate.resolve(); await refreshing; const cleared = await clearing;
  assert.deepEqual(await cleared.list(), []); await assert.rejects(fs.stat(join(path, LOCAL_CREDENTIAL_FILE)), { code: 'ENOENT' });
});

test('stores use separate data directories and invalid credentials cannot overwrite a valid record', async t => {
  const left = await directory(t), right = await directory(t), protector = mockProtector();
  const a = await createLocalCredentialStore(left, { protector }), b = await createLocalCredentialStore(right, { protector });
  await a.modify('openai', async () => fixture(1)); assert.equal(await b.read('openai'), undefined);
  for (const value of [{ type: 'invalid', access: fixture(99).access }, { ...fixture(1), expires: Infinity }, { ...fixture(1), helper() {} }]) await assert.rejects(a.modify('openai', async () => value), { code: 'INVALID_CREDENTIAL' });
  assert.deepEqual(await a.read('openai'), fixture(1));
});

test('incomplete OAuth or missing ChatGPT refresh metadata is rejected on both read and write while expired tokens remain recoverable', async t => {
  const path = await directory(t), protector = mockProtector(), store = await createLocalCredentialStore(path, { protector });
  const expired = fixture(1); assert.ok(expired.expires < Date.now()); await store.modify('openai', async () => expired);
  const invalid = [{ type: 'oauth' }, { ...expired, access: '' }, { ...expired, refresh: ' ' }, { ...expired, expires: -1 }, { ...expired, expires: Infinity }, { ...expired, clientId: '' }, { ...expired, scopes: ['openid'] }, { ...expired, scopes: ['chatgpt.tokens.use.direct', 1] }];
  for (const value of invalid) {
    await assert.rejects(store.modify('openai', async () => value), { code: 'INVALID_CREDENTIAL' });
    assert.deepEqual(await store.read('openai'), expired);
    const encrypted = await protector.protect(Buffer.from(JSON.stringify({ version: 1, credentials: [['openai', value]] })));
    const raw = JSON.stringify({ version: 1, protection: 'windows-dpapi-current-user', ciphertext: encrypted.toString('base64') });
    await fs.writeFile(join(path, LOCAL_CREDENTIAL_FILE), raw);
    await assert.rejects(createLocalCredentialStore(path, { protector }), { code: 'CREDENTIAL_LOAD_FAILED' });
    assert.equal(await fs.readFile(join(path, LOCAL_CREDENTIAL_FILE), 'utf8'), raw); assert.deepEqual(await store.read('openai'), expired);
  }
});

test('unavailable platform or PowerShell 5 has no plaintext fallback', async t => {
  const path = await directory(t);
  await assert.rejects(createLocalCredentialStore(path, { platform: 'linux' }), { code: 'DPAPI_UNAVAILABLE' });
  await assert.rejects(createWindowsDpapiProtector({ platform: 'win32', pwshPath: 'powershell.exe' }), { code: 'PWSH_UNAVAILABLE' });
  await assert.rejects(createWindowsDpapiProtector({ platform: 'win32', pwshPath: join(path, 'missing', 'pwsh.exe') }), { code: 'DPAPI_UNAVAILABLE' });
  assert.deepEqual(await fs.readdir(path), []);
});

test('explicit reset can erase an unreadable file without DPAPI, but later writes still fail closed', async t => {
  const path = await directory(t);
  await fs.writeFile(join(path, LOCAL_CREDENTIAL_FILE), 'public-corrupt-fixture');
  const cleared = await resetLocalCredentialStore(path, { platform: 'linux' });
  assert.deepEqual(await cleared.list(), []); assert.deepEqual(await fs.readdir(path), []);
  await assert.rejects(cleared.modify('openai', async () => fixture(1)), { code: 'CREDENTIAL_SAVE_FAILED' });
  assert.deepEqual(await cleared.list(), []); assert.deepEqual(await fs.readdir(path), []);
});

test('Windows CurrentUser DPAPI round-trips a public fixture, survives a fresh process and detects corruption', { skip: process.platform !== 'win32' }, async t => {
  const path = await directory(t), launches = [];
  const protector = await createWindowsDpapiProtector({ spawnProcess: (file, args, options) => { launches.push({ file, args, options }); return spawn(file, args, options); } });
  const store = await createLocalCredentialStore(path, { protector }); await store.modify('openai', async () => fixture(1));
  const raw = await fs.readFile(join(path, LOCAL_CREDENTIAL_FILE), 'utf8'); assert.doesNotMatch(raw, /public-fixture/);
  assert.ok(launches.every(call => call.options.windowsHide && basename(call.file).toLowerCase() === 'pwsh.exe'));
  assert.doesNotMatch(JSON.stringify(launches), /public-fixture-access|public-fixture-refresh|public-fixture-client/);
  const program = `import {createLocalCredentialStore} from './server/local-credential-store.js';let input='';for await(const chunk of process.stdin)input+=chunk;const store=await createLocalCredentialStore(JSON.parse(input).directory);const entry=await store.read('openai');process.stdout.write(JSON.stringify({restored:entry?.expires===1001&&entry?.clientId==='public-fixture-client'&&entry?.scopes?.includes('chatgpt.tokens.use.direct')}));`;
  const restored = await new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', program], { cwd: new URL('..', import.meta.url), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.resume(); child.on('error', reject);
    child.on('close', code => code === 0 ? resolveChild(JSON.parse(output)) : reject(new Error('public fixture process failed')));
    child.stdin.end(JSON.stringify({ directory: path }));
  });
  assert.deepEqual(restored, { restored: true });
  const envelope = JSON.parse(raw), bytes = Buffer.from(envelope.ciphertext, 'base64'); bytes[bytes.length - 1] ^= 255; envelope.ciphertext = bytes.toString('base64');
  await fs.writeFile(join(path, LOCAL_CREDENTIAL_FILE), JSON.stringify(envelope));
  await assert.rejects(createLocalCredentialStore(path, { protector }), { code: 'CREDENTIAL_LOAD_FAILED' });
  assert.deepEqual(await store.read('openai'), fixture(1));
  await resetLocalCredentialStore(path, { protector });
  assert.equal(await (await createLocalCredentialStore(path, { protector })).read('openai'), undefined);
});
