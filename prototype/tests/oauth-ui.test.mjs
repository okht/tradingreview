import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

// Exercise the actual component event handlers and effects with a small hook
// renderer. APIs and timers are local fakes; no authorization is requested.
function renderUI(file, { initialStatus = { status: 'connected', message: 'ChatGPT 授权已恢复。' }, initialAuth = 'oauth', routes = {} } = {}) {
  const cells = [], effects = [], timers = new Map(), calls = [], changes = [], connections = [];
  let cursor = 0, dirty = true, tree, mounted = true, timerId = 0, clears = 0, disconnects = 0;
  const state = { model: { mode: 'live', provider: 'openai', auth: initialAuth, model: 'test-model' }, connected: 'test-model' };
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: 'fragment',
    useState(initial) { const index = cursor++; if (!cells[index]) cells[index] = { value: typeof initial === 'function' ? initial() : initial }; return [cells[index].value, update => { const next = typeof update === 'function' ? update(cells[index].value) : update; if (!Object.is(next, cells[index].value)) { cells[index].value = next; dirty = true; } }]; },
    useRef(initial) { const index = cursor++; return (cells[index] ||= { current: initial }); },
    useId() { const index = cursor++; return `test-${index}`; },
    useEffect(callback, deps) { const index = cursor++; if (!cells[index] || !same(cells[index].deps, deps)) { const previous = cells[index]; cells[index] = { deps, cleanup: previous?.cleanup }; effects.push(() => { previous?.cleanup?.(); cells[index].cleanup = callback(); }); } },
  };
  const apiRequest = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (routes[path]) return routes[path](options);
    if (path === '/api/status') return { runtime: 'local', oauth: true };
    if (path === '/api/oauth/status') { if (initialStatus instanceof Error) throw initialStatus; return initialStatus; }
    if (path.startsWith('/api/models?')) return { models: [{ id: 'test-model' }] };
    if (path === '/api/models/connect') return { ok: true, provider: 'openai', model: 'test-model' };
    if (path === '/api/oauth/disconnect') return { status: 'idle', message: '授权已断开。' };
    if (path === '/api/oauth/cancel') return { status: 'connected' };
    if (path === '/api/oauth/start') return { status: 'pending', url: 'https://example.test/authorize' };
    throw new Error(`Unexpected request: ${path}`);
  };
  const componentName = file.replace('.jsx', '');
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const imported = [...source.matchAll(/^import \{([^}]+)\} from ['"][^'"]+['"];$/gm)].flatMap(match => match[1].split(',').map(value => value.trim()));
  const scope = { React, ...React, AbortController, apiRequest, clearSessionConfig: () => { clears++; }, hasSessionConfig: () => false, setSessionConfig: value => connections.push(value), modelMetadata: value => value, modelTransitionPatch: (_, model) => ({ model }), setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id) };
  for (const name of imported) if (!(name in scope)) scope[name] = name;
  const code = transformSync(source.replace(/^import .*;\r?\n/gm, '').replace('export default function', 'function'), { loader: 'jsx', format: 'cjs' }).code;
  const Component = vm.runInNewContext(`${code}\n${componentName}`, scope);
  const props = file === 'ModelSettings.jsx' ? { model: state.model, onConnected: model => changes.push(model), onDisconnected: () => { disconnects++; } } : { state, patch: change => changes.push(change), go: () => {} };
  function render() { cursor = 0; dirty = false; tree = Component(props); for (const node of nodes(tree)) if (node.type === 'input' && node.props.ref) node.props.ref.current ||= { value: node.props.type === 'password' ? 'fake-page-key' : '' }; const pending = effects.splice(0); pending.forEach(effect => effect()); }
  function nodes(node) {
    if (node == null || typeof node === 'boolean') return [];
    if (Array.isArray(node)) return node.flatMap(item => nodes(item));
    if (typeof node !== 'object') return [node];
    if (typeof node.type === 'function') return nodes(node.type(node.props));
    return [node, ...nodes(node.props?.children)];
  }
  function content(node) { return nodes(node).filter(value => typeof value === 'string' || typeof value === 'number').join(''); }
  async function settle() { for (let i = 0; i < 12; i++) { if (mounted && dirty) render(); await new Promise(resolve => setImmediate(resolve)); if (!dirty) return; } throw new Error('UI did not settle'); }
  async function click(label) { const button = nodes(tree).find(node => ['button', 'Button'].includes(node.type) && content(node) === label); assert.ok(button, `Missing button ${label}; UI: ${content(tree)}`); assert.ok(!button.props.disabled, `Disabled button ${label}`); const promise = button.props.onClick(); await settle(); return promise; }
  function unmount() { mounted = false; cells.forEach(cell => cell?.cleanup?.()); }
  render();
  return { calls, changes, connections, routes, state, settle, click, unmount, text: () => content(tree), clears: () => clears, disconnects: () => disconnects, async submitApi() { nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await settle(); }, async tick() { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) await callback(); await settle(); } };
}

