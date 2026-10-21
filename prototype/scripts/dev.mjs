import { spawn } from 'node:child_process';
const children = [spawn(process.execPath, ['--watch', 'server/local.js'], { stdio: 'inherit' }), spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5173'], { stdio: 'inherit' })];
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { for (const child of children) child.kill(); });
for (const child of children) child.on('exit', code => { if (code) { for (const other of children) if (other !== child) other.kill(); process.exitCode = code; } });
