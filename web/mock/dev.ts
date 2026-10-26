// `npm run dev:mock`: mock engine on :7879 + Vite dev server (proxying /api to it).
const env = { ...process.env, PICO_MOCK: '1', PICO_MOCK_PORT: process.env.PICO_MOCK_PORT || '7879' };
const extra = process.argv.slice(2);
const mock = Bun.spawn(['bun', 'mock/mock-engine.ts', '--port', env.PICO_MOCK_PORT, ...extra], { env, stdout: 'inherit', stderr: 'inherit' });
const vite = Bun.spawn(['npx', 'vite'], { env, stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' });
const stop = () => { mock.kill(); vite.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await Promise.race([mock.exited, vite.exited]);
stop();
export {};
