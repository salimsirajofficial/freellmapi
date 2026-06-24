import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getUserFallbackConfig, upsertFallbackConfig, getUserApiKeys, getAllModels, getUserRequests, setUserSetting } from '../db/supabase-queries.js';
import { getAllPenalties, getCustomWeights, getRoutingScores, getRoutingStrategy, setCustomWeights, setRoutingStrategy } from '../services/router.js';
import { BANDIT_PRESETS, type RoutingStrategy } from '../services/scoring.js';
import { parseBudget } from '../lib/budget.js';

export const fallbackRouter = Router();

fallbackRouter.get('/routing', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: { message: 'Authentication required' } });
    return;
  }
  res.json({ ...(await getRoutingScores(user.userId)), customWeights: await getCustomWeights(user.userId) });
});

const routingSchema = z.object({
  strategy: z.enum(['priority', 'balanced', 'smartest', 'fastest', 'reliable', 'custom']),
  weights: z.object({
    reliability: z.number().min(0).max(1),
    speed: z.number().min(0).max(1),
    intelligence: z.number().min(0).max(1),
  }).refine(w => w.reliability + w.speed + w.intelligence > 0, {
    message: 'weights must not all be zero',
  }).optional(),
});

fallbackRouter.put('/routing', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: { message: 'Authentication required' } });
    return;
  }

  const parsed = routingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  if (parsed.data.strategy === 'custom' && parsed.data.weights) {
    await setCustomWeights(user.userId, parsed.data.weights);
  }
  await setRoutingStrategy(user.userId, parsed.data.strategy as RoutingStrategy);

  res.json({
    strategy: await getRoutingStrategy(user.userId),
    presets: BANDIT_PRESETS,
    customWeights: await getCustomWeights(user.userId),
  });
});

fallbackRouter.get('/', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: { message: 'Authentication required' } });
    return;
  }

  try {
    const fallbackConfig = await getUserFallbackConfig(user.userId);
    const models = await getAllModels();
    const keys = await getUserApiKeys(user.userId);
    
    // Count enabled keys per platform
    const keyCountMap = new Map<string, number>();
    for (const key of keys) {
      if (key.enabled === 1) {
        keyCountMap.set(key.platform, (keyCountMap.get(key.platform) || 0) + 1);
      }
    }

    // Get current dynamic penalties
    const penalties = getAllPenalties();
    const penaltyMap = new Map(penalties.map(p => [p.modelDbId, p]));

    const modelMap = new Map(models.map(m => [m.id, m]));

    res.json(fallbackConfig.map(r => {
      const model = modelMap.get(r.model_id);
      const penalty = penaltyMap.get(r.model_id);
      return {
        modelDbId: r.model_id,
        priority: r.priority,
        effectivePriority: r.priority + (penalty?.penalty ?? 0),
        penalty: penalty?.penalty ?? 0,
        rateLimitHits: penalty?.count ?? 0,
        enabled: r.enabled === 1,
        platform: model?.platform,
        modelId: model?.model_id,
        displayName: model?.display_name,
        intelligenceRank: model?.intelligence_rank,
        speedRank: model?.speed_rank,
        sizeLabel: model?.size_label,
        rpmLimit: model?.rpm_limit,
        rpdLimit: model?.rpd_limit,
        monthlyTokenBudget: model?.monthly_token_budget,
        supportsVision: model?.supports_vision === 1,
        supportsTools: model?.supports_tools === 1,
        keyCount: keyCountMap.get(model?.platform || '') ?? 0,
      };
    }));
  } catch (error) {
    console.error('Error fetching fallback config:', error);
    res.status(500).json({ error: { message: 'Failed to fetch fallback config' } });
  }
});

const updateSchema = z.array(z.object({
  modelDbId: z.string(),
  priority: z.number(),
  enabled: z.boolean(),
}));

fallbackRouter.put('/', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: { message: 'Authentication required' } });
    return;
  }

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  try {
    for (const entry of parsed.data) {
      await upsertFallbackConfig({
        user_id: user.userId,
        model_id: entry.modelDbId,
        priority: entry.priority,
        enabled: entry.enabled ? 1 : 0,
      });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating fallback config:', error);
    res.status(500).json({ error: { message: 'Failed to update fallback config' } });
  }
});

const SORT_PRESETS: Record<string, (a: any, b: any) => number> = {
  intelligence: (a, b) => {
    const tierOrder: Record<string, number> = { 'Frontier': 1, 'Large': 2, 'Medium': 3, 'Small': 4 };
    const tierA = tierOrder[a.size_label] || 5;
    const tierB = tierOrder[b.size_label] || 5;
    if (tierA !== tierB) return tierA - tierB;
    return a.intelligence_rank - b.intelligence_rank;
  },
  speed: (a, b) => a.speed_rank - b.speed_rank,
  budget: (a, b) => {
    const budgetOrder: Record<string, number> = {
      '~120M': 1, '~50-100M': 2, '~30M': 3, '~18-45M': 4, '~18M': 5,
      '~15M': 6, '~12M': 7, '~6M': 8, '~5-10M': 9, '~4M': 10
    };
    const orderA = budgetOrder[a.monthly_token_budget] || 11;
    const orderB = budgetOrder[b.monthly_token_budget] || 11;
    return orderA - orderB;
  },
};

fallbackRouter.post('/sort/:preset', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: { message: 'Authentication required' } });
    return;
  }

  const preset = String(req.params.preset);
  const sortFn = SORT_PRESETS[preset];
  if (!sortFn) {
    res.status(400).json({ error: { message: `Unknown preset: ${preset}. Use: intelligence, speed, budget` } });
    return;
  }

  try {
    const models = await getAllModels();
    const sortedModels = [...models].sort(sortFn);
    
    for (let i = 0; i < sortedModels.length; i++) {
      await upsertFallbackConfig({
        user_id: user.userId,
        model_id: sortedModels[i].id,
        priority: i + 1,
        enabled: 1,
      });
    }
    
    res.json({ success: true, preset });
  } catch (error) {
    console.error('Error sorting fallback config:', error);
    res.status(500).json({ error: { message: 'Failed to sort fallback config' } });
  }
});

fallbackRouter.get('/token-usage', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: { message: 'Authentication required' } });
    return;
  }

  try {
    const keys = await getUserApiKeys(user.userId);
    const platformSet = new Set(keys.filter(k => k.enabled === 1).map(k => k.platform));

    const fallbackConfig = await getUserFallbackConfig(user.userId);
    const models = await getAllModels();
    const modelMap = new Map(models.map(m => [m.id, m]));

    const modelBudgets = fallbackConfig
      .filter(fc => {
        const model = modelMap.get(fc.model_id);
        return model && model.enabled === 1 && platformSet.has(model.platform);
      })
      .map(fc => {
        const model = modelMap.get(fc.model_id);
        return {
          displayName: model?.display_name,
          platform: model?.platform,
          budget: parseBudget(model?.monthly_token_budget || ''),
        };
      });

    const totalBudget = modelBudgets.reduce((s, m) => s + m.budget, 0);

    // Get usage this month
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const requests = await getUserRequests(user.userId, 100000);
    const monthRequests = requests.filter(r => new Date(r.created_at) >= startOfMonth);
    const totalUsed = monthRequests.reduce((sum, r) => sum + (r.input_tokens || 0) + (r.output_tokens || 0), 0);

    res.json({
      totalBudget,
      totalUsed,
      models: modelBudgets,
    });
  } catch (error) {
    console.error('Error fetching token usage:', error);
    res.status(500).json({ error: { message: 'Failed to fetch token usage' } });
  }
});
