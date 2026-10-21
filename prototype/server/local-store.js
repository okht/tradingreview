import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { MemoryStore, cleanWorkspace } from './storage.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function readEntries(value, validate) {
  if (!Array.isArray(value)) throw new Error('Invalid saved collection');
  const entries = new Map();
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || !pair[0].trim() || entries.has(pair[0])) throw new Error('Invalid or duplicate saved entry');
    entries.set(pair[0], validate(pair[1], pair[0]));
  }
  return entries;
}
function readWorkspace(value) {
  if (!object(value) || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('Invalid revision');
  if (value.state === null && value.revision === 0) return { state: null, revision: 0 };
  if (!value.state || value.revision === 0) throw new Error('Invalid saved state');
  return { state: cleanWorkspace(value.state), revision: value.revision };
}
function readRun(value, key) {
  if (!object(value) || typeof value.id !== 'string' || !value.id || value.id.includes(':') || !key.endsWith(`:${value.id}`) || !object(value.result)
    || (value.createdAt !== undefined && (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))))) throw new Error('Invalid analysis snapshot');
  return value;
}

export class FileStore extends MemoryStore {
  constructor(directory) { super(); this.directory = directory; this.queue = Promise.resolve(); }
  async load() {
    return this.transact(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      try {
        const value = JSON.parse(await readFile(join(this.directory, 'workspace.json'), 'utf8'));
        if (!object(value)) throw new Error('Invalid saved root');
        // Validate both collections before replacing any current state. Valid
        // JSON with absent/duplicate/invalid entries is corruption, not empty.
        const workspaces = readEntries(value.workspaces, readWorkspace);
        const runs = readEntries(value.runs, readRun);
        this.workspaces = workspaces; this.runs = runs;
      } catch (error) { if (error.code !== 'ENOENT') throw new Error('本地数据文件读取失败，请保留文件并检查备份。'); }
      return this;
    });
  }
  async persist() { const file = join(this.directory, 'workspace.json'); await writeFile(`${file}.tmp`, JSON.stringify({ workspaces: [...this.workspaces], runs: [...this.runs] }), { mode: 0o600 }); await rename(`${file}.tmp`, file); }
  transact(action) { const next = this.queue.then(action); this.queue = next.catch(() => {}); return next; }
  // Reads wait for commits or rollback. They cannot expose an in-memory
  // revision/run that might still fail its filesystem write.
  async get(owner) { await this.queue; return super.get(owner); }
  async getRun(owner, id) { await this.queue; return structuredClone(await super.getRun(owner, id)); }
  async put(owner, state, revision) { return this.transact(async () => { const previous = new Map(this.workspaces); try { const result = await super.put(owner, state, revision); await this.persist(); return result; } catch (error) { this.workspaces = previous; throw error; } }); }
  async saveRun(owner, run) { return this.transact(async () => { const previous = new Map(this.runs); try { await super.saveRun(owner, run); await this.persist(); } catch (error) { this.runs = previous; throw error; } }); }
}
