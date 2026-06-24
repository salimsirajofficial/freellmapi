import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  userCount,
  hasNonDesktopUser,
  createUser,
  verifyCredentials,
  createSession,
  validateSession,
  deleteSession,
} from '../services/auth.js';
import { getDb } from '../db/index.js';
import { backupDbToPostgres } from '../db/postgres-sync.js';

export const authRouter = Router();

// Dashboard auth (#35). These routes are mounted BEFORE requireAuth, so
// /status, /setup and /login are reachable without a session (bootstrap);
// /logout and /me validate the token themselves.

const credentialsSchema = z.object({
  email: z.string().email('A valid email is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

// ── Brute-force throttle ──────────────────────────────────────────────────
// Simple in-memory per-email limiter. A local single-user tool doesn't need a
// distributed store; this just blunts online password guessing.
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; lockedUntil: number }>();

function isLockedOut(email: string): boolean {
  const a = attempts.get(email.toLowerCase());
  return !!a && a.lockedUntil > Date.now();
}
function recordFailure(email: string): void {
  const key = email.toLowerCase();
  const a = attempts.get(key) ?? { count: 0, lockedUntil: 0 };
  a.count++;
  if (a.count >= MAX_ATTEMPTS) {
    a.lockedUntil = Date.now() + LOCKOUT_MS;
    a.count = 0;
  }
  attempts.set(key, a);
}
function clearFailures(email: string): void {
  attempts.delete(email.toLowerCase());
}

function bearer(req: Request): string | undefined {
  return req.headers.authorization?.replace(/^Bearer\s+/i, '')
    ?? (req.headers['x-dashboard-token'] as string | undefined);
}

// Has the dashboard been set up yet, and is this caller authenticated?
authRouter.get('/status', (req: Request, res: Response) => {
  const session = validateSession(bearer(req));
  res.json({
    needsSetup: !hasNonDesktopUser(),
    authenticated: !!session,
    email: session?.email ?? null,
  });
});

// First-run account creation. Only allowed while there are zero users, so it
// can't be used to add accounts once the dashboard is claimed.
authRouter.post('/setup', async (req: Request, res: Response) => {
  console.log('[AUTH-ROUTE] /setup called');
  if (hasNonDesktopUser()) {
    console.log('[AUTH-ROUTE] /setup rejected: setup already completed');
    res.status(409).json({ error: { message: 'Setup already completed. Use login instead.', type: 'setup_complete' } });
    return;
  }
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    console.log('[AUTH-ROUTE] /setup validation failed:', parsed.error.errors.map(e => e.message).join(', '));
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  console.log('[AUTH-ROUTE] /setup creating user with email:', parsed.data.email);
  const user = createUser(parsed.data.email, parsed.data.password);
  clearFailures(user.email);
  const token = createSession(user.userId);
  await backupDbToPostgres(getDb(), 'auth setup').catch((err: any) => {
    console.error('[postgres-sync] Immediate backup after auth setup failed:', err?.message || err);
  });
  console.log('[AUTH-ROUTE] /setup successful for email:', user.email);
  res.status(201).json({ token, email: user.email });
});

authRouter.post('/login', (req: Request, res: Response) => {
  console.log('[AUTH-ROUTE] /login called');
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    console.log('[AUTH-ROUTE] /login validation failed:', parsed.error.errors.map(e => e.message).join(', '));
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const { email, password } = parsed.data;
  console.log('[AUTH-ROUTE] /login attempting with email:', email);

  if (isLockedOut(email)) {
    console.log('[AUTH-ROUTE] /login rejected: rate limit exceeded for email:', email);
    res.status(429).json({ error: { message: 'Too many failed attempts. Try again later.', type: 'rate_limit_error' } });
    return;
  }

  const user = verifyCredentials(email, password);
  if (!user) {
    console.log('[AUTH-ROUTE] /login failed: invalid credentials for email:', email);
    recordFailure(email);
    // Same message whether the email exists or not — don't leak which.
    res.status(401).json({ error: { message: 'Invalid email or password', type: 'authentication_error' } });
    return;
  }

  clearFailures(email);
  const token = createSession(user.userId);
  console.log('[AUTH-ROUTE] /login successful for email:', user.email);
  res.json({ token, email: user.email });
});

authRouter.post('/logout', (req: Request, res: Response) => {
  deleteSession(bearer(req));
  res.json({ success: true });
});

authRouter.get('/me', (req: Request, res: Response) => {
  const session = validateSession(bearer(req));
  if (!session) {
    res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
    return;
  }
  res.json({ email: session.email });
});
