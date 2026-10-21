process.env.HUIKAN_CLOUD = '1';
process.argv = [process.execPath, process.argv[1], 'build'];
await import('./run-framework.mjs');
