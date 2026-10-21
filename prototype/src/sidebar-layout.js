export const SIDEBAR_LAYOUT_KEY = 'huikan.sidebar.layout.v1';
export const SIDEBAR_DEFAULT_WIDTH = 248;
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 360;
export const SIDEBAR_KEYBOARD_STEP = 16;

export function clampSidebarWidth(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)));
}

export function normalizeSidebarPreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { width: SIDEBAR_DEFAULT_WIDTH, collapsed: false };
  return { width: clampSidebarWidth(value.width), collapsed: typeof value.collapsed === 'boolean' ? value.collapsed : false };
}

export function readSidebarPreferences(storage) {
  try { return normalizeSidebarPreferences(JSON.parse(storage.getItem(SIDEBAR_LAYOUT_KEY))); }
  catch { return normalizeSidebarPreferences(null); }
}

export function sidebarWidthForKey(width, key) {
  const current = clampSidebarWidth(width);
  if (key === 'ArrowLeft') return clampSidebarWidth(current - SIDEBAR_KEYBOARD_STEP);
  if (key === 'ArrowRight') return clampSidebarWidth(current + SIDEBAR_KEYBOARD_STEP);
  if (key === 'Home') return SIDEBAR_MIN_WIDTH;
  if (key === 'End') return SIDEBAR_MAX_WIDTH;
  return null;
}
