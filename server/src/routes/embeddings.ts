import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getUserApiKeys, getUserRequests, setUserSetting, updateEmbeddingModel } from '../db/supabase-queries.js';
import { listEmbeddingModels, getDefaultFamily, type EmbeddingModelRow } from '../services/embeddings.js';

export const embeddingsRouter = Router();

embeddingsRouter.get('/', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: { message: 'Authentication required' } });
    return;
  }

  try {
    const keys = await getUserApiKeys(user.userId);
    const keyCounts = new Map<string, number>();
    for (const key of keys) {
      if (key.enabled === 1 && (key.status === 'healthy' || key.status === 'unknown')) {
        keyCounts.set(key.platform, (keyCounts.get(key.platform) || 0) + 1);
      }
    }

    const byFamily = new Map<string, EmbeddingModelRow[]>();
    for (const row of await listEmbeddingModels()) {
      const list = byFamily.get(row.family) ?? [];
      list.push(row);
      byFamily.set(row.family, list);
    }

    const defaultFamily = await getDefaultFamily(user.userId);
    res.json({
      defaultFamily,
      families: [...byFamily.entries()].map(([family, rows]) => ({
        family,
        dimensions: rows[0].dimensions,
        maxInputTokens: rows[0].max_input_tokens,
        isDefault: family === defaultFamily,
        providers: rows.map(r => ({
          id: r.id,
          platform: r.platform,
          modelId: r.model_id,
          displayName: r.display_name,
          priority: r.priority,
          enabled: r.enabled === 1,
          quotaLabel: r.quota_label,
          keyCount: keyCounts.get(r.platform) ?? 0,
        })),
      })),
    });
  } catch (error) {
    console.error('Error fetching embeddings:', error);
    res.status(500).json({ error: { message: 'Failed to fetch embeddings' } });
  }
});

const updateSchema = z.object({
  defaultFamily: z.string().optional(),
  providers: z.array(z.object({
    id: z.string(),
    priority: z.number(),
    enabled: z.boolean(),
  })).optional(),
});

embeddingsRouter.put('/', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: { message: 'Authentication required' } });
    return;
  }

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request body' } });
    return;
  }

  try {
    if (parsed.data.defaultFamily) {
      const families = new Set((await listEmbeddingModels()).map(r => r.family));
      if (!families.has(parsed.data.defaultFamily)) {
        res.status(400).json({ error: { message: `Unknown family '${parsed.data.defaultFamily}'` } });
        return;
      }
      await setUserSetting(user.userId, 'embeddings_default_family', parsed.data.defaultFamily);
    }

    if (parsed.data.providers) {
      for (const p of parsed.data.providers) {
        await updateEmbeddingModel(p.id, { priority: p.priority, enabled: p.enabled ? 1 : 0 });
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating embeddings settings:', error);
    res.status(500).json({ error: { message: 'Failed to update embeddings settings' } });
  }
});

embeddingsRouter.get('/usage', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: { message: 'Authentication required' } });
    return;
  }

  try {
    const requests = await getUserRequests(user.userId, 100000);
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const embeddingModels = await listEmbeddingModels();
    const byFamily = new Map<string, { requests_today: number; tokens_month: number }>();

    for (const model of embeddingModels) {
      byFamily.set(model.family, { requests_today: 0, tokens_month: 0 });
    }

    for (const r of requests) {
      const requestDate = new Date(r.created_at);
      const model = embeddingModels.find(m => m.platform === r.platform && m.model_id === r.model_id);
      if (model && r.status === 'success') {
        const stats = byFamily.get(model.family);
        if (stats) {
          if (requestDate >= startOfDay) stats.requests_today++;
          if (requestDate >= startOfMonth) stats.tokens_month += r.input_tokens || 0;
        }
      }
    }

    res.json({
      families: Array.from(byFamily.entries()).map(([family, stats]) => ({
        family,
        requestsToday: stats.requests_today,
        tokensMonth: stats.tokens_month,
      })),
    });
  } catch (error) {
    console.error('Error fetching embeddings usage:', error);
    res.status(500).json({ error: { message: 'Failed to fetch embeddings usage' } });
  }
});
