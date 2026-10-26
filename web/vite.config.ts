import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';

const MOCK = process.env.PICO_MOCK === '1';
const MOCK_PORT = process.env.PICO_MOCK_PORT || '7879';
const target = MOCK ? `http://127.0.0.1:${MOCK_PORT}` : `http://127.0.0.1:${process.env.PICO_PORT || '7878'}`;

// In mock dev mode, inject the mock token so the app skips the "paste your token" screen.
const injectMockToken = (): Plugin => ({
  name: 'pico-mock-token',
  transformIndexHtml(html) {
    return MOCK ? html.replace('</head>', `<script>window.__PICO_TOKEN__="mock-token"</script></head>`) : html;
  },
});

export default defineConfig({
  plugins: [preact(), injectMockToken()],
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2020', cssCodeSplit: false },
  server: { port: 5173, proxy: { '/api': { target, changeOrigin: false } } },
});
