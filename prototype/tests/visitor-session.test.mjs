import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVisitorSession, applyVisitorCookie, workspaceMode } from '../server/visitor-session.js';
import { createApi } from '../server/api.js';
import { MemoryStore } from '../server/storage.js';
import { createJourney } from '../src/journey-state.js';

const secret = 'test-only-visitor-signing-secret-32-characters';
const now = Date.parse('2026-10-22T00:00:00Z');
const options = { secret, now };
const request = (path = '/', headers = {}, init = {}) => new Request(`https://tradingreview.test${path}`, { ...init, headers });
const cookieHeader = session => session.cookie.split(';')[0];

test('document response bootstraps a persistent private visitor before concurrent API requests', async () => {
  const initial = await resolveVisitorSession(request('/quick', { accept: 'text/html' }), options);
  assert.match(initial.owner, /^visitor:[a-f0-9-]+:quick$/);
  assert.match(initial.cookie, /^__Host-tradingreview-visitor=/);
  for (const attribute of ['Path=/', 'Max-Age=15552000', 'HttpOnly', 'Secure', 'SameSite=Lax']) assert.ok(initial.cookie.includes(attribute));
  const response = applyVisitorCookie(new Response('rendered page', { headers: { 'cache-control': 'public, max-age=60' } }), initial);
  assert.equal(response.headers.get('set-cookie'), initial.cookie);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(await response.text(), 'rendered page');
  const cookie = cookieHeader(initial);
  const sessions = await Promise.all(Array.from({ length: 8 }, () => resolveVisitorSession(request('/api/workspace', { cookie, referer: 'https://tradingreview.test/quick' }), options)));
  assert.ok(sessions.every(session => session.owner === initial.owner && session.cookie === null));
  assert.equal((await resolveVisitorSession(request('/quick', { cookie }), options)).cookie, null);
});

test('missing API cookies never mint competing identities, while assets need no session', async () => {
  await assert.rejects(resolveVisitorSession(request('/api/workspace'), options), { status: 409 });
  await assert.rejects(resolveVisitorSession(request('/api/status'), options), { status: 409 });
  assert.deepEqual(await resolveVisitorSession(request('/assets/app.js'), {}), { owner: null, cookie: null });
  assert.deepEqual(await resolveVisitorSession(request('/favicon.ico'), options), { owner: null, cookie: null });
});

test('forged, expired, ambiguous and different-host cookies cannot access a visitor workspace', async () => {
  const initial = await resolveVisitorSession(request(), options);
  const cookie = cookieHeader(initial);
  const token = cookie.split('=')[1];
  const parts = token.split('.');
  const changedId = [...parts]; changedId[1] = crypto.randomUUID();
  const changedExpiry = [...parts]; changedExpiry[2] = String(Number(parts[2]) - 10);
  const changedSignature = [...parts]; changedSignature[3] = (parts[3][0] === 'a' ? 'b' : 'a') + parts[3].slice(1);
  for (const forged of [changedId.join('.'), changedExpiry.join('.'), changedSignature.join('.'), 'invalid']) {
    await assert.rejects(resolveVisitorSession(request('/api/workspace', { cookie: `__Host-tradingreview-visitor=${forged}` }), options), { status: 409 });
  }
  await assert.rejects(resolveVisitorSession(request('/api/workspace', { cookie: `${cookie}; ${cookie}` }), options), { status: 409 });
  await assert.rejects(resolveVisitorSession(new Request('https://other.test/api/workspace', { headers: { cookie } }), options), { status: 409 });
  await assert.rejects(resolveVisitorSession(request('/api/workspace', { cookie }), { ...options, secret: `${secret}-rotated` }), { status: 409 });
  await assert.rejects(resolveVisitorSession(request('/api/workspace', { cookie }), { ...options, now: now + 180 * 86400000 }), { status: 409 });
  const renewed = await resolveVisitorSession(request('/', { cookie }), { ...options, now: now + 180 * 86400000 });
  assert.notEqual(renewed.owner, initial.owner);
  assert.ok(renewed.cookie);
});

