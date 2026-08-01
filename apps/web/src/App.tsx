import { useEffect, useState } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';
import { DashboardPage } from './pages/Dashboard';
import { ProjectPage } from './pages/Project';
import { LocalDashboard } from './pages/LocalDashboard';
import { LocalProjectPage } from './pages/LocalProject';
import { serverMode } from './lib/localApi';

function SignIn() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="card mx-auto max-w-sm space-y-4 p-6">
      <div>
        <h1 className="text-2xl font-medium">ReelLipi</h1>
        <p className="text-sm text-ink/55">
          Tanglish and Hinglish captions, burned into your Reels.
        </p>
      </div>

      {sent ? (
        <p className="text-sm text-semantic-success">Check your inbox for the sign-in link.</p>
      ) : (
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            const { error: err } = await supabase.auth.signInWithOtp({
              email,
              options: { emailRedirectTo: window.location.origin },
            });
            if (err) setError(err.message);
            else setSent(true);
          }}
        >
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="w-full rounded-[--radius-sm] border border-hairline px-3 py-2 text-sm outline-none focus:border-ink"
          />
          <button type="submit" className="btn-primary w-full">
            Email me a link
          </button>
        </form>
      )}

      <button
        type="button"
        onClick={() =>
          void supabase.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: window.location.origin },
          })
        }
        className="btn-secondary w-full"
      >
        Continue with Google
      </button>

      {error && <p className="text-sm text-accent-magenta">{error}</p>}
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [mode, setMode] = useState<'local' | 'cloud' | null>(null);

  // The worker decides the mode: no Supabase configured there means local, single-user.
  useEffect(() => {
    void serverMode().then(setMode);
  }, []);

  useEffect(() => {
    if (mode !== 'cloud') return;
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, [mode]);

  if (mode === null) {
    return <div className="grid min-h-screen place-items-center text-neutral-500">…</div>;
  }

  const isLocal = mode === 'local';

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-hairline bg-canvas/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between px-6 py-4">
          <Link to="/" className="flex items-center gap-2 text-lg font-medium tracking-tight">
            ReelLipi
            {isLocal && (
              <span className="rounded-[--radius-pill] bg-block-lime px-2 py-0.5 text-[10px] font-medium">
                local
              </span>
            )}
          </Link>
          {!isLocal && session && (
            <div className="flex items-center gap-3 text-sm text-ink/60">
              <span className="hidden sm:inline">{session.user.email}</span>
              <button
                type="button"
                onClick={() => void supabase.auth.signOut()}
                className="btn-secondary"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-6 py-10">
        {isLocal ? (
          <Routes>
            <Route path="/" element={<LocalDashboard />} />
            <Route path="/project/:id" element={<LocalProjectPage />} />
          </Routes>
        ) : session ? (
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/project/:id" element={<ProjectPage />} />
          </Routes>
        ) : (
          <SignIn />
        )}
      </main>
    </div>
  );
}
