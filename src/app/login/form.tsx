'use client';

/**
 * Sign-in for tills and staff.
 *
 * A till signs in ONCE as its device account and stays signed in; cashiers
 * then switch by PIN without touching this screen. So this is a setup screen
 * that a cashier should rarely see — which is why it names the two failure
 * modes explicitly instead of just saying "invalid credentials".
 */

import { useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { browserClient, readClaims } from '@/lib/supabase/clients';

export function LoginForm() {
  const supabase = useMemo(() => browserClient(), []);
  const router = useRouter();
  const params = useSearchParams();
  const requested = params.get('next');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const { data, error: err } = await supabase.auth.signInWithPassword({
      email, password,
    });
    if (err) {
      setError(
        err.message.toLowerCase().includes('invalid')
          ? 'Email or password is not correct.'
          : err.message,
      );
      setBusy(false);
      return;
    }

    // Route by role. A till account belongs on /till; an owner or supervisor
    // signing in would otherwise land on a till they are not attached to and
    // see "Not a till account", which reads like a fault rather than a
    // wrong turn.
    const claims = data.session ? readClaims(data.session.access_token) : null;

    if (!claims) {
      setError(
        'Signed in, but this account has no business claims. Enable the ' +
        'Custom Access Token hook in Supabase, then sign in again.',
      );
      setBusy(false);
      return;
    }

    const home = claims.userRole === 'DEVICE' ? '/till' : '/admin';

    // Honour ?next=, but not when it points somewhere this role cannot use.
    const target =
      requested && !(claims.userRole !== 'DEVICE' && requested.startsWith('/till'))
        ? requested
        : home;

    // Full reload so the server components pick up the new session cookie.
    window.location.href = target;
  };

  return (
    <main className="boot">
      <div className="boot__card">
        <h1 className="boot__title">Sign in</h1>

        <label className="boot__label" htmlFor="email">Email</label>
        <input
          id="email" className="tender__input" type="email"
          autoComplete="username" autoCapitalize="none" spellCheck={false}
          style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--step-base)' }}
          value={email} onChange={(e) => setEmail(e.target.value.trim())}
          placeholder="Enter Email"
        />

        <label className="boot__label" htmlFor="password">Password</label>
        <div className="boot__password-field">
          <input
            id="password" className="tender__input" type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--step-base)' }}
            value={password} onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && email && password) void submit(); }}
            placeholder="Enter Password"
          />
          <button
            type="button" className="boot__password-toggle"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
          >
            {showPassword ? 'Hide' : 'Show'}
          </button>
        </div>

        {error && <p className="tender__error" role="alert">{error}</p>}

        <button
          className="till-btn till-btn--pay"
          style={{ width: '100%', marginTop: 16 }}
          disabled={!email || !password || busy}
          onClick={() => void submit()}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="tender__hint" style={{ marginTop: 18 }}>
          Till accounts go to the sale screen; owners go to
          the admin screens. A till signs in once and stays signed 
          in. Cashiers switch by PIN, not here.
        </p>
      </div>
    </main>
  );
}
