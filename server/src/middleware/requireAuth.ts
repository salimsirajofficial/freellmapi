import type { Request, Response, NextFunction } from 'express';
import { getUser } from '../services/auth-supabase.js';

// Gate the /api/* admin surface behind a Supabase Auth session (#35, item #2).
// The token is the Supabase access token issued by /api/auth/login|setup, sent
// as `Authorization: Bearer <token>`. The /v1 proxy is NOT gated by this — it
// keeps its own unified-API-key auth for app clients.
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    ?? (req.headers['x-dashboard-token'] as string | undefined);
  
  if (!token) {
    res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
    return;
  }

  const user = await getUser(token);
  if (!user) {
    res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
    return;
  }

  (req as Request & { user?: typeof user }).user = user;
  next();
}
