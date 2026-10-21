import { readJourney, JOURNEY_KEY } from '../src/journey-state.js';
import { validateWorkspace } from '../src/agent-workspace-state.js';

export function cleanWorkspace(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('工作区格式无效'), { status: 400 });
  const json = JSON.stringify(input, (key, value) => /^(api[-_]?key|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|secret|authorization|config)$/i.test(key) ? undefined : value);
  if (json.length > 900000) throw Object.assign(new Error('工作区超过保存上限，请导出归档后新建复盘'), { status: 413 });
  const parsed = JSON.parse(json);
  if (parsed.version === 2) return validateWorkspace(parsed);
  // readJourney intentionally falls back to a fresh UI state on invalid input.
  // A private, temporary marker distinguishes that fallback even for empty drafts.
  const marker = crypto.randomUUID();
  const validationJson = JSON.stringify({ ...parsed, __huikanWorkspaceValidation: marker });
  const checked = readJourney({ getItem: key => key === JOURNEY_KEY ? validationJson : null });
  if (checked.__huikanWorkspaceValidation !== marker) throw Object.assign(new Error('工作区数据不完整，未覆盖已保存记录'), { status: 400 });
  delete checked.__huikanWorkspaceValidation;
  return checked;
}

export class MemoryStore {
  workspaces = new Map(); runs = new Map();
  async get(owner) { return structuredClone(this.workspaces.get(owner) || { state: null, revision: 0 }); }
  async put(owner, state, revision) {
    // Keep the revision check and write synchronous so concurrent callers cannot both win.
    const old = this.workspaces.get(owner) || { state: null, revision: 0 };
    if (old.revision !== revision) throw Object.assign(new Error('另一处已更新这份复盘，请先重新载入服务器记录。当前本机内容已保留。'), { status: 409 });
    const next = { state: cleanWorkspace(state), revision: revision + 1 };
    this.workspaces.set(owner, next); return { revision: next.revision };
  }
  async saveRun(owner, run) { this.runs.set(`${owner}:${run.id}`, structuredClone(run)); }
  async getRun(owner, id) { return this.runs.get(`${owner}:${id}`) || null; }
}

export class D1Store {
  constructor(db) { this.db = db; }
  async get(owner) {
    const row = await this.db.prepare('SELECT state_json, revision FROM workspaces WHERE owner_id = ?').bind(owner).first();
    return row ? { state: JSON.parse(row.state_json), revision: row.revision } : { state: null, revision: 0 };
  }
  async put(owner, state, revision) {
    const json = JSON.stringify(cleanWorkspace(state));
    const updatedAt = new Date().toISOString();
    const result = revision === 0
      ? await this.db.prepare('INSERT INTO workspaces (owner_id, state_json, revision, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(owner_id) DO NOTHING').bind(owner, json, updatedAt).run()
      : await this.db.prepare('UPDATE workspaces SET state_json = ?, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND revision = ?').bind(json, updatedAt, owner, revision).run();
    if (result.meta.changes !== 1) throw Object.assign(new Error('服务器记录已有更新。请重新载入后重试，本机内容已保留。'), { status: 409 });
    return { revision: revision + 1 };
  }
  async saveRun(owner, run) {
    await this.db.prepare('INSERT INTO analysis_runs (id, owner_id, snapshot_json, created_at) VALUES (?, ?, ?, ?)').bind(run.id, owner, JSON.stringify(run), run.createdAt).run();
  }
  async getRun(owner, id) {
    const row = await this.db.prepare('SELECT snapshot_json FROM analysis_runs WHERE owner_id = ? AND id = ?').bind(owner, id).first();
    return row ? JSON.parse(row.snapshot_json) : null;
  }
}
