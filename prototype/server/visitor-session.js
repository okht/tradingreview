const COOKIE_NAME = '__Host-tradingreview-visitor';
const LIFETIME_SECONDS = 180 * 24 * 60 * 60;
const encoder = new TextEncoder();
const TOKEN_PATTERN = /^v1\.([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.(\d{10})\.([A-Za-z0-9_-]{43})$/;

export class VisitorSessionError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function encode(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(value) {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='), character => character.charCodeAt(0));
}

function readCookie(request) {
  const values = (request.headers.get('cookie') || '').split(';').map(item => item.trim()).filter(item => item.startsWith(`${COOKIE_NAME}=`));
  return values.length === 1 ? values[0].slice(COOKIE_NAME.length + 1) : null;
}

async function signingKey(secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw new VisitorSessionError('体验服务正在准备，请稍后重试。', 503);
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export function workspaceMode(request) {
  const explicit = request.headers.get('x-tradingreview-mode');
  if (explicit === 'quick' || explicit === 'full') return explicit;
  const url = new URL(request.url);
  if (url.pathname === '/quick' || url.pathname.startsWith('/quick/')) return 'quick';
  try {
    const referrer = new URL(request.headers.get('referer'));
    if (referrer.origin === url.origin && (referrer.pathname === '/quick' || referrer.pathname.startsWith('/quick/'))) return 'quick';
  } catch { /* An absent or malformed referrer uses the full workspace. */ }
  return 'full';
}

function documentRequest(request) {
  if (!['GET', 'HEAD'].includes(request.method)) return false;
  const pathname = new URL(request.url).pathname;
  if (pathname.startsWith('/api/')) return false;
  return request.headers.get('sec-fetch-dest') === 'document'
    || request.headers.get('accept')?.includes('text/html')
    || ['/', '/quick', '/quick/', '/full', '/full/'].includes(pathname);
}

/**
 * Resolve a trusted gateway identity or a signed, host-bound anonymous visitor.
 * @param {Request} request
 * @param {{ secret?: string, authenticatedUserId?: string | null, now?: number }} options
 */
export async function resolveVisitorSession(request, { secret, authenticatedUserId = null, now = Date.now() } = {}) {
  const url = new URL(request.url);
  const isApi = url.pathname.startsWith('/api/');
  // Keep the existing API cross-site policy ahead of session establishment.
  if (isApi && ((request.headers.get('origin') && request.headers.get('origin') !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site')) {
    throw new VisitorSessionError('不接受跨站请求', 403);
  }
  const mode = workspaceMode(request);
  const partition = owner => mode === 'quick' ? `${owner}:quick` : owner;
  if (typeof authenticatedUserId === 'string' && authenticatedUserId.trim() && authenticatedUserId.length <= 290) {
    return { owner: partition(authenticatedUserId), cookie: null };
  }
  // Assets never create or rotate a visitor identity. The document response sets
  // the cookie before hydration starts any of the concurrent API requests.
  if (!isApi && !documentRequest(request)) return { owner: null, cookie: null };
  const key = await signingKey(secret);
  const token = readCookie(request);
  const match = typeof token === 'string' && token.length < 256 ? TOKEN_PATTERN.exec(token) : null;
  const seconds = Math.floor(now / 1000);
  if (match && Number(match[2]) > seconds && Number(match[2]) <= seconds + LIFETIME_SECONDS) {
    const payload = token.slice(0, token.lastIndexOf('.'));
    const valid = await crypto.subtle.verify('HMAC', key, decode(match[3]), encoder.encode(`${url.origin}\n${payload}`));
    if (valid) return { owner: partition(`visitor:${match[1]}`), cookie: null };
  }
  if (isApi) throw new VisitorSessionError('体验会话已过期，请刷新页面后重试。', 409);
  const id = crypto.randomUUID();
  const payload = `v1.${id}.${seconds + LIFETIME_SECONDS}`;
  const signature = encode(await crypto.subtle.sign('HMAC', key, encoder.encode(`${url.origin}\n${payload}`)));
  return {
    owner: partition(`visitor:${id}`),
    cookie: `${COOKIE_NAME}=${payload}.${signature}; Path=/; Max-Age=${LIFETIME_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
  };
}

export function applyVisitorCookie(response, session) {
  if (!session.cookie) return response;
  const headers = new Headers(response.headers);
  headers.append('set-cookie', session.cookie);
  // The first page establishes identity and must never be reused for another visitor.
  headers.set('cache-control', 'private, no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
