import { useEffect, useState, useRef, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch, setToken, UNAUTHORIZED_EVENT } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface AuthStatus {
  needsSetup: boolean
  authenticated: boolean
  email: string | null
}

// ── Ambient background orbs ──────────────────────────────────────────────────
function AuthBackground() {
  return (
    <div className="auth-bg" aria-hidden="true">
      <div className="auth-orb auth-orb-1" />
      <div className="auth-orb auth-orb-2" />
      <div className="auth-orb auth-orb-3" />
      <div className="auth-grid" />
    </div>
  )
}

// ── Inline styles (no external dep needed) ───────────────────────────────────
const authStyles = `
  .auth-bg {
    position: fixed; inset: 0; z-index: 0; overflow: hidden;
    background: var(--auth-bg, oklch(0.985 0 0));
  }
  .dark .auth-bg {
    --auth-bg: oklch(0.11 0 0);
  }
  .auth-orb {
    position: absolute; border-radius: 9999px;
    filter: blur(80px); opacity: 0.35;
    animation: auth-drift 12s ease-in-out infinite alternate;
  }
  .dark .auth-orb { opacity: 0.18; }
  .auth-orb-1 {
    width: 520px; height: 520px;
    top: -160px; left: -120px;
    background: radial-gradient(circle, oklch(0.72 0.14 260), oklch(0.62 0.18 290));
    animation-delay: 0s;
  }
  .auth-orb-2 {
    width: 400px; height: 400px;
    bottom: -100px; right: -80px;
    background: radial-gradient(circle, oklch(0.75 0.12 200), oklch(0.65 0.16 230));
    animation-delay: -4s;
  }
  .auth-orb-3 {
    width: 300px; height: 300px;
    top: 50%; left: 55%;
    background: radial-gradient(circle, oklch(0.78 0.10 150), oklch(0.68 0.13 170));
    animation-delay: -8s;
  }
  @keyframes auth-drift {
    from { transform: translate(0, 0) scale(1); }
    to   { transform: translate(30px, 20px) scale(1.06); }
  }
  .auth-grid {
    position: absolute; inset: 0;
    background-image:
      linear-gradient(oklch(0.5 0 0 / 0.04) 1px, transparent 1px),
      linear-gradient(90deg, oklch(0.5 0 0 / 0.04) 1px, transparent 1px);
    background-size: 48px 48px;
  }
  .auth-card {
    position: relative; z-index: 1;
    background: oklch(1 0 0 / 0.82);
    border: 1px solid oklch(0.92 0 0);
    backdrop-filter: blur(24px) saturate(160%);
    -webkit-backdrop-filter: blur(24px) saturate(160%);
    border-radius: 20px;
    box-shadow:
      0 0 0 1px oklch(1 0 0 / 0.6) inset,
      0 4px 6px -1px oklch(0 0 0 / 0.06),
      0 20px 60px -10px oklch(0 0 0 / 0.12);
    overflow: hidden;
  }
  .dark .auth-card {
    background: oklch(0.17 0 0 / 0.88);
    border-color: oklch(1 0 0 / 0.08);
    box-shadow:
      0 0 0 1px oklch(1 0 0 / 0.06) inset,
      0 4px 6px -1px oklch(0 0 0 / 0.4),
      0 20px 60px -10px oklch(0 0 0 / 0.5);
  }

  /* Tab strip */
  .auth-tabs {
    display: flex;
    border-bottom: 1px solid oklch(0.92 0 0);
    position: relative;
  }
  .dark .auth-tabs { border-color: oklch(1 0 0 / 0.08); }
  .auth-tab {
    flex: 1; padding: 13px 0; font-size: 0.8125rem; font-weight: 500;
    text-align: center; cursor: pointer; border: none; background: none;
    color: oklch(0.52 0 0);
    transition: color 0.2s;
    letter-spacing: -0.01em;
  }
  .dark .auth-tab { color: oklch(0.56 0 0); }
  .auth-tab.active { color: oklch(0.18 0 0); }
  .dark .auth-tab.active { color: oklch(0.96 0 0); }
  .auth-tab-indicator {
    position: absolute; bottom: 0; height: 2px;
    background: oklch(0.22 0 0);
    border-radius: 2px 2px 0 0;
    transition: left 0.28s cubic-bezier(0.4,0,0.2,1), width 0.28s cubic-bezier(0.4,0,0.2,1);
  }
  .dark .auth-tab-indicator { background: oklch(0.93 0 0); }

  /* Sliding panel */
  .auth-panels {
    display: flex; width: 200%; transition: transform 0.32s cubic-bezier(0.4,0,0.2,1);
  }
  .auth-panels.show-login { transform: translateX(-50%); }
  .auth-panel { width: 50%; padding: 24px; box-sizing: border-box; }

  /* Divider */
  .auth-divider {
    display: flex; align-items: center; gap: 10px;
    margin: 16px 0; color: oklch(0.68 0 0); font-size: 0.72rem;
  }
  .auth-divider::before, .auth-divider::after {
    content: ''; flex: 1; height: 1px; background: oklch(0.92 0 0);
  }
  .dark .auth-divider::before, .dark .auth-divider::after {
    background: oklch(1 0 0 / 0.08);
  }

  /* Switch link */
  .auth-switch {
    text-align: center; margin-top: 18px;
    font-size: 0.75rem; color: oklch(0.55 0 0);
  }
  .dark .auth-switch { color: oklch(0.6 0 0); }
  .auth-switch button {
    background: none; border: none; cursor: pointer; padding: 0;
    font-size: inherit; font-weight: 600;
    color: oklch(0.22 0 0);
    text-decoration: underline; text-underline-offset: 3px;
    transition: opacity 0.15s;
  }
  .dark .auth-switch button { color: oklch(0.93 0 0); }
  .auth-switch button:hover { opacity: 0.7; }

  /* Brand dot pulse */
  @keyframes auth-pulse {
    0%, 100% { box-shadow: 0 0 0 0 oklch(0.55 0.14 260 / 0.5); }
    50% { box-shadow: 0 0 0 5px oklch(0.55 0.14 260 / 0); }
  }
  .auth-brand-dot {
    display: inline-block; width: 7px; height: 7px;
    border-radius: 9999px; background: oklch(0.22 0 0);
    animation: auth-pulse 2.5s ease-in-out infinite;
    flex-shrink: 0;
  }
  .dark .auth-brand-dot { background: oklch(0.93 0 0); }
`

