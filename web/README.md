# pico web

Preact + Vite + TypeScript. No UI or CSS framework. Builds to static files in `dist/`, which the engine serves at `/`.

    npm install
    npm run dev:mock        # mock engine (:7879) + vite (:5173), starts in setup state
    npm run dev:mock:ready  # same, skip the wizard
    npm run dev             # vite proxying /api to the real engine on :7878 (PICO_PORT)
    npm run build           # tsc --noEmit + vite build → dist/
    npm run preview:mock    # mock engine also serving dist/ at http://127.0.0.1:7879

Token lookup order: `window.__PICO_TOKEN__` (injected by the engine into index.html), then `?token=` in the URL (saved to localStorage),
then localStorage `pico.token`, then the "paste your key" screen.
The live `/api/events` stream uses EventSource, which can't set headers, so the token travels as `?token=`.

Layout: `src/api.ts` (client + SSE parser), `src/markdown.ts` (safe renderer), `src/screens/{Wizard,Chat,Settings}.tsx`,
`src/components/ui.tsx` (skeleton mascot, icons, toggles, modal, toasts), `src/styles.css`, `mock/mock-engine.ts`.
