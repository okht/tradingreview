import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { pipeline } from 'node:stream'
import { fileURLToPath } from 'node:url'

const directory = fileURLToPath(new URL('./dist/', import.meta.url))
const host = '127.0.0.1'
const port = 3031
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.pdf': 'application/pdf', '.wasm': 'application/wasm',
}

let root
try {
  root = await realpath(directory)
  if (!(await stat(resolve(root, 'index.html'))).isFile()) throw new Error('missing index')
} catch {
  console.error('未找到编译版 dist/index.html。请保留交付包中的 dist，或先运行 npm run build。')
  process.exit(1)
}

function withinRoot(path) {
  const part = relative(root, path)
  return part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(part)
}

function reply(res, code, message, method) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(method === 'HEAD' ? undefined : message)
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    return reply(res, 405, 'Method not allowed', req.method)
  }
  let pathname
  try {
    pathname = decodeURIComponent((req.url || '/').split('?')[0])
  } catch {
    return reply(res, 400, 'Invalid path', req.method)
  }
  if (!pathname.startsWith('/') || /[\\\0:]/.test(pathname) || pathname.split('/').includes('..')) {
    return reply(res, 403, 'Forbidden', req.method)
  }
  let file = resolve(root, `.${pathname}`)
  if (!withinRoot(file)) return reply(res, 403, 'Forbidden', req.method)

  try {
    let info
    try { info = await stat(file) } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
    }
    if (!info?.isFile()) {
      if (extname(pathname)) return reply(res, 404, 'Not found', req.method)
      file = resolve(root, 'index.html')
    }
    file = await realpath(file)
    if (!withinRoot(file)) return reply(res, 403, 'Forbidden', req.method)
    info = await stat(file)
    res.writeHead(200, {
      'Content-Type': types[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    })
    if (req.method === 'HEAD') return res.end()
    pipeline(createReadStream(file), res, () => {})
  } catch {
    if (!res.headersSent) reply(res, 404, 'Not found', req.method)
    else res.destroy()
  }
})

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? '端口 3031 已被占用。' : `预览服务启动失败：${error.message}`)
  process.exitCode = 1
})
server.listen(port, host, () => {
  console.log(`演示预览：http://${host}:${port}/`)
  console.log('仅本机访问，按 Ctrl+C 停止。')
})
