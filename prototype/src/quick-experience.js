import { WORKSPACE_KEY, validateWorkspace } from './agent-workspace-state.js';

/** Seed only an unused quick workspace; never overwrite edits on refresh. */
export async function initializeQuickExperience(storage, { fetchSeed = () => fetch('/demo/quick-workspace.json') } = {}) {
  if (storage.getItem(WORKSPACE_KEY) !== null) return false;
  const response = await fetchSeed();
  if (!response.ok) throw new Error('经典案例暂时没有加载成功，请重试。');
  const seed = validateWorkspace(await response.json());
  if (seed.model !== null) throw new Error('经典案例不能携带模型连接。');
  // A second tab may finish initializing while the request is in flight.
  if (storage.getItem(WORKSPACE_KEY) !== null) return false;
  storage.setItem(WORKSPACE_KEY, JSON.stringify(seed));
  return true;
}