// ── Per-panel form ────────────────────────────────────────────────────────────
function PanelForm({
  mode,
  onAuthed,
}: {
  mode: 'setup' | 'login'
  onAuthed: () => void
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const isSetup = mode === 'setup'

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const res = await apiFetch<{ token: string }>(
        isSetup ? '/api/auth/setup' : '/api/auth/login',
        { method: 'POST', body: JSON.stringify({ email, password }) },
      )
      setToken(res.token)
      onAuthed()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <div className="space-y-1.5">
        <Label className="text-xs" htmlFor={`auth-email-${mode}`}>
          Email address
        </Label>
        <Input
          id={`auth-email-${mode}`}
          type="email"
          autoComplete="username"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="you@example.com"
          style={{ fontSize: '0.8125rem' }}
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs" htmlFor={`auth-password-${mode}`}>
          Password
        </Label>
        <Input
          id={`auth-password-${mode}`}
          type="password"
          autoComplete={isSetup ? 'new-password' : 'current-password'}
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder={isSetup ? 'at least 8 characters' : 'your password'}
          style={{ fontSize: '0.8125rem' }}
        />
      </div>

      {error && (
        <p
          role="alert"
          style={{
            fontSize: '0.73rem',
            color: 'oklch(0.577 0.245 27.325)',
            background: 'oklch(0.577 0.245 27.325 / 0.08)',
            border: '1px solid oklch(0.577 0.245 27.325 / 0.2)',
            borderRadius: 8,
            padding: '6px 10px',
          }}
        >
          {error}
        </p>
      )}

      <Button
        type="submit"
        className="w-full"
        disabled={busy || !email || !password}
        style={{ marginTop: 4 }}
      >
        {busy
          ? isSetup ? 'Creating account…' : 'Signing in…'
          : isSetup ? 'Create account' : 'Sign in'}
      </Button>
    </form>
  )
}

