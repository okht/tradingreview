import { useEffect, useRef, useState } from 'react';
import { apiRequest } from './services/api.js';
import { readJourney } from './journey-state.js';
import { modelMetadata } from './model-connection.js';
import { migrateJourney, validateWorkspace } from './agent-workspace-state.js';

export function workspaceSnapshot(state) {
  if (state?.version === 2) return validateWorkspace(state);
  const safe = JSON.parse(JSON.stringify(state, (key, value) => /^(api[-_]?key|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|secret|authorization|config)$/i.test(key) ? undefined : value));
  if (safe.model) safe.model = modelMetadata(safe.model);
  return safe;
}

export async function inspectWorkspace({ live, signal, paused = false } = {}) {
  if (paused) return { revision: null, pendingRemote: null, ready: false, status: 'local' };
  try {
    const result = await apiRequest('/api/workspace', { signal });
    if (!Number.isInteger(result.revision) || result.revision < 0) throw new Error('同步服务返回了无效版本。');
    return { revision: result.revision, pendingRemote: result.state || null, ready: !result.state, status: result.state ? 'choice' : 'local' };
  } catch (error) {
    if (live || error.name === 'AbortError') throw error;
    // Demo stays usable without a server; a later live connection checks again.
    return { revision: null, pendingRemote: null, ready: false, status: 'local' };
  }
}

export function workspaceCanSave(state, ready, revision, { paused = false } = {}) {
  return !paused && (state.version === 2 || state.model?.mode === 'live') && ready && Number.isInteger(revision) && revision >= 0;
}

export function restoreWorkspaceSnapshot(input, targetVersion = 2) {
  if (targetVersion === 2) {
    if (input?.version === 2) return validateWorkspace(input);
    if (input?.version === 1) return migrateJourney(restoreWorkspaceSnapshot(input, 1));
    throw new Error('服务端工作区版本无效，本机记录已保留。');
  }
  if (input?.version !== 1 || !Array.isArray(input.trades) || !Array.isArray(input.savedItems)) throw new Error('服务端记录格式无效，本机记录已保留。');
  const marker = crypto.randomUUID();
  const restored = readJourney({ getItem: () => JSON.stringify({ ...input, __syncValidation: marker }) });
  if (restored.__syncValidation !== marker) throw new Error('服务端记录未通过校验，本机记录已保留。');
  delete restored.__syncValidation;
  return workspaceSnapshot(restored);
}

export function workspaceNeedsInspection(inspection, reload) {
  return inspection?.reload !== reload || !Number.isInteger(inspection.revision) || inspection.revision < 0;
}

export function sameWorkspace(left, right) {
  if (!right || left?.version !== right.version) return false;
  try { return JSON.stringify(workspaceSnapshot(left)) === JSON.stringify(workspaceSnapshot(right)); }
  catch { return false; }
}

/** Fresh tabs have different generated IDs but no user material to reconcile. */
export function automaticWorkspaceRestore(local, remote) {
  if (local?.version !== 2 || remote?.version !== 2 || local.model !== null || !Array.isArray(local.savedItems) || local.savedItems.length || !Array.isArray(local.conversations)) return null;
  try {
    validateWorkspace(local);
    const unused = local.conversations.every(item => item.title === '新对话' && item.contextRevision === 0
      && item.trades.length === 0 && item.selectedIds.length === 0 && item.messages.length === 0
      && item.draft === '' && item.origin === '' && item.pendingTrades === null && item.lastRequest === null
      && item.marketData === null && Object.keys(item.contexts).length === 0 && item.evidence.length === 0);
    return unused ? validateWorkspace(remote) : null;
  } catch { return null; }
}

