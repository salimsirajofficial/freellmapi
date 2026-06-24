import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getUserApiKeys, insertApiKey, updateApiKey, deleteApiKey, insertModel, getUserFallbackConfig, upsertFallbackConfig, deleteFallbackConfig, getApiKeyById, enrollPlatformModelsInFallback } from '../db/supabase-queries.js';
import { resolveProvider } from '../providers/index.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';

export const keysRouter = Router();

const PLATFORMS = [
  'google', 'groq', 'cerebras', 'sambanova', 'nvidia', 'mistral',
  'openrouter', 'github', 'cohere', 'cloudflare', 'zhipu', 'ollama',
  'kilo', 'pollinations', 'llm7', 'huggingface', 'opencode', 'custom',
] as const;

const addKeySchema = z.object({
  platform: z.enum(PLATFORMS),
  key: z.string().optional(),
  label: z.string().optional(),
});

const updateKeySchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().optional(),
}).refine(data => data.enabled !== undefined || data.label !== undefined, {
  message: 'At least one of enabled or label must be provided',
});

keysRouter.get('/', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: { message: 'Authentication required' } });
    return;
  }

  try {
    const keys = await getUserApiKeys(user.userId);
    const keysFormatted = keys.map(row => {
      let maskedKey = '****';
      try {
        const realKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
        maskedKey = maskKey(realKey);
      } catch {
        maskedKey = '[decrypt failed]';
      }
      return {
        id: row.id,
        platform: row.platform,
        label: row.label,
        maskedKey,
        baseUrl: row.base_url ?? null,
        status: row.status,
        enabled: row.enabled === 1,
        createdAt: row.created_at,
        lastCheckedAt: row.last_checked_at,
      };
    });

    res.json(keysFormatted);
  } catch (error) {
    console.error('Error fetching keys:', error);
    res.status(500).json({ error: { message: 'Failed to fetch keys' } });
  }
});

keysRouter.post('/', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: { message: 'Authentication required' } });
    return;
  }

  const parsed = addKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { platform, label } = parsed.data;
  const isKeyless = resolveProvider(platform)?.keyless === true;
  const rawKey = parsed.data.key?.trim() ?? '';

  if (!isKeyless && !rawKey) {
    res.status(400).json({ error: { message: 'key is required' } });
    return;
  }

  const keyToStore = isKeyless ? (rawKey || 'no-key') : rawKey;

  try {
    if (isKeyless) {
      const existingKeys = await getUserApiKeys(user.userId);
      const existing = existingKeys.find(k => k.platform === platform);
      if (existing) {
        await updateApiKey(existing.id, { enabled: 1, status: 'unknown' });
        await enrollPlatformModelsInFallback(user.userId, platform);
        res.status(200).json({
          id: existing.id,
          platform,
          label: label ?? '',
          maskedKey: maskKey(keyToStore),
          status: 'unknown',
          enabled: true,
        });
        return;
      }
    }

    const { encrypted, iv, authTag } = encrypt(keyToStore);
    const newKey = await insertApiKey({
      user_id: user.userId,
      platform,
      label: label ?? '',
      encrypted_key: encrypted,
      iv,
      auth_tag: authTag,
      status: 'unknown',
      enabled: 1,
    });

    await enrollPlatformModelsInFallback(user.userId, platform);

    res.status(201).json({
      id: newKey.id,
      platform,
      label: label ?? '',
      maskedKey: maskKey(keyToStore),
      status: 'unknown',
      enabled: true,
    });
  } catch (error) {
    console.error('Error adding key:', error);
    res.status(500).json({ error: { message: 'Failed to add key' } });
  }
});

const customProviderSchema = z.object({
  baseUrl: z.string().url('baseUrl must be a valid URL'),
  model: z.string().min(1, 'model is required'),
  displayName: z.string().optional(),
  apiKey: z.string().optional(),
  label: z.string().optional(),
});

