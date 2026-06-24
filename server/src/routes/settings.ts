import { Router } from 'express';
import type { Request, Response } from 'express';
import { getUserSetting, setUserSetting } from '../db/supabase-queries.js';
import crypto from 'crypto';

export const settingsRouter = Router();

// Generate a unified API key
function generateUnifiedKey(): string {
  return 'freellmapi-' + crypto.randomBytes(32).toString('hex');
}

// Get the unified API key for the current user
settingsRouter.get('/api-key', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: { message: 'Authentication required' } });
    return;
  }

  try {
    let apiKey = await getUserSetting(user.userId, 'unified_api_key');
    if (!apiKey) {
      apiKey = generateUnifiedKey();
      await setUserSetting(user.userId, 'unified_api_key', apiKey);
    }
    res.json({ apiKey });
  } catch (error) {
    console.error('Error fetching unified API key:', error);
    res.status(500).json({ error: { message: 'Failed to fetch API key' } });
  }
});

// Regenerate the unified API key for the current user
settingsRouter.post('/api-key/regenerate', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: { message: 'Authentication required' } });
    return;
  }

  try {
    const newKey = generateUnifiedKey();
    await setUserSetting(user.userId, 'unified_api_key', newKey);
    res.json({ apiKey: newKey });
  } catch (error) {
    console.error('Error regenerating unified API key:', error);
    res.status(500).json({ error: { message: 'Failed to regenerate API key' } });
  }
});
