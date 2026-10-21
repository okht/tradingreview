import vinext from 'vinext';
import { cloudflare } from '@cloudflare/vite-plugin';
import { sites } from './scripts/vite/sites-vite-plugin.ts';
import { configureToolEnvironment } from './scripts/tool-environment.mjs';
configureToolEnvironment(process.cwd());
export default { plugins: [vinext(), sites({ mockAuth: false }), cloudflare({ viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] }, inspectorPort: false, config: { main: './worker/index.ts', compatibility_date: '2026-05-15', compatibility_flags: ['nodejs_compat'], d1_databases: [{ binding: 'DB', database_name: 'huikan', database_id: '00000000-0000-4000-8000-000000000000' }] } })] };