keysRouter.post('/custom', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: { message: 'Authentication required' } });
    return;
  }

  const parsed = customProviderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const baseUrl = parsed.data.baseUrl.trim().replace(/\/+$/, '');
  const modelId = parsed.data.model.trim();
  const displayName = (parsed.data.displayName ?? modelId).trim();
  const rawKey = parsed.data.apiKey?.trim() || 'no-key';
  const label = parsed.data.label ?? 'Custom';

  try {
    const existingKeys = await getUserApiKeys(user.userId);
    const existing = existingKeys.find(k => k.platform === 'custom' && k.base_url === baseUrl);
    
    let keyId: string;
    if (existing) {
      const { encrypted, iv, authTag } = encrypt(rawKey);
      await updateApiKey(existing.id, { label, encrypted_key: encrypted, iv, auth_tag: authTag, status: 'unknown', enabled: 1 });
      keyId = existing.id;
    } else {
      const { encrypted, iv, authTag } = encrypt(rawKey);
      const newKey = await insertApiKey({
        user_id: user.userId,
        platform: 'custom',
        label,
        encrypted_key: encrypted,
        iv,
        auth_tag: authTag,
        status: 'unknown',
        enabled: 1,
        base_url: baseUrl,
      });
      keyId = newKey.id;
    }

    const newModel = await insertModel({
      platform: 'custom',
      model_id: modelId,
      display_name: displayName,
      intelligence_rank: 50,
      speed_rank: 50,
      size_label: 'Custom',
      rpm_limit: null,
      rpd_limit: null,
      tpm_limit: null,
      tpd_limit: null,
      monthly_token_budget: '',
      context_window: null,
      enabled: 1,
    });

    const fallbackConfig = await getUserFallbackConfig(user.userId);
    const maxPriority = fallbackConfig.length > 0 ? Math.max(...fallbackConfig.map(f => f.priority)) : 0;
    await upsertFallbackConfig({
      user_id: user.userId,
      model_id: newModel.id,
      priority: maxPriority + 1,
      enabled: 1,
    });

    res.status(201).json({
      success: true,
      keyId,
      modelDbId: newModel.id,
      platform: 'custom',
      baseUrl,
      model: modelId,
      displayName,
      maskedKey: maskKey(rawKey),
    });
  } catch (error) {
    console.error('Error adding custom provider:', error);
    res.status(500).json({ error: { message: 'Failed to add custom provider' } });
  }
});

keysRouter.delete('/:id', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: { message: 'Authentication required' } });
    return;
  }

  const id = String(req.params.id);
  if (!id) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  try {
    const key = await getApiKeyById(id);
    if (!key || key.user_id !== user.userId) {
      res.status(404).json({ error: { message: 'Key not found' } });
      return;
    }

    await deleteApiKey(id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting key:', error);
    res.status(500).json({ error: { message: 'Failed to delete key' } });
  }
});

keysRouter.patch('/platform/:platform', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: { message: 'Authentication required' } });
    return;
  }

  const platform = req.params.platform as string;
  if (!(PLATFORMS as readonly string[]).includes(platform)) {
    res.status(400).json({ error: { message: `Invalid platform '${platform}'` } });
    return;
  }

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: { message: 'enabled must be a boolean' } });
    return;
  }

  try {
    const keys = await getUserApiKeys(user.userId);
    const platformKeys = keys.filter(k => k.platform === platform);
    
    for (const key of platformKeys) {
      await updateApiKey(key.id, { enabled: enabled ? 1 : 0 });
    }

    res.json({ success: true, enabled, updatedKeys: platformKeys.length });
  } catch (error) {
    console.error('Error updating platform keys:', error);
    res.status(500).json({ error: { message: 'Failed to update platform keys' } });
  }
});

keysRouter.patch('/:id', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: { message: 'Authentication required' } });
    return;
  }

  const id = String(req.params.id);
  if (!id) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const parsed = updateKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { enabled, label } = parsed.data;
  const updates: any = {};

  if (enabled !== undefined) updates.enabled = enabled ? 1 : 0;
  if (label !== undefined) updates.label = label;

  try {
    const key = await getApiKeyById(id);
    if (!key || key.user_id !== user.userId) {
      res.status(404).json({ error: { message: 'Key not found' } });
      return;
    }

    await updateApiKey(id, updates);
    const response: Record<string, unknown> = { success: true };
    if (enabled !== undefined) response.enabled = enabled;
    if (label !== undefined) response.label = label;
    res.json(response);
  } catch (error) {
    console.error('Error updating key:', error);
    res.status(500).json({ error: { message: 'Failed to update key' } });
  }
});
