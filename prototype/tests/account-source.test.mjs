import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAccountTrades } from '../server/account-source.js';
import { sampleTrades } from '../src/domain.js';

const endpoint = 'https://trades.example.test/history?symbol=DEMO001';
const options = { allowedHosts: 'trades.example.test' };
const payload = overrides => ({ currency: 'CNY', quantityUnit: 'share', assetType: 'stock', trades: structuredClone(sampleTrades), ...overrides });
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

test('account source requires explicit host configuration and strict credential-free HTTPS URL', async () => {
  for (const [body, config] of [[{ endpoint }, {}], [{ endpoint: endpoint.replace('https:', 'http:') }, options], [{ endpoint: 'https://other.example.test/' }, options], [{ endpoint: 'https://user:password@trades.example.test/' }, options], [{ endpoint: `${endpoint}&token=bad` }, options]]) await assert.rejects(fetchAccountTrades(body, config));
});

test('account source uses only GET with Bearer, no redirects and always imports independent data', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, endpoint); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual'); assert.equal(init.headers.Authorization, 'Bearer test-only'); assert.ok(init.signal);
      return json(payload({ trades: sampleTrades.map(t => ({ ...t, fee: null })) }));
    };
    const result = await fetchAccountTrades({ endpoint, token: 'test-only' }, options);
    assert.equal(result.marketMode, 'import'); assert.equal(result.trades[0].fee, null); assert.match(result.warnings[0], /未知/);
    assert.equal(JSON.stringify(result).includes('test-only'), false);
  } finally { globalThis.fetch = previous; }
});

test('account source rejects redirects, non-JSON, oversized bodies and private upstream error details', async () => {
  const previous = globalThis.fetch;
  try {
    for (const response of [new Response('', { status: 302, headers: { location: 'https://elsewhere.test/' } }), new Response('<html/>'), new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '1048577' } }), new Response('x'.repeat(1048577), { headers: { 'content-type': 'application/json' } })]) {
      globalThis.fetch = async () => response; await assert.rejects(fetchAccountTrades({ endpoint }, options));
    }
    globalThis.fetch = async () => { throw new Error('secret-upstream-test-only'); };
    await assert.rejects(fetchAccountTrades({ endpoint }, options), error => !error.message.includes('secret-upstream'));
  } finally { globalThis.fetch = previous; }
});

test('account source rejects crypto, incomplete fee schema, duplicate and mixed-symbol records', async () => {
  const previous = globalThis.fetch;
  try {
    const missingFee = sampleTrades.map(({ fee, ...trade }) => trade);
    for (const data of [payload({ assetType: 'crypto' }), payload({ currency: 'USDT' }), payload({ quantityUnit: 'coin' }), payload({ trades: missingFee }), payload({ trades: [sampleTrades[0], sampleTrades[0]] }), payload({ trades: [sampleTrades[0], { ...sampleTrades[1], symbol: 'OTHER' }] })]) {
      globalThis.fetch = async () => json(data); await assert.rejects(fetchAccountTrades({ endpoint }, options));
    }
  } finally { globalThis.fetch = previous; }
});

test('cancelled account request does not reach the upstream service', async () => {
  const previous = globalThis.fetch; let called = false; const controller = new AbortController(); controller.abort();
  try { globalThis.fetch = async () => { called = true; return json(payload()); }; await assert.rejects(fetchAccountTrades({ endpoint }, { ...options, signal: controller.signal }), /取消/); assert.equal(called, false); }
  finally { globalThis.fetch = previous; }
});
