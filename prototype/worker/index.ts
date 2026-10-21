import handler from 'vinext/server/fetch-handler';
import { createApi } from '../server/api.js';
import { D1Store } from '../server/storage.js';
import { createFinancialDefaults } from '../server/financial-config.js';
import { resolveVisitorSession, applyVisitorCookie, VisitorSessionError } from '../server/visitor-session.js';
type Env = { DB: D1Database; VISITOR_SESSION_SECRET?: string; ACCOUNT_API_HOSTS?: string; FINANCIAL_OWNER_ID?: string; FUYAO_API_KEY?: string; FUYAO_MCP_URL?: string; IFIND_MCP_URL?: string; IFIND_API_KEY?: string; IFIND_AUTH_HEADER?: string };
// Keep verification metadata across requests in a warm Worker. Credentials
// remain in its server-only closure, scoped to the current environment object.
const financialConnections = new WeakMap<object, ReturnType<typeof createFinancialDefaults>>();
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    try {
      const session = await resolveVisitorSession(request, { secret: env.VISITOR_SESSION_SECRET, authenticatedUserId: request.headers.get('oai-authenticated-user-id') });
      if (!financialConnections.has(env)) financialConnections.set(env, createFinancialDefaults(env));
      if (new URL(request.url).pathname.startsWith('/api/')) {
        return createApi({ store: new D1Store(env.DB), financialDefaults: financialConnections.get(env), accountHosts: env.ACCOUNT_API_HOSTS || '' })(request, session.owner);
      }
      return applyVisitorCookie(await handler.fetch(request, env, ctx), session);
    } catch (error) {
      if (!(error instanceof VisitorSessionError)) throw error;
      return new Response(JSON.stringify({ message: error.message }), { status: error.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    }
  },
};
