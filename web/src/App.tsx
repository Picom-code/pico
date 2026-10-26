import { useCallback, useEffect, useState } from 'preact/hooks';
import { api, getToken, setToken, clearToken, setUnauthorizedHandler, type Health } from './api';
import { Skeleton, Spinner, Toasts } from './components/ui';
import { Wizard } from './screens/Wizard';
import { Chat } from './screens/Chat';

type Phase = 'loading' | 'token' | 'setup' | 'app' | 'offline';

export function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [health, setHealth] = useState<Health | null>(null);

  const boot = useCallback(async () => {
    try {
      const h = await api.health();
      setHealth(h);
      if (!getToken()) { setPhase('token'); return; }
      // Verify the token actually works before going further.
      try { await api.config(); } catch (e: any) { if (e?.status === 401) { setPhase('token'); return; } }
      setPhase(h.state === 'setup' ? 'setup' : 'app');
    } catch {
      setPhase('offline');
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => { clearToken(); setPhase('token'); });
    boot();
  }, []);

  return (
    <>
      {phase === 'loading' && <Center><Skeleton mood="idle" size="lg" /><Spinner /></Center>}
      {phase === 'offline' && <Offline onRetry={boot} />}
      {phase === 'token' && <TokenScreen onSaved={boot} />}
      {phase === 'setup' && <Wizard onDone={() => { setPhase('app'); }} onCancel={() => setPhase('app')} />}
      {phase === 'app' && <Chat health={health} onNeedSetup={async () => { try { setHealth(await api.health()); } catch {} setPhase('setup'); }} />}
      <Toasts />
    </>
  );
}

function Center({ children }: { children: preact.ComponentChildren }) {
  return <div class="center-screen">{children}</div>;
}

function Offline({ onRetry }: { onRetry: () => void }) {
  useEffect(() => { const t = setInterval(onRetry, 4000); return () => clearInterval(t); }, []);
  return (
    <Center>
      <Skeleton mood="think" size="lg" />
      <h1 class="mono">can't reach pico</h1>
      <p class="muted">The Pico engine isn't running. Open a terminal and run <code>pico</code>, and this page will connect on its own.</p>
      <button class="btn ghost" onClick={onRetry}>Try again</button>
    </Center>
  );
}

function TokenScreen({ onSaved }: { onSaved: () => void }) {
  const [v, setV] = useState('');
  const [err, setErr] = useState('');
  const save = async (e: Event) => {
    e.preventDefault();
    if (!v.trim()) return;
    setToken(v);
    try { await api.config(); onSaved(); } catch { clearToken(); setErr("That key didn't work. Check it and try again."); }
  };
  return (
    <Center>
      <Skeleton mood="idle" size="lg" />
      <h1 class="mono">one quick thing</h1>
      <p class="muted">Paste your Pico key to unlock this page. You'll find it in the file <code>~/.pico/token</code> on the computer running Pico (or run <code>pico token</code>).</p>
      <form class="token-form" onSubmit={save}>
        <input class="input mono" type="password" placeholder="paste key" value={v} onInput={(e) => setV((e.target as HTMLInputElement).value)} autoFocus />
        <button class="btn primary" type="submit">Unlock</button>
      </form>
      {err && <p class="err">{err}</p>}
    </Center>
  );
}
