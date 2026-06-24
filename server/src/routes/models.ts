import { Router } from 'express';
import type { Request, Response } from 'express';
import { getAllModels } from '../db/supabase-queries.js';
import { hasProvider } from '../providers/index.js';

export const modelsRouter = Router();

// List all models with availability info (public endpoint - no auth required)
modelsRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const models = await getAllModels();
    
    const result = models.map((m: any) => ({
      id: m.id,
      platform: m.platform,
      modelId: m.model_id,
      displayName: m.display_name,
      intelligenceRank: m.intelligence_rank,
      speedRank: m.speed_rank,
      sizeLabel: m.size_label,
      rpmLimit: m.rpm_limit,
      rpdLimit: m.rpd_limit,
      tpmLimit: m.tpm_limit,
      tpdLimit: m.tpd_limit,
      monthlyTokenBudget: m.monthly_token_budget,
      contextWindow: m.context_window,
      enabled: m.enabled === 1,
      supportsVision: m.supports_vision === 1,
      supportsTools: m.supports_tools === 1,
      priority: null, // User-specific fallback config
      fallbackEnabled: true, // Default enabled
      hasProvider: hasProvider(m.platform),
      keyCount: 0, // User-specific - will be computed per user
    }));

    res.json(result);
  } catch (error) {
    console.error('Error fetching models:', error);
    res.status(500).json({ error: { message: 'Failed to fetch models' } });
  }
});
