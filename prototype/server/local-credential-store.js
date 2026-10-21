import * as filesystem from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const LOCAL_CREDENTIAL_FILE = 'oauth-credentials.dpapi.json';
const MAX_BYTES = 2 * 1024 * 1024;
const states = new Map();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class LocalCredentialStoreError extends Error {
  constructor(code, message) { super(message); this.name = 'LocalCredentialStoreError'; this.code = code; }
}
const failure = (code, message) => new LocalCredentialStoreError(code, message);
const aborted = signal => { if (signal?.aborted) throw new DOMException('本地授权操作已取消。', 'AbortError'); };

// Only this static program is passed on the command line. Token data travels
// through anonymous stdin/stdout pipes and never through arguments or logs.
const DPAPI_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  if (-not $IsWindows -or $PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7 -or [IO.Path]::GetFileName([Environment]::ProcessPath) -ine 'pwsh.exe') { throw 'runtime' }
  Add-Type -AssemblyName System.Security.Cryptography.ProtectedData
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json -AsHashtable
  if ($request.operation -eq 'probe') {
    [Console]::Out.Write('{"ok":true,"kind":"windows-dpapi-current-user"}')
    exit 0
  }
  $bytes = [Convert]::FromBase64String($request.data)
  $entropy = [Text.Encoding]::UTF8.GetBytes('huikan-local-credentials:v1')
  $scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
  if ($request.operation -eq 'protect') { $result = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, $scope) }
  elseif ($request.operation -eq 'unprotect') { $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, $scope) }
  else { throw 'operation' }
  [Console]::Out.Write((@{ ok = $true; data = [Convert]::ToBase64String($result) } | ConvertTo-Json -Compress))
  [Array]::Clear($bytes, 0, $bytes.Length)
  [Array]::Clear($result, 0, $result.Length)
} catch {
  [Console]::Out.Write('{"ok":false,"code":"DPAPI_FAILURE"}')
  exit 1
}
`;

function decodeBase64(value) {
  if (typeof value !== 'string' || !value.length || value.length > MAX_BYTES * 2 || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw failure('INVALID_ENCRYPTED_DATA', '本地授权密文格式无效，原文件已保留。');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > MAX_BYTES || bytes.toString('base64') !== value) throw failure('INVALID_ENCRYPTED_DATA', '本地授权密文格式无效，原文件已保留。');
  return bytes;
}

export async function createWindowsDpapiProtector({ pwshPath = process.env.HUIKAN_PWSH_PATH || 'pwsh.exe', spawnProcess = spawn, platform = process.platform, timeoutMs = 20000 } = {}) {
  if (platform !== 'win32') throw failure('DPAPI_UNAVAILABLE', '本地订阅授权持久化需要 Windows 当前用户加密环境。');
  if (typeof pwshPath !== 'string' || basename(pwshPath).toLowerCase() !== 'pwsh.exe') throw failure('PWSH_UNAVAILABLE', '请配置 PowerShell 7 的 pwsh.exe；不使用旧版 PowerShell。');
  async function invoke(operation, bytes) {
    return new Promise((resolveResult, reject) => {
      let child, settled = false, total = 0, timer;
      const chunks = [];
      const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolveResult(result); };
      const unavailable = () => failure('DPAPI_UNAVAILABLE', 'Windows 当前用户加密操作未完成，原授权记录已保留。');
      try { child = spawnProcess(pwshPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
      catch { finish(unavailable()); return; }
      timer = setTimeout(() => { child.kill(); finish(unavailable()); }, timeoutMs);
      child.on('error', () => finish(unavailable()));
      child.stdin.on('error', () => { child.kill(); finish(unavailable()); });
      child.stdout.on('data', chunk => {
        total += chunk.length;
        if (total > MAX_BYTES * 2) { child.kill(); finish(unavailable()); return; }
        chunks.push(chunk);
      });
      child.on('close', code => {
        if (settled) return;
        try {
          if (code !== 0) throw unavailable();
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!object(result) || result.ok !== true) throw unavailable();
          if (operation === 'probe') {
            if (result.kind !== 'windows-dpapi-current-user') throw unavailable();
            finish(null, undefined);
          } else finish(null, decodeBase64(result.data));
        } catch { finish(unavailable()); }
      });
      child.stdin.end(JSON.stringify({ operation, ...(bytes ? { data: bytes.toString('base64') } : {}) }));
    });
  }
  await invoke('probe');
  return { protect: bytes => invoke('protect', bytes), unprotect: bytes => invoke('unprotect', bytes) };
}

function sharedState(file) {
  const key = process.platform === 'win32' ? file.toLowerCase() : file;
  if (!states.has(key)) states.set(key, { entries: new Map(), queue: Promise.resolve() });
  return states.get(key);
}
function enqueue(state, action) {
  const next = state.queue.then(action);
  state.queue = next.catch(() => {});
  return next;
}
function providerId(id) {
  if (typeof id !== 'string' || !id.trim() || id.length > 200) throw failure('INVALID_CREDENTIAL', '授权服务标识无效。');
  return id;
}
function credential(value, id) {
  if (!object(value) || !['oauth', 'api_key'].includes(value.type)) throw failure('INVALID_CREDENTIAL', '授权记录格式无效。');
  const text = (item, maximum) => typeof item === 'string' && item.trim().length > 0 && item.length <= maximum;
  if (value.type === 'oauth') {
    if (!text(value.access, MAX_BYTES / 8) || !text(value.refresh, MAX_BYTES / 8) || typeof value.expires !== 'number' || !Number.isFinite(value.expires) || value.expires <= 0) throw failure('INVALID_CREDENTIAL', 'OAuth 授权记录不完整。');
    // Pi's current ChatGPT refresh flow requires both the original client ID
    // and the direct-token scope. Expired tokens remain eligible for refresh.
    if (id === 'openai' && (!text(value.clientId, 1024) || !Array.isArray(value.scopes) || value.scopes.length > 64 || !value.scopes.every(scope => text(scope, 256)) || !value.scopes.includes('chatgpt.tokens.use.direct'))) throw failure('INVALID_CREDENTIAL', 'ChatGPT 授权缺少刷新所需的客户端或权限信息。');
  }
  try {
    // Preserve provider-specific fields such as clientId and scopes. Reject
    // non-JSON values instead of silently dropping them during persistence.
    const copy = structuredClone(value);
    const encoded = JSON.stringify(copy, (_key, item) => {
      if (typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol' || item === undefined || (typeof item === 'number' && !Number.isFinite(item))) throw new Error('non-json');
      return item;
    });
    if (Buffer.byteLength(encoded) > MAX_BYTES / 2) throw new Error('too-large');
    return JSON.parse(encoded);
  } catch { throw failure('INVALID_CREDENTIAL', '授权记录无法安全保存。'); }
}
function entriesFrom(value) {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.credentials) || value.credentials.length > 32) throw failure('INVALID_CREDENTIAL_FILE', '本地授权记录格式无效，原文件已保留。');
  const entries = new Map();
  for (const pair of value.credentials) {
    if (!Array.isArray(pair) || pair.length !== 2) throw failure('INVALID_CREDENTIAL_FILE', '本地授权记录格式无效，原文件已保留。');
    const id = providerId(pair[0]);
    if (entries.has(id)) throw failure('INVALID_CREDENTIAL_FILE', '本地授权记录存在重复项，原文件已保留。');
    entries.set(id, credential(pair[1], id));
  }
  return entries;
}

class LocalCredentialStore {
  constructor(directory, protector, fileSystem) {
    this.directory = directory; this.file = join(directory, LOCAL_CREDENTIAL_FILE);
    this.protector = protector; this.fs = fileSystem; this.state = sharedState(this.file);
  }
  async load() {
    return enqueue(this.state, async () => {
      try {
        await this.fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        let raw;
        try { const stat = await this.fs.lstat(this.file); if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('invalid-file'); raw = await this.fs.readFile(this.file, 'utf8'); }
        catch (error) { if (error.code === 'ENOENT') { this.state.entries = new Map(); return this; } throw error; }
        const envelope = JSON.parse(raw);
        if (!object(envelope) || envelope.version !== 1 || envelope.protection !== 'windows-dpapi-current-user') throw new Error('invalid-envelope');
        const clear = await this.protector.unprotect(decodeBase64(envelope.ciphertext));
        if (!Buffer.isBuffer(clear) || clear.length > MAX_BYTES) throw new Error('invalid-plaintext');
        try { const entries = entriesFrom(JSON.parse(clear.toString('utf8'))); this.state.entries = entries; }
        finally { clear.fill(0); }
        return this;
      } catch { throw failure('CREDENTIAL_LOAD_FAILED', '本地授权记录无法读取或解密，原文件已保留。请明确断开授权后重新连接。'); }
    });
  }
  async persist(entries) {
    let clear, temporary, handle;
    try {
      if (entries.size > 32) throw new Error('too-many');
      clear = Buffer.from(JSON.stringify({ version: 1, credentials: [...entries] }), 'utf8');
      if (clear.length > MAX_BYTES / 2) throw new Error('too-large');
      const encrypted = await this.protector.protect(clear);
      if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_BYTES / 2) throw new Error('invalid-ciphertext');
      const content = JSON.stringify({ version: 1, protection: 'windows-dpapi-current-user', ciphertext: encrypted.toString('base64') });
      temporary = `${this.file}.${randomUUID()}.tmp`;
      handle = await this.fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(content, 'utf8'); await handle.sync(); await handle.close(); handle = null;
      await this.fs.rename(temporary, this.file); temporary = null;
    } catch { throw failure('CREDENTIAL_SAVE_FAILED', '本地授权加密保存失败，先前授权记录已保留。'); }
    finally {
      clear?.fill(0);
      if (handle) { try { await handle.close(); } catch {} }
      if (temporary) { try { await this.fs.unlink(temporary); } catch {} }
    }
  }
  async read(id, { signal } = {}) { aborted(signal); return structuredClone(this.state.entries.get(providerId(id))); }
  async list({ signal } = {}) { aborted(signal); return [...this.state.entries].map(([id, value]) => ({ providerId: id, type: value.type })); }
  modify(id, fn, { signal } = {}) {
    providerId(id);
    return enqueue(this.state, async () => {
      aborted(signal);
      // Once fn starts, a rotated refresh token must finish saving even if the
      // initiating request is cancelled. Logout is serialized after this work.
      const value = await fn(structuredClone(this.state.entries.get(id)));
      if (value !== undefined) {
        const entries = new Map(this.state.entries); entries.set(id, credential(value, id));
        await this.persist(entries); this.state.entries = entries;
      }
      return structuredClone(this.state.entries.get(id));
    });
  }
  delete(id, { signal } = {}) {
    providerId(id);
    return enqueue(this.state, async () => {
      aborted(signal);
      if (!this.state.entries.has(id)) return;
      const entries = new Map(this.state.entries); entries.delete(id);
      await this.persist(entries); this.state.entries = entries;
    });
  }
  async flush() { await this.state.queue; }
}

async function configuredStore(directory, options, deferProtector = false) {
  if (typeof directory !== 'string' || !directory.trim()) throw failure('INVALID_CREDENTIAL_DIRECTORY', '本地授权目录无效。');
  let ready;
  const deferred = { protect: async bytes => (await (ready ||= createWindowsDpapiProtector(options))).protect(bytes), unprotect: async bytes => (await (ready ||= createWindowsDpapiProtector(options))).unprotect(bytes) };
  const protector = options.protector || (deferProtector ? deferred : await createWindowsDpapiProtector(options));
  if (typeof protector.protect !== 'function' || typeof protector.unprotect !== 'function') throw failure('DPAPI_UNAVAILABLE', '本地授权加密组件不可用。');
  return new LocalCredentialStore(resolve(directory), protector, options.fileSystem || filesystem);
}
export async function createLocalCredentialStore(directory, options = {}) { return (await configuredStore(directory, options)).load(); }

/** Only the explicit disconnect flow should call this; corruption never resets itself. */
export async function resetLocalCredentialStore(directory, options = {}) {
  // Explicit erasure must still work if the runtime or encryption environment
  // is unavailable. Any later write must initialize DPAPI and fail closed.
  const store = await configuredStore(directory, options, true);
  return enqueue(store.state, async () => {
    try { await store.fs.mkdir(store.directory, { recursive: true, mode: 0o700 }); await store.fs.unlink(store.file); }
    catch (error) { if (error.code !== 'ENOENT') throw failure('CREDENTIAL_DELETE_FAILED', '本地授权文件未能清除，先前授权记录已保留。'); }
    store.state.entries = new Map();
    return store;
  });
}
