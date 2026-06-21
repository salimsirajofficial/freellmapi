import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb, getUnifiedApiKey, regenerateUnifiedKey } from '../db/index.js';
import { backupDbToPostgres } from '../db/postgres-sync.js';

export const settingsRouter = Router();

// Get the unified API key
settingsRouter.get('/api-key', (_req: Request, res: Response) => {
  res.json({ apiKey: getUnifiedApiKey() });
});

// Regenerate the unified API key
settingsRouter.post('/api-key/regenerate', async (_req: Request, res: Response) => {
  const newKey = regenerateUnifiedKey();
  await backupDbToPostgres(getDb(), 'unified api key regenerate').catch((err: any) => {
    console.error('[postgres-sync] Immediate backup after unified API key regenerate failed:', err?.message || err);
  });
  res.json({ apiKey: newKey });
});
