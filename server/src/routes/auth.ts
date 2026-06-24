import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  signUp,
  signIn,
  signOut,
  getUser,
  hasNonDesktopUser,
} from '../services/auth-supabase.js';

export const authRouter = Router();

// Dashboard auth (#35). These routes are mounted BEFORE requireAuth, so
// /status, /setup and /login are reachable without a session (bootstrap);
// /logout and /me validate the token themselves.

const credentialsSchema = z.object({
  email: z.string().email('A valid email is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

function bearer(req: Request): string | undefined {
  return req.headers.authorization?.replace(/^Bearer\s+/i, '')
    ?? (req.headers['x-dashboard-token'] as string | undefined);
}

// Has the dashboard been set up yet, and is this caller authenticated?
authRouter.get('/status', async (req: Request, res: Response) => {
  const token = bearer(req);
  const user = token ? await getUser(token) : null;
  const needsSetup = !(await hasNonDesktopUser());
  res.json({
    needsSetup,
    authenticated: !!user,
    email: user?.email ?? null,
  });
});

// First-run account creation. Only allowed while there are zero users, so it
// can't be used to add accounts once the dashboard is claimed.
authRouter.post('/setup', async (req: Request, res: Response) => {
  if (await hasNonDesktopUser()) {
    res.status(409).json({ error: { message: 'Setup already completed. Use login instead.', type: 'setup_complete' } });
    return;
  }
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  try {
    const result = await signUp(parsed.data.email, parsed.data.password);
    console.log(`[auth] Signup succeeded for ${result.user.email} (userId=${result.user.userId})`);
    res.status(201).json({ token: result.session, email: result.user.email });
  } catch (err: any) {
    console.error(`[auth] Signup failed for ${parsed.data.email}:`, err.message || err);
    res.status(400).json({ error: { message: err.message || 'Signup failed' } });
  }
});

authRouter.post('/login', async (req: Request, res: Response) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const { email, password } = parsed.data;

  try {
    const result = await signIn(email, password);
    console.log(`[auth] Login succeeded for ${result.user.email}`);
    res.json({ token: result.session, email: result.user.email });
  } catch (err: any) {
    console.warn(`[auth] Login failed for ${email}:`, err.message || err);
    res.status(401).json({
      error: { message: err?.message || 'Invalid email or password', type: 'authentication_error' },
    });
  }
});

authRouter.post('/logout', async (req: Request, res: Response) => {
  const token = bearer(req);
  if (token) {
    try {
      await signOut(token);
    } catch (err) {
      // Ignore logout errors
    }
  }
  res.json({ success: true });
});

authRouter.get('/me', async (req: Request, res: Response) => {
  const token = bearer(req);
  if (!token) {
    res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
    return;
  }
  const user = await getUser(token);
  if (!user) {
    res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
    return;
  }
  res.json({ email: user.email });
});
