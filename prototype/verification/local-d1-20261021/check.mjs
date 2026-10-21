import assert from 'node:assert/strict';
import { createJourney } from '../../src/journey-state.js';

const base = 'http://127.0.0.1:8790';
const alice = 'huikan-local-d1-alice';
const bob = 'huikan-local-d1-bob';
const phase = process.argv[2] || 'seed';
const runId = '87900000-0000-4000-8000-000000000001';
const observations = [];
async function request(path, owner, method = 'GET', body, extraHeaders = {}) {
  const response = await fetch(base + path, { method, headers: { ...(owner ? { 'oai-authenticated-user-id': owner } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
function checked(name, result, expected) {
  assert.equal(result.status, expected, `${name}: ${JSON.stringify(result.body)}`);
  observations.push({ check: name, status: result.status });
  return result.body;
}

checked('anonymous API requires authentication', await request('/api/status'), 401);
const status = checked('explicit local gateway test header reaches Worker', await request('/api/status', alice), 200);
assert.equal(status.storage, 'cloud');
checked('cross-origin requests rejected', await request('/api/workspace', alice, 'GET', undefined, { Origin: 'https://unrelated.invalid' }), 403);

if (phase === 'seed') {
  assert.deepEqual(checked('new Alice workspace', await request('/api/workspace', alice), 200), { state: null, revision: 0 });
  assert.deepEqual(checked('new Bob workspace', await request('/api/workspace', bob), 200), { state: null, revision: 0 });
  const draft = { ...createJourney(), question: 'D1 durable test seed', api_key: 'synthetic-no-real-secret', extra: { access_token: 'synthetic-no-real-secret', refresh_token: 'synthetic-no-real-secret' } };
  assert.equal(checked('initial Alice commit', await request('/api/workspace', alice, 'PUT', { revision: 0, state: draft }), 200).revision, 1);
  const race = await Promise.all(['race A', 'race B'].map(question => request('/api/workspace', alice, 'PUT', { revision: 1, state: { ...draft, question } })));
  assert.deepEqual(race.map(result => result.status).sort(), [200, 409]);
  observations.push({ check: 'simultaneous same-revision writes', statuses: race.map(result => result.status) });
  const committed = checked('read committed winner', await request('/api/workspace', alice), 200);
  assert.equal(committed.revision, 2); assert.ok(['race A', 'race B'].includes(committed.state.question));
  assert.equal(JSON.stringify(committed).includes('synthetic-no-real-secret'), false);
  checked('stale revision rejected', await request('/api/workspace', alice, 'PUT', { revision: 1, state: draft }), 409);
  checked('invalid state rejected without replacement', await request('/api/workspace', alice, 'PUT', { revision: 2, state: { ...draft, selectedIds: ['nonexistent'] } }), 400);
  assert.deepEqual((await request('/api/workspace', alice)).body, committed);
  assert.deepEqual((await request('/api/workspace', bob)).body, { state: null, revision: 0 });
  assert.equal(checked('Bob writes an independent workspace', await request('/api/workspace', bob, 'PUT', { revision: 0, state: { ...createJourney(), question: 'Bob independent record' } }), 200).revision, 1);
} else if (phase === 'restart') {
  const restored = checked('Alice persists across Worker restart', await request('/api/workspace', alice), 200);
  assert.equal(restored.revision, 2); assert.ok(['race A', 'race B'].includes(restored.state.question));
  const other = checked('Bob persists separately across restart', await request('/api/workspace', bob), 200);
  assert.equal(other.revision, 1); assert.equal(other.state.question, 'Bob independent record');
  const snapshot = checked('owner can read local SQL fixture run', await request(`/api/runs/${runId}`, alice), 200);
  assert.equal(snapshot.id, runId); assert.equal(snapshot.result.text, 'LOCAL SQL FIXTURE ONLY');
  checked('other owner cannot read the run', await request(`/api/runs/${runId}`, bob), 404);
} else throw new Error('Unknown phase');

console.log(JSON.stringify({ phase, passed: true, observedAt: new Date().toISOString(), observations }, null, 2));
