/** The quick workspace has its own storage and server scope on the same origin. */
export function experienceMode(pathname = globalThis.location?.pathname || '/') {
  return /^\/quick(?:\/|$)/.test(pathname) ? 'quick' : 'full';
}

export function experienceStorage(storage, mode = experienceMode()) {
  const prefix = mode === 'quick' ? 'tradingreview.quick.' : '';
  return {
    getItem: key => storage.getItem(`${prefix}${key}`),
    setItem: (key, value) => storage.setItem(`${prefix}${key}`, value),
    removeItem: key => storage.removeItem(`${prefix}${key}`),
  };
}

export function experienceHeaders() {
  return { 'x-tradingreview-mode': experienceMode() };
}
