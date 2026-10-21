import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createApi } from './api.js';
import { FileStore } from './local-store.js';
import { createLocalOAuth } from './oauth-local.js';
import { createFinancialDefaults } from './financial-config.js';
import { acquireLocalInstanceLock } from './local-instance-lock.js';
// .env.local is gitignored. Existing process variables retain precedence.
try { process.loadEnvFile(resolve('.env.local')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('无法加载本地环境配置，请检查 .env.local。'); }
const directory = resolve(process.env.HUIKAN_DATA_DIR || '.huikan-data');
const instanceLock = await acquireLocalInstanceLock(directory);
const store = await new FileStore(directory).load(); const oauth = await createLocalOAuth(directory);
const api = createApi({ store, local: true, oauth, financialDefaults: createFinancialDefaults(process.env), accountHosts: process.env.ACCOUNT_API_HOSTS || '' }); const assets = resolve('dist-local');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain' };
const port = Number(process.env.HUIKAN_PORT || 8787);
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) { res.writeHead(403); res.end('Invalid host'); return; }
    const controller = new AbortController(); res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    const headers = new Headers(); for (const [key, value] of Object.entries(req.headers)) if (value !== undefined && !key.startsWith('oai-authenticated-')) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    if (url.pathname.startsWith('/api/')) {
      const request = new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Readable.toWeb(req), duplex: 'half', signal: controller.signal });
      const response = await api(request); res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) for await (const chunk of Readable.fromWeb(response.body)) { if (!res.write(chunk)) await new Promise(resolve => res.once('drain', resolve)); }
      res.end(); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const candidate = resolve(assets, `.${decodeURIComponent(url.pathname)}`);
    if (!candidate.startsWith(assets + sep) && candidate !== assets) { res.writeHead(403); res.end(); return; }
    let file = candidate; try { if (!(await stat(file)).isFile()) file = resolve(assets, 'index.html'); } catch { file = resolve(assets, 'index.html'); }
    const content = await readFile(file); res.writeHead(200, { 'content-type': `${types[extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'x-content-type-options': 'nosniff' }); res.end(req.method === 'HEAD' ? undefined : content);
  } catch { if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: '本地服务尚未准备完成。开发时请使用 5173 端口；独立运行前请先构建。' })); }
});
server.listen(port, '127.0.0.1', () => console.log(`回看本地服务 http://127.0.0.1:${port}`));
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (shuttingDown) return; shuttingDown = true;
  server.close(async () => { try { await oauth.shutdown(); await instanceLock.release(); process.exit(0); } catch { process.exit(1); } });
  server.closeAllConnections();
});
