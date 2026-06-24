import { Router } from 'express';
import type { Request, Response } from 'express';
import { getUserApiKeys, updateApiKey } from '../db/supabase-queries.js';
import { checkKeyHealth, checkAllKeys } from '../services/health.js';
import { hasProvider } from '../providers/index.js';
import type { Platform } from '@freellmapi/shared/types.js';

export const healthRouter = Router();

// Get health status for all platforms (user-specific)
healthRouter.get('/', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: { message: 'Authentication required' } });
    return;
  }

  try {
    const keys = await getUserApiKeys(user.userId);
    
    // Group by platform and calculate stats
    const platformStats = new Map<string, {
      total_keys: number;
      healthy_keys: number;
      rate_limited_keys: number;
      invalid_keys: number;
      error_keys: number;
      unknown_keys: number;
      enabled_keys: number;
    }>();

    for (const key of keys) {
      const stats = platformStats.get(key.platform) || {
        total_keys: 0,
        healthy_keys: 0,
        rate_limited_keys: 0,
        invalid_keys: 0,
        error_keys: 0,
        unknown_keys: 0,
        enabled_keys: 0,
      };
      
      stats.total_keys++;
      if (key.status === 'healthy') stats.healthy_keys++;
      else if (key.status === 'rate_limited') stats.rate_limited_keys++;
      else if (key.status === 'invalid') stats.invalid_keys++;
      else if (key.status === 'error') stats.error_keys++;
      else stats.unknown_keys++;
      
      if (key.enabled === 1) stats.enabled_keys++;
      
      platformStats.set(key.platform, stats);
    }

    const platforms = Array.from(platformStats.entries()).map(([platform, stats]) => ({
      platform,
      hasProvider: hasProvider(platform as Platform),
      totalKeys: stats.total_keys,
      healthyKeys: stats.healthy_keys,
      rateLimitedKeys: stats.rate_limited_keys,
      invalidKeys: stats.invalid_keys,
      errorKeys: stats.error_keys,
      unknownKeys: stats.unknown_keys,
      enabledKeys: stats.enabled_keys,
    }));

    const keysFormatted = keys.map(k => ({
      id: k.id,
      platform: k.platform,
      label: k.label,
      status: k.status,
      enabled: k.enabled === 1,
      createdAt: k.created_at,
      lastCheckedAt: k.last_checked_at,
    }));

    res.json({ platforms, keys: keysFormatted });
  } catch (error) {
    console.error('Error fetching health status:', error);
    res.status(500).json({ error: { message: 'Failed to fetch health status' } });
  }
});

// Check a specific key
healthRouter.post('/check/:keyId', async (req: Request, res: Response) => {
  const keyId = String(req.params.keyId);
  if (!keyId) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const status = await checkKeyHealth(keyId);
  res.json({ keyId, status });
});

// Check all keys
healthRouter.post('/check-all', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: { message: 'Authentication required' } });
    return;
  }
  await checkAllKeys(user.userId);
  res.json({ success: true });
});