// ── Main auth card ────────────────────────────────────────────────────────────
function AuthPage({
  needsSetup,
  onAuthed,
}: {
  needsSetup: boolean
  onAuthed: () => void
}) {
  // When an account already exists, default to login. First-run → signup.
  const [tab, setTab] = useState<'signup' | 'login'>(needsSetup ? 'signup' : 'login')
  const tabBarRef = useRef<HTMLDivElement>(null)
  const [indicator, setIndicator] = useState({ left: '0%', width: '50%' })

  useEffect(() => {
    setIndicator({
      left: tab === 'signup' ? '0%' : '50%',
      width: '50%',
    })
  }, [tab])

  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px 16px',
        position: 'relative',
      }}
    >
      <style>{authStyles}</style>
      <AuthBackground />

      <div style={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: 380 }}>
        {/* Brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
          <span className="auth-brand-dot" />
          <span style={{ fontWeight: 600, fontSize: '0.875rem', letterSpacing: '-0.02em' }}>
            FreeLLMAPI
          </span>
        </div>

        <div className="auth-card">
          {/* Tab strip */}
          <div className="auth-tabs" ref={tabBarRef}>
            <button
              id="auth-tab-signup"
              type="button"
              className={`auth-tab${tab === 'signup' ? ' active' : ''}`}
              onClick={() => setTab('signup')}
              aria-selected={tab === 'signup'}
            >
              Create account
            </button>
            <button
              id="auth-tab-login"
              type="button"
              className={`auth-tab${tab === 'login' ? ' active' : ''}`}
              onClick={() => setTab('login')}
              aria-selected={tab === 'login'}
            >
              Sign in
            </button>
            <div
              className="auth-tab-indicator"
              style={{ left: indicator.left, width: indicator.width }}
            />
          </div>

          {/* Sliding panels */}
          <div className={`auth-panels${tab === 'login' ? ' show-login' : ''}`}>
            {/* — Sign Up panel — */}
            <div className="auth-panel">
              <p style={{ fontSize: '0.75rem', color: 'oklch(0.55 0 0)', marginBottom: 16 }}>
                {needsSetup
                  ? 'Set the email and password that will protect this dashboard.'
                  : 'Account creation is disabled — this dashboard already has an owner.'}
              </p>

              <PanelForm mode="setup" onAuthed={onAuthed} />

              <p className="auth-switch">
                Already have an account?{' '}
                <button type="button" onClick={() => setTab('login')}>
                  Sign in
                </button>
              </p>
            </div>

            {/* — Login panel — */}
            <div className="auth-panel">
              <p style={{ fontSize: '0.75rem', color: 'oklch(0.55 0 0)', marginBottom: 16 }}>
                Welcome back. Sign in to manage your keys, routing, and analytics.
              </p>

              <PanelForm mode="login" onAuthed={onAuthed} />

              {needsSetup && (
                <p className="auth-switch">
                  No account yet?{' '}
                  <button type="button" onClick={() => setTab('signup')}>
                    Create one
                  </button>
                </p>
              )}
            </div>
          </div>
        </div>

        <p
          style={{
            textAlign: 'center',
            marginTop: 20,
            fontSize: '0.7rem',
            color: 'oklch(0.65 0 0)',
          }}
        >
          Your data stays local — no cloud, no telemetry.
        </p>
      </div>
    </div>
  )
}

// ── Gate ──────────────────────────────────────────────────────────────────────
function Centered({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div style={{ maxWidth: 380, width: '100%' }}>{children}</div>
    </div>
  )
}

export function AuthGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const { data, isLoading, isError, refetch } = useQuery<AuthStatus>({
    queryKey: ['auth-status'],
    queryFn: () => apiFetch('/api/auth/status'),
    retry: false,
  })

  useEffect(() => {
    const handler = () => {
      // Invalidate the cache first so stale authenticated:true data is cleared
      // immediately — otherwise React Query may return cached data while the
      // refetch is in-flight, keeping the dashboard visible after logout.
      queryClient.invalidateQueries({ queryKey: ['auth-status'] })
      refetch()
    }
    window.addEventListener(UNAUTHORIZED_EVENT, handler)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handler)
  }, [refetch, queryClient])

  function onAuthed() {
    // New session: drop any cached (unauthenticated) data and re-check status.
    queryClient.invalidateQueries()
    refetch()
  }

  if (isLoading) {
    return (
      <Centered>
        <p style={{ textAlign: 'center', fontSize: '0.875rem', color: 'oklch(0.55 0 0)' }}>
          Loading…
        </p>
      </Centered>
    )
  }

  if (isError || !data) {
    return (
      <Centered>
        <div
          style={{
            borderRadius: 10,
            border: '1px solid oklch(0.577 0.245 27.325 / 0.3)',
            background: 'oklch(0.577 0.245 27.325 / 0.07)',
            padding: '10px 14px',
            fontSize: '0.8rem',
            color: 'oklch(0.577 0.245 27.325)',
          }}
        >
          Can't reach the server. Make sure the backend is running (
          <code style={{ fontFamily: 'monospace' }}>npm run dev</code>).
        </div>
      </Centered>
    )
  }

  if (!data.authenticated) {
    return <AuthPage needsSetup={data.needsSetup} onAuthed={onAuthed} />
  }

  return <>{children}</>
}
