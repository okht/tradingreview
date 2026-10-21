import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const directory = fileURLToPath(new URL('.', import.meta.url))
const cli = fileURLToPath(new URL('./node_modules/@slidev/cli/bin/slidev.mjs', import.meta.url))
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: directory,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --dns-result-order=ipv4first`.trim(),
  },
})

child.on('error', error => {
  console.error(`Slidev 启动失败：${error.message}`)
  process.exitCode = 1
})
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0)
})