for (const file of ['ModelSettings.jsx', 'ModelSetup.jsx']) {
  test(`${file}: restored authorization waits for explicit verification and never restarts login`, async () => {
    const ui = renderUI(file, { initialStatus: { status: 'connected', accessToken: 'never-render', refreshToken: 'never-render' } }); await ui.settle();
    assert.match(ui.text(), /使用已保存授权/); assert.doesNotMatch(ui.text(), /never-render|已通过连接验证/);
    assert.equal(ui.calls.filter(item => item.path === '/api/models/connect').length, 0);
    await ui.click('验证并连接'); await ui.settle();
    assert.equal(ui.calls.filter(item => item.path === '/api/models/connect').length, 1);
    assert.equal(ui.calls.filter(item => item.path === '/api/oauth/start').length, 0);
    assert.equal(ui.changes.length, 1); assert.equal(ui.connections[0].auth, 'oauth'); ui.unmount();
    assert.equal(ui.calls.filter(item => item.path === '/api/oauth/cancel').length, 0);
  });
  test(`${file}: disconnect clears UI metadata only after server confirmation`, async () => {
    const ui = renderUI(file, { routes: { '/api/oauth/disconnect': async () => { throw new Error('删除失败，请重试。'); } } }); await ui.settle();
    await ui.click('断开授权'); assert.equal(ui.clears(), 0); assert.match(ui.text(), /使用已保存授权/);
    ui.routes['/api/oauth/disconnect'] = async () => ({ status: 'idle' }); await ui.click('断开授权'); await ui.settle();
    assert.equal(ui.clears(), 1); assert.doesNotMatch(ui.text(), /使用已保存授权/);
    if (file === 'ModelSettings.jsx') assert.equal(ui.disconnects(), 1); else assert.equal(ui.changes[0].model, null);
    ui.unmount();
  });
  test(`${file}: cancel can retain saved authorization without disconnecting or auto-verifying`, async () => {
    const ui = renderUI(file, { initialStatus: { status: 'pending' } }); await ui.settle();
    await ui.click('取消授权'); await ui.settle();
    assert.match(ui.text(), /使用已保存授权/); assert.equal(ui.clears(), 0);
    assert.equal(ui.calls.filter(item => ['/api/oauth/disconnect', '/api/models/connect'].includes(item.path)).length, 0); ui.unmount();
  });
  test(`${file}: new login verifies automatically and closing only cancels an owned pending login`, async () => {
    const ui = renderUI(file, { initialStatus: { status: 'idle' } }); await ui.settle(); await ui.click('开始授权'); await ui.settle();
    ui.routes['/api/oauth/status'] = async () => ({ status: 'connected' }); await ui.tick();
    assert.equal(ui.calls.filter(item => item.path === '/api/models/connect').length, 1); ui.unmount();
    assert.equal(ui.calls.filter(item => item.path === '/api/oauth/cancel').length, 0);
    const pending = renderUI(file, { initialStatus: { status: 'idle' } }); await pending.settle(); await pending.click('开始授权'); await pending.settle(); pending.unmount();
    assert.equal(pending.calls.filter(item => item.path === '/api/oauth/cancel').length, 1);
    const other = renderUI(file, { initialStatus: { status: 'pending' } }); await other.settle(); other.unmount();
    assert.equal(other.calls.filter(item => item.path === '/api/oauth/cancel').length, 0);
  });
  test(`${file}: transient status failures preserve authorization and offer retry without login`, async () => {
    const ui = renderUI(file, { initialStatus: new Error('Network error') }); await ui.settle();
    assert.match(ui.text(), /已保存的授权不会被清除/); assert.equal(ui.clears(), 0);
    ui.routes['/api/oauth/status'] = async () => ({ status: 'connected' }); await ui.click('重新检查授权'); await ui.settle();
    assert.match(ui.text(), /使用已保存授权/); assert.equal(ui.calls.filter(item => item.path === '/api/oauth/start').length, 0); ui.unmount();
  });
  test(`${file}: background authorization lookup cannot abort or strand an API connection`, async () => {
    let resolveStatus, resolveConnect;
    const ui = renderUI(file, { initialAuth: 'api', routes: {
      '/api/oauth/status': () => new Promise(resolve => { resolveStatus = resolve; }),
      '/api/models/connect': () => new Promise(resolve => { resolveConnect = resolve; }),
    } }); await ui.settle(); await ui.submitApi();
    const status = ui.calls.find(item => item.path === '/api/oauth/status');
    const connect = ui.calls.find(item => item.path === '/api/models/connect');
    assert.equal(status.signal.aborted, false); assert.equal(connect.signal.aborted, false);
    resolveStatus({ status: 'connected' }); await ui.settle(); assert.equal(connect.signal.aborted, false);
    resolveConnect({ ok: true, provider: 'openai', model: 'test-model' }); await ui.settle();
    assert.equal(ui.changes.length, 1); assert.match(ui.text(), /已通过连接验证/); assert.doesNotMatch(ui.text(), /正在验证连接/); ui.unmount();
  });
}