export default function useWorkspaceSync(state, onRestore, { paused = false } = {}) {
  const enabled = state.version === 2 || state.model?.mode === 'live';
  const current = useRef(state); current.current = state;
  const restore = useRef(onRestore); restore.current = onRestore;
  const revision = useRef(null);
  const savedJson = useRef('');
  const busy = useRef(false);
  const epoch = useRef(0);
  const inspection = useRef(null);
  const saveRequest = useRef(null);
  const [ready, setReady] = useState(false);
  const [pendingRemote, setPendingRemote] = useState(null);
  const [status, setStatus] = useState('local');
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [reload, setReload] = useState(0);
  useEffect(() => () => { epoch.current++; saveRequest.current?.abort(); }, []);
  useEffect(() => {
    if (paused) {
      epoch.current++; saveRequest.current?.abort(); inspection.current = null; revision.current = null; busy.current = false;
      setReady(false); setPendingRemote(null); setStatus('local');
      return;
    }
    // Keep a successful read and the user's choice when restoring live data
    // changes the mode. A failed demo read retains null and retries in live.
    if (!workspaceNeedsInspection(inspection.current, reload)) return;
    const token = ++epoch.current; const controller = new AbortController();
    setReady(false); setPendingRemote(null); setError(''); revision.current = null; savedJson.current = ''; busy.current = false;
    setStatus(enabled ? 'checking' : 'local');
    inspectWorkspace({ live: enabled, signal: controller.signal }).then(result => {
      if (epoch.current !== token || controller.signal.aborted) return;
      inspection.current = { reload, revision: result.revision };
      revision.current = result.revision;
      if (sameWorkspace(current.current, result.pendingRemote)) {
        savedJson.current = JSON.stringify(workspaceSnapshot(current.current));
        setPendingRemote(null); setReady(true); setStatus('synced'); return;
      }
      // Check the latest state after the request: a draft typed during loading
      // must retain the explicit choice even if the tab started empty.
      const automatic = automaticWorkspaceRestore(current.current, result.pendingRemote);
      if (automatic) {
        savedJson.current = JSON.stringify(automatic);
        restore.current(automatic);
        setPendingRemote(null); setReady(true); setStatus('synced'); return;
      }
      setPendingRemote(result.pendingRemote); setReady(result.ready); setStatus(result.status);
    }).catch(e => { if (epoch.current === token && e.name !== 'AbortError') { setStatus('error'); setError(e.message); } });
    return () => controller.abort();
  }, [enabled, reload, paused]);
  useEffect(() => {
    if (!workspaceCanSave(state, ready, revision.current, { paused })) return;
    let snapshot;
    try { snapshot = workspaceSnapshot(state); }
    catch (e) { setReady(false); setStatus('error'); setError(`${e.message} 当前内容仍保留在页面中。`); return; }
    const json = JSON.stringify(snapshot);
    if (json === savedJson.current) return;
    const token = epoch.current;
    const timer = setTimeout(async () => {
      if (busy.current) { setTick(t => t + 1); return; }
      busy.current = true; setStatus('saving');
      const controller = new AbortController(); saveRequest.current = controller;
      try {
        const result = await apiRequest('/api/workspace', { method: 'PUT', body: { state: snapshot, revision: revision.current }, signal: controller.signal });
        if (epoch.current !== token) return;
        if (!Number.isInteger(result.revision) || result.revision <= revision.current) throw new Error('同步服务返回了无效版本。');
        revision.current = result.revision; savedJson.current = json; setStatus('synced'); setError('');
      } catch (e) { if (epoch.current === token) { setReady(false); setStatus('error'); setError(/本机.*保留/.test(e.message) ? e.message : `${e.message} 本机记录已保留。`); } }
      finally { if (saveRequest.current === controller) saveRequest.current = null; if (epoch.current === token) { busy.current = false; setTick(t => t + 1); } }
    }, 500);
    return () => clearTimeout(timer);
  }, [state, enabled, ready, tick, paused]);
  function keepLocal() { if (paused) return; setPendingRemote(null); setReady(true); setStatus('local'); }
  function restoreRemote() {
    if (paused) return;
    try {
      const remote = restoreWorkspaceSnapshot(pendingRemote, current.current.version === 2 ? 2 : 1);
      savedJson.current = pendingRemote.version === remote.version ? JSON.stringify(remote) : '';
      restore.current(remote); setPendingRemote(null); setReady(true); setStatus(pendingRemote.version === remote.version ? 'synced' : 'local');
    } catch (e) { setError(e.message); setStatus('error'); }
  }
  return { status, error, pendingRemote, keepLocal, restoreRemote, retry: () => setReload(n => n + 1), sourceLabel: status === 'synced' ? '本机与服务端已保存' : status === 'saving' ? '正在同步服务端' : '保存在本机' };
}