test('mode selection accepts only the current visitor partition and same-origin quick referrers', () => {
  assert.equal(workspaceMode(request('/quick')), 'quick');
  assert.equal(workspaceMode(request('/api/workspace', { referer: 'https://tradingreview.test/quick/?step=3' })), 'quick');
  assert.equal(workspaceMode(request('/api/workspace', { referer: 'https://other.test/quick' })), 'full');
  assert.equal(workspaceMode(request('/api/workspace', { referer: 'invalid' })), 'full');
  assert.equal(workspaceMode(request('/api/workspace', { 'x-tradingreview-mode': 'quick' })), 'quick');
  assert.equal(workspaceMode(request('/api/workspace', { 'x-tradingreview-mode': 'full', referer: 'https://tradingreview.test/quick' })), 'full');
  assert.equal(workspaceMode(request('/api/workspace', { 'x-tradingreview-mode': 'visitor:someone-else' })), 'full');
});

test('trusted signed-in identity is retained and an untrusted identity header is ignored by the resolver', async () => {
  assert.deepEqual(await resolveVisitorSession(request('/api/workspace'), { authenticatedUserId: 'signed-in-user' }), { owner: 'signed-in-user', cookie: null });
  assert.deepEqual(await resolveVisitorSession(request('/api/workspace', { 'x-tradingreview-mode': 'quick' }), { authenticatedUserId: 'signed-in-user' }), { owner: 'signed-in-user:quick', cookie: null });
  await assert.rejects(resolveVisitorSession(request('/api/workspace', { 'oai-authenticated-user-id': 'forged' }), options), { status: 409 });
});

test('cross-site API calls are rejected before session creation or authenticated access', async () => {
  for (const headers of [{ origin: 'https://other.test' }, { 'sec-fetch-site': 'cross-site' }]) {
    await assert.rejects(resolveVisitorSession(request('/api/workspace', headers), options), { status: 403 });
    await assert.rejects(resolveVisitorSession(request('/api/workspace', headers), { authenticatedUserId: 'signed-in-user' }), { status: 403 });
  }
  const initial = await resolveVisitorSession(request(), options);
  assert.equal((await resolveVisitorSession(request('/api/workspace', { cookie: cookieHeader(initial), origin: 'https://tradingreview.test' }), options)).owner, initial.owner);
});

test('missing deployment secret fails closed without a shared demo identity', async () => {
  for (const value of [undefined, '', 'short']) await assert.rejects(resolveVisitorSession(request(), { secret: value }), { status: 503 });
});

test('independent visitors and quick/full workspaces retain separate saved data and analysis runs', async () => {
  const store = new MemoryStore();
  const api = createApi({ store });
  const alice = await resolveVisitorSession(request(), options);
  const bob = await resolveVisitorSession(request(), options);
  assert.notEqual(alice.owner, bob.owner);
  const call = async (session, mode, init = {}, path = '/api/workspace') => {
    const req = request(path, { cookie: cookieHeader(session), 'x-tradingreview-mode': mode, ...(init.body ? { 'content-type': 'application/json' } : {}) }, init);
    const resolved = await resolveVisitorSession(req, options);
    return api(req, resolved.owner);
  };
  const write = async (session, mode, text) => call(session, mode, { method: 'PUT', body: JSON.stringify({ revision: 0, state: { ...createJourney(), question: text } }) });
  assert.equal((await write(alice, 'quick', 'Alice quick')).status, 200);
  assert.equal((await write(alice, 'full', 'Alice full')).status, 200);
  assert.equal((await write(bob, 'quick', 'Bob quick')).status, 200);
  assert.equal((await (await call(alice, 'quick')).json()).state.question, 'Alice quick');
  assert.equal((await (await call(alice, 'full')).json()).state.question, 'Alice full');
  assert.equal((await (await call(bob, 'quick')).json()).state.question, 'Bob quick');
  assert.deepEqual(await (await call(bob, 'full')).json(), { state: null, revision: 0 });
  const run = { id: crypto.randomUUID(), result: { text: 'private analysis' } };
  await store.saveRun(`${alice.owner}:quick`, run);
  assert.equal((await call(alice, 'quick', {}, `/api/runs/${run.id}`)).status, 200);
  assert.equal((await call(alice, 'full', {}, `/api/runs/${run.id}`)).status, 404);
  assert.equal((await call(bob, 'quick', {}, `/api/runs/${run.id}`)).status, 404);
});
