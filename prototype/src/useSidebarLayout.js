import { useEffect, useRef, useState } from 'react';
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_LAYOUT_KEY, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, clampSidebarWidth, normalizeSidebarPreferences, readSidebarPreferences, sidebarWidthForKey } from './sidebar-layout.js';

function initialPreferences() {
  try { return readSidebarPreferences(window.localStorage); }
  catch { return normalizeSidebarPreferences(null); }
}

function persist(preferences) {
  try { window.localStorage.setItem(SIDEBAR_LAYOUT_KEY, JSON.stringify(preferences)); }
  catch { /* The layout remains usable when browser storage is unavailable. */ }
}

export default function useSidebarLayout() {
  const [preferences, setPreferences] = useState(initialPreferences);
  const latest = useRef(preferences);
  const drag = useRef(null);
  const [isResizing, setIsResizing] = useState(false);

  function update(patch, save = false) {
    const next = normalizeSidebarPreferences({ ...latest.current, ...patch });
    latest.current = next;
    setPreferences(next);
    if (save) persist(next);
  }

  function finishResize(event) {
    const current = drag.current;
    if (!current || event && event.pointerId !== current.pointerId) return;
    drag.current = null;
    setIsResizing(false);
    persist(latest.current);
    if (current.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
  }

  function toggleCollapsed() {
    finishResize();
    update({ collapsed: !latest.current.collapsed }, true);
  }

  useEffect(() => () => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    persist(latest.current);
    if (current.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
  }, []);

  const separatorProps = {
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': '调整侧栏宽度',
    'aria-valuemin': SIDEBAR_MIN_WIDTH,
    'aria-valuemax': SIDEBAR_MAX_WIDTH,
    'aria-valuenow': preferences.width,
    'aria-valuetext': `${preferences.width} 像素`,
    tabIndex: 0,
    onPointerDown(event) {
      if (event.button !== 0 || latest.current.collapsed || drag.current) return;
      event.preventDefault();
      const target = event.currentTarget;
      target.focus({ preventScroll: true });
      target.setPointerCapture(event.pointerId);
      drag.current = { pointerId: event.pointerId, startX: event.clientX, width: latest.current.width, target };
      setIsResizing(true);
    },
    onPointerMove(event) {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      event.preventDefault();
      const width = clampSidebarWidth(current.width + event.clientX - current.startX);
      if (width !== latest.current.width) update({ width });
    },
    onPointerUp: finishResize,
    onPointerCancel: finishResize,
    onLostPointerCapture: finishResize,
    onKeyDown(event) {
      if (latest.current.collapsed) return;
      const width = sidebarWidthForKey(latest.current.width, event.key);
      if (width === null) return;
      event.preventDefault();
      finishResize();
      update({ width }, true);
    },
    onDoubleClick(event) {
      if (latest.current.collapsed) return;
      event.preventDefault();
      finishResize();
      update({ width: SIDEBAR_DEFAULT_WIDTH }, true);
    },
  };

  return { ...preferences, toggleCollapsed, separatorProps, isResizing };
}
