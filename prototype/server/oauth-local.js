import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRuntime } from './model-runtime.js';
import { createLocalCredentialStore, resetLocalCredentialStore } from './local-credential-store.js';

const savedStatus = (restored = false) => ({ status: 'connected', persisted: true, message: restored ? 'ChatGPT 授权已恢复，重启本地服务无需重复授权。' : 'ChatGPT 授权已加密保存在本机，重启后自动恢复。' });
const storageError = () => ({ status: 'error', message: '本机保存的授权暂时无法读取或保存。可以断开本地授权后重新连接；其他工作区材料保留。' });
const unavailable = () => Object.assign(new Error('本地授权存储尚未就绪，请断开本地授权后重新连接。'), { status: 503 });
const interrupted = () => Object.assign(new Error('授权操作已停止。'), { name: 'AbortError' });
function authorization(value) {
  if (value === undefined) return undefined;
  if (value?.type !== 'oauth' || !['access', 'refresh', 'clientId'].every(key => typeof value[key] === 'string' && value[key].trim())
    || !Number.isFinite(value.expires) || !Array.isArray(value.scopes) || !value.scopes.every(scope => typeof scope === 'string') || !value.scopes.includes('chatgpt.tokens.use.direct')) throw unavailable();
  return value;
}

export async function createLocalOAuth(directory, { credentialStoreFactory = createLocalCredentialStore, credentialStoreReset = resetLocalCredentialStore, runtimeFactory = createRuntime } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const devicePath = join(directory, 'device-id'); let deviceId;
  try { deviceId = (await readFile(devicePath, 'utf8')).trim(); } catch (e) { if (e.code !== 'ENOENT') throw e; deviceId = crypto.randomUUID(); await writeFile(devicePath, deviceId, { mode: 0o600, flag: 'wx' }); }
  let store, state = { status: 'idle' }, login, generation = 0, closing = false;
  try {
    store = await credentialStoreFactory(directory);
    if (authorization(await store.read('openai'))) state = savedStatus(true);
  } catch { state = storageError(); }
  // SDK refresh-token rotation is committed by modify before it returns.
  const credentials = {
    read(id) { if (!store) throw unavailable(); return store.read(id); },
    list() { if (!store) throw unavailable(); return store.list(); },
    modify(id, fn, options) { if (!store) throw unavailable(); if (closing) throw interrupted(); return store.modify(id, async value => { const next = await fn(value); if (id === 'openai') authorization(next); return next; }, options); },
    delete(id) { if (!store) throw unavailable(); return store.delete(id); },
  };
  function stopLogin() { generation++; login?.abort(); login = undefined; }
  async function retainedState() {
    if (!store) return storageError();
    try { return authorization(await store.read('openai')) ? savedStatus(true) : { status: 'idle' }; } catch { return storageError(); }
  }
  return {
    credentials, status() { return { ...state }; },
    async cancel() { if (state.status === 'disconnecting') return { ...state }; stopLogin(); const current = generation; await store?.flush?.(); if (current === generation) state = await retainedState(); return { ...state }; },
    async disconnect() {
      if (state.status === 'disconnecting') throw interrupted();
      stopLogin(); state = { status: 'disconnecting', message: '正在移除本机授权。' };
      try {
        if (store) await store.delete('openai');
        else store = await credentialStoreReset(directory);
        state = { status: 'idle', message: '本机保存的 ChatGPT 授权已移除。' };
        return { ...state };
      } catch { state = storageError(); throw unavailable(); }
    },
    async shutdown() {
      closing = true; stopLogin();
      // A started SDK refresh may continue after cancellation; drain its write.
      await store?.flush?.();
    },
    async start() {
      if (closing) throw interrupted();
      if (!store) throw unavailable();
      if (state.status === 'disconnecting') throw interrupted();
      if (state.status === 'pending') return { ...state };
      const beforeRead = generation, existing = authorization(await store.read('openai'));
      if (beforeRead !== generation || closing) throw interrupted();
      if (existing) { state = savedStatus(true); return { ...state }; }
      const current = ++generation; login?.abort(); login = new AbortController();
      const signal = AbortSignal.any([login.signal, AbortSignal.timeout(300000)]);
      state = { status: 'pending', message: '正在准备授权页面' };
      // Old cancelled logins cannot recreate a credential after disconnect.
      const loginCredentials = { ...credentials, modify(id, fn, options) {
        if (current !== generation || signal.aborted) return Promise.reject(interrupted());
        return credentials.modify(id, async value => {
          if (current !== generation || signal.aborted) throw interrupted();
          const next = await fn(value);
          if (current !== generation || signal.aborted) throw interrupted();
          return next;
        }, options);
      } };
      try {
      const { models, providerId } = runtimeFactory({ provider: 'openai', auth: 'oauth' }, { credentials: loginCredentials });
      void models.login(providerId, 'oauth', {
        signal,
        notify(event) { if (current === generation && event.type === 'auth_url') state = { status: 'pending', url: event.url, message: '请在授权页面完成登录，完成后返回产品。' }; },
        prompt(prompt) { return new Promise((resolve, reject) => { const cancel = () => reject(new Error('授权已取消')); const promptSignal = prompt.signal || signal; if (promptSignal.aborted) cancel(); else promptSignal.addEventListener('abort', cancel, { once: true }); }); },
      }, { getDeviceId: () => deviceId, agentName: '回看' }).then(() => { if (current === generation) state = savedStatus(); }).catch(() => { if (current === generation) state = { status: 'error', message: '授权未完成或未能安全保存。请检查本地存储及 1455 端口后重试。' }; });
      } catch { state = { status: 'error', message: '授权服务暂时不可用，请稍后重试。' }; }
      return { ...state };
    },
  };
}
