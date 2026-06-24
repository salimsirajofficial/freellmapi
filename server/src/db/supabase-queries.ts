import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getSupabaseAdmin } from '../lib/supabase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function db() {
  return getSupabaseAdmin();
}

// ============================================================================
// MODELS
// ============================================================================

export interface Model {
  id: string;
  platform: string;
  model_id: string;
  display_name: string;
  intelligence_rank: number;
  speed_rank: number;
  size_label: string;
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
  monthly_token_budget: string;
  context_window: number | null;
  enabled: number;
  supports_vision: number;
  supports_tools: number;
  key_id: string | null;
  created_at: string;
  updated_at: string;
}

export async function getAllModels(): Promise<Model[]> {
  const { data, error } = await db().from('models').select('*').order('intelligence_rank', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function getModelById(id: string): Promise<Model | null> {
  const { data, error } = await db().from('models').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

export async function getModelByPlatformAndId(platform: string, model_id: string): Promise<Model | null> {
  const { data, error } = await db().from('models').select('*').eq('platform', platform).eq('model_id', model_id).maybeSingle();
  if (error) throw error;
  return data;
}

export async function getEnabledModelByModelId(model_id: string): Promise<Model | null> {
  const { data, error } = await db().from('models').select('*').eq('model_id', model_id).eq('enabled', 1).maybeSingle();
  if (error) throw error;
  return data;
}

export async function getEnabledModels(): Promise<Model[]> {
  const { data, error } = await db().from('models').select('*').eq('enabled', 1).order('intelligence_rank', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function insertModel(model: Partial<Model>): Promise<Model> {
  const { data, error } = await db().from('models').insert(model).select().single();
  if (error) throw error;
  return data;
}

export async function getEnabledModelsByPlatform(platform: string): Promise<Model[]> {
  const { data, error } = await db()
    .from('models')
    .select('*')
    .eq('platform', platform)
    .eq('enabled', 1)
    .order('intelligence_rank', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function updateModel(id: string, updates: Partial<Model>): Promise<Model> {
  const { data, error } = await db().from('models').update(updates).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function getDistinctModelsForList(): Promise<Array<{ platform: string; model_id: string; display_name: string; context_window: number | null }>> {
  const models = await getEnabledModels();
  const seen = new Set<string>();
  const result: Array<{ platform: string; model_id: string; display_name: string; context_window: number | null }> = [];
  for (const m of models) {
    if (seen.has(m.model_id)) continue;
    seen.add(m.model_id);
    result.push({ platform: m.platform, model_id: m.model_id, display_name: m.display_name, context_window: m.context_window });
  }
  return result;
}

// ============================================================================
// API KEYS
// ============================================================================

export interface ApiKey {
  id: string;
  user_id: string;
  platform: string;
  label: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  status: string;
  enabled: number;
  base_url: string | null;
  created_at: string;
  last_checked_at: string | null;
}

export async function getUserApiKeys(userId: string): Promise<ApiKey[]> {
  const { data, error } = await db().from('api_keys').select('*').eq('user_id', userId).order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function getApiKeyById(id: string): Promise<ApiKey | null> {
  const { data, error } = await db().from('api_keys').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

export async function getEnabledApiKeysByPlatform(userId: string, platform: string): Promise<ApiKey[]> {
  const { data, error } = await db()
    .from('api_keys')
    .select('*')
    .eq('user_id', userId)
    .eq('platform', platform)
    .eq('enabled', 1)
    .in('status', ['healthy', 'unknown']);
  if (error) throw error;
  return data ?? [];
}

export async function insertApiKey(key: Partial<ApiKey>): Promise<ApiKey> {
  const { data, error } = await db().from('api_keys').insert(key).select().single();
  if (error) throw error;
  return data;
}

export async function updateApiKey(id: string, updates: Partial<ApiKey>): Promise<ApiKey> {
  const { data, error } = await db().from('api_keys').update(updates).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function deleteApiKey(id: string): Promise<void> {
  const { error } = await db().from('api_keys').delete().eq('id', id);
  if (error) throw error;
}

// ============================================================================
// REQUESTS
// ============================================================================

export interface Request {
  id: string;
  user_id: string;
  platform: string;
  model_id: string;
  key_id: string | null;
  status: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  ttfb_ms: number | null;
  requested_model: string | null;
  error: string | null;
  request_type: string;
  created_at: string;
}

export async function insertRequest(request: Partial<Request>): Promise<Request> {
  const { data, error } = await db().from('requests').insert(request).select().single();
  if (error) throw error;
  return data;
}

export async function getUserRequests(userId: string, limit = 100): Promise<Request[]> {
  const { data, error } = await db().from('requests').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data ?? [];
}

export async function deleteOldRequests(userId: string, beforeDate: Date): Promise<void> {
  const { error } = await db().from('requests').delete().eq('user_id', userId).lt('created_at', beforeDate.toISOString());
  if (error) throw error;
}

export interface RequestStatsBucket {
  platform: string;
  model_id: string;
  age_days: number;
  total: number;
  successes: number;
  succ_out: number;
  succ_lat: number;
  succ_ttfb_sum: number;
  succ_ttfb_cnt: number;
}

export async function getRequestStatsBuckets(userId: string, since: Date): Promise<RequestStatsBucket[]> {
  const { data, error } = await db()
    .from('requests')
    .select('platform, model_id, status, input_tokens, output_tokens, latency_ms, ttfb_ms, created_at, request_type')
    .eq('user_id', userId)
    .gte('created_at', since.toISOString());
  if (error) throw error;

  const buckets = new Map<string, RequestStatsBucket>();
  const now = Date.now();
  for (const row of data ?? []) {
    if (row.request_type && row.request_type !== 'chat') continue;
    const created = new Date(row.created_at).getTime();
    const ageDays = Math.floor((now - created) / (24 * 60 * 60 * 1000));
    const key = `${row.platform}:${row.model_id}:${ageDays}`;
    const b = buckets.get(key) ?? {
      platform: row.platform,
      model_id: row.model_id,
      age_days: ageDays,
      total: 0,
      successes: 0,
      succ_out: 0,
      succ_lat: 0,
      succ_ttfb_sum: 0,
      succ_ttfb_cnt: 0,
    };
    b.total++;
    if (row.status === 'success') {
      b.successes++;
      b.succ_out += row.output_tokens ?? 0;
      b.succ_lat += row.latency_ms ?? 0;
      if (row.ttfb_ms != null) {
        b.succ_ttfb_sum += row.ttfb_ms;
        b.succ_ttfb_cnt++;
      }
    }
    buckets.set(key, b);
  }
  return [...buckets.values()];
}

export async function getMonthlyChatUsageByModel(userId: string): Promise<Map<string, number>> {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const { data, error } = await db()
    .from('requests')
    .select('platform, model_id, input_tokens, output_tokens, request_type')
    .eq('user_id', userId)
    .gte('created_at', startOfMonth.toISOString());
  if (error) throw error;

  const usage = new Map<string, number>();
  for (const row of data ?? []) {
    if (row.request_type && row.request_type !== 'chat') continue;
    const key = `${row.platform}:${row.model_id}`;
    usage.set(key, (usage.get(key) ?? 0) + (row.input_tokens ?? 0) + (row.output_tokens ?? 0));
  }
  return usage;
}

// ============================================================================
// RATE LIMIT
// ============================================================================

export interface RateLimitUsage {
  id: string;
  user_id: string;
  platform: string;
  model_id: string;
  key_id: string;
  kind: string;
  tokens: number;
  created_at_ms: number;
  created_at: string;
}

export async function insertRateLimitUsage(usage: Partial<RateLimitUsage>): Promise<RateLimitUsage> {
  const { data, error } = await db().from('rate_limit_usage').insert(usage).select().single();
  if (error) throw error;
  return data;
}

export async function getRateLimitUsage(
  userId: string,
  platform: string,
  model_id: string,
  key_id: string,
  kind: string,
  afterMs: number,
): Promise<RateLimitUsage[]> {
  let query = db().from('rate_limit_usage').select('*').eq('user_id', userId).eq('platform', platform).eq('key_id', key_id).eq('kind', kind).gt('created_at_ms', afterMs);
  if (model_id) query = query.eq('model_id', model_id);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function countRateLimitUsage(
  userId: string,
  platform: string,
  model_id: string,
  key_id: string,
  kind: string,
  afterMs: number,
): Promise<number> {
  let query = db().from('rate_limit_usage').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('platform', platform).eq('key_id', key_id).eq('kind', kind).gt('created_at_ms', afterMs);
  if (model_id) query = query.eq('model_id', model_id);
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

export async function sumRateLimitTokens(
  userId: string,
  platform: string,
  model_id: string,
  key_id: string,
  afterMs: number,
): Promise<number> {
  const usage = await getRateLimitUsage(userId, platform, model_id, key_id, 'tokens', afterMs);
  return usage.reduce((sum, u) => sum + u.tokens, 0);
}

export async function deleteOldRateLimitUsage(userId: string, beforeMs: number): Promise<void> {
  const { error } = await db().from('rate_limit_usage').delete().eq('user_id', userId).lt('created_at_ms', beforeMs);
  if (error) throw error;
}

export interface RateLimitCooldown {
  user_id: string;
  platform: string;
  model_id: string;
  key_id: string;
  expires_at_ms: number;
  created_at: string;
}

export async function getRateLimitCooldown(
  userId: string,
  platform: string,
  model_id: string,
  key_id: string,
): Promise<RateLimitCooldown | null> {
  const { data, error } = await db()
    .from('rate_limit_cooldowns')
    .select('*')
    .eq('user_id', userId)
    .eq('platform', platform)
    .eq('model_id', model_id)
    .eq('key_id', key_id)
    .gt('expires_at_ms', Date.now())
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function upsertRateLimitCooldown(cooldown: Partial<RateLimitCooldown>): Promise<void> {
  const { error } = await db().from('rate_limit_cooldowns').upsert(cooldown, { onConflict: 'user_id,platform,model_id,key_id' });
  if (error) throw error;
}

export async function deleteRateLimitCooldown(userId: string, platform: string, model_id: string, key_id: string): Promise<void> {
  const { error } = await db().from('rate_limit_cooldowns').delete().eq('user_id', userId).eq('platform', platform).eq('model_id', model_id).eq('key_id', key_id);
  if (error) throw error;
}

export async function deleteExpiredCooldowns(): Promise<void> {
  const { error } = await db().from('rate_limit_cooldowns').delete().lt('expires_at_ms', Date.now());
  if (error) throw error;
}

// ============================================================================
// FALLBACK CONFIG
// ============================================================================

export interface FallbackConfig {
  id: string;
  user_id: string;
  model_id: string;
  priority: number;
  enabled: number;
  created_at: string;
}

export interface FallbackChainRow {
  model_db_id: string;
  priority: number;
  enabled: number;
  platform: string;
  model_id: string;
  display_name: string;
  intelligence_rank: number;
  size_label: string;
  monthly_token_budget: string;
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
  supports_vision: number;
  supports_tools: number;
  context_window: number | null;
  key_id: string | null;
}

export async function getUserFallbackConfig(userId: string): Promise<FallbackConfig[]> {
  const { data, error } = await db().from('fallback_config').select('*').eq('user_id', userId).order('priority', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function getFallbackChain(userId: string): Promise<FallbackChainRow[]> {
  const { data, error } = await db()
    .from('fallback_config')
    .select('model_id, priority, enabled, models!inner(id, platform, model_id, display_name, intelligence_rank, size_label, monthly_token_budget, rpm_limit, rpd_limit, tpm_limit, tpd_limit, supports_vision, supports_tools, context_window, key_id, enabled)')
    .eq('user_id', userId)
    .eq('enabled', 1);
  if (error) throw error;

  const rows: FallbackChainRow[] = [];
  for (const fc of data ?? []) {
    const m = (fc as any).models;
    if (!m || m.enabled !== 1) continue;
    rows.push({
      model_db_id: m.id,
      priority: fc.priority,
      enabled: fc.enabled,
      platform: m.platform,
      model_id: m.model_id,
      display_name: m.display_name,
      intelligence_rank: m.intelligence_rank,
      size_label: m.size_label,
      monthly_token_budget: m.monthly_token_budget,
      rpm_limit: m.rpm_limit,
      rpd_limit: m.rpd_limit,
      tpm_limit: m.tpm_limit,
      tpd_limit: m.tpd_limit,
      supports_vision: m.supports_vision,
      supports_tools: m.supports_tools ?? 0,
      context_window: m.context_window,
      key_id: m.key_id ?? null,
    });
  }
  return rows;
}

export async function upsertFallbackConfig(config: Partial<FallbackConfig>): Promise<FallbackConfig> {
  const { data, error } = await db().from('fallback_config').upsert(config, { onConflict: 'user_id,model_id' }).select().single();
  if (error) throw error;
  return data;
}

export async function deleteFallbackConfig(id: string): Promise<void> {
  const { error } = await db().from('fallback_config').delete().eq('id', id);
  if (error) throw error;
}

/**
 * Add every enabled model for a platform to the user's fallback chain.
 * Existing entries are left untouched (priority/enabled preserved); only
 * models not yet in the chain are appended after the current max priority.
 * Returns the number of newly enrolled models.
 */
export async function enrollPlatformModelsInFallback(userId: string, platform: string): Promise<number> {
  const models = await getEnabledModelsByPlatform(platform);
  if (models.length === 0) return 0;

  const existing = await getUserFallbackConfig(userId);
  const existingIds = new Set(existing.map(f => f.model_id));
  let maxPriority = existing.length > 0 ? Math.max(...existing.map(f => f.priority)) : 0;

  let enrolled = 0;
  for (const model of models) {
    if (existingIds.has(model.id)) continue;
    maxPriority += 1;
    await upsertFallbackConfig({
      user_id: userId,
      model_id: model.id,
      priority: maxPriority,
      enabled: 1,
    });
    enrolled++;
  }
  return enrolled;
}

// ============================================================================
// SETTINGS
// ============================================================================

export async function getUserSetting(userId: string, key: string): Promise<string | null> {
  const { data, error } = await db().from('settings').select('value').eq('user_id', userId).eq('key', key).maybeSingle();
  if (error) throw error;
  return data?.value ?? null;
}

export async function setUserSetting(userId: string, key: string, value: string): Promise<void> {
  const { error } = await db().from('settings').upsert({ user_id: userId, key, value }, { onConflict: 'user_id,key' });
  if (error) throw error;
}

export async function deleteUserSetting(userId: string, key: string): Promise<void> {
  const { error } = await db().from('settings').delete().eq('user_id', userId).eq('key', key);
  if (error) throw error;
}

export async function findUserIdByUnifiedApiKey(apiKey: string): Promise<string | null> {
  const { data, error } = await db().from('settings').select('user_id').eq('key', 'unified_api_key').eq('value', apiKey).maybeSingle();
  if (error) throw error;
  return data?.user_id ?? null;
}

// ============================================================================
// EMBEDDING MODELS
// ============================================================================

export interface EmbeddingModel {
  id: string;
  family: string;
  platform: string;
  model_id: string;
  display_name: string;
  dimensions: number;
  max_input_tokens: number | null;
  priority: number;
  enabled: number;
  quota_label: string;
}

export async function getAllEmbeddingModels(): Promise<EmbeddingModel[]> {
  const { data, error } = await db().from('embedding_models').select('*').order('family').order('priority');
  if (error) throw error;
  return data ?? [];
}

export async function getEmbeddingModelsByFamily(family: string): Promise<EmbeddingModel[]> {
  const { data, error } = await db().from('embedding_models').select('*').eq('family', family).eq('enabled', 1).order('priority');
  if (error) throw error;
  return data ?? [];
}

export async function updateEmbeddingModel(id: string, updates: Partial<EmbeddingModel>): Promise<void> {
  const { error } = await db().from('embedding_models').update(updates).eq('id', id);
  if (error) throw error;
}

// ============================================================================
// PROFILES
// ============================================================================

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  created_at: string;
  updated_at: string;
}

export async function getUserProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await db().from('profiles').select('*').eq('id', userId).maybeSingle();
  if (error) throw error;
  return data;
}

export async function updateUserProfile(userId: string, updates: Partial<Profile>): Promise<Profile> {
  const { data, error } = await db().from('profiles').update(updates).eq('id', userId).select().single();
  if (error) throw error;
  return data;
}

// ============================================================================
// BOOTSTRAP
// ============================================================================

export async function countModels(): Promise<number> {
  const { count, error } = await db().from('models').select('*', { count: 'exact', head: true });
  if (error) throw error;
  return count ?? 0;
}

export async function seedModelsIfEmpty(): Promise<void> {
  const count = await countModels();
  if (count > 0) return;

  const modelsPath = path.join(__dirname, 'seed-data', 'full-models.json');
  const embeddingsPath = path.join(__dirname, 'seed-data', 'full-embedding-models.json');
  if (!fs.existsSync(modelsPath)) {
    console.warn('[bootstrap] No model seed data found — models table is empty');
    return;
  }

  const models = JSON.parse(fs.readFileSync(modelsPath, 'utf8')) as Array<Record<string, unknown>>;
  const batchSize = 50;
  for (let i = 0; i < models.length; i += batchSize) {
    const batch = models.slice(i, i + batchSize).map(m => ({
      platform: m.platform,
      model_id: m.model_id,
      display_name: m.display_name,
      intelligence_rank: m.intelligence_rank,
      speed_rank: m.speed_rank,
      size_label: m.size_label ?? '',
      rpm_limit: m.rpm_limit,
      rpd_limit: m.rpd_limit,
      tpm_limit: m.tpm_limit,
      tpd_limit: m.tpd_limit,
      monthly_token_budget: m.monthly_token_budget ?? '',
      context_window: m.context_window,
      enabled: m.enabled ?? 1,
      supports_vision: m.supports_vision ?? 0,
      supports_tools: m.supports_tools ?? 0,
    }));
    const { error } = await db().from('models').insert(batch);
    if (error) throw error;
  }

  if (fs.existsSync(embeddingsPath)) {
    const embeddings = JSON.parse(fs.readFileSync(embeddingsPath, 'utf8')) as Array<Record<string, unknown>>;
    if (embeddings.length > 0) {
      const { error } = await db().from('embedding_models').insert(embeddings.map(e => ({
        family: e.family,
        platform: e.platform,
        model_id: e.model_id,
        display_name: e.display_name,
        dimensions: e.dimensions,
        max_input_tokens: e.max_input_tokens,
        priority: e.priority ?? 0,
        enabled: e.enabled ?? 1,
        quota_label: e.quota_label ?? '',
      })));
      if (error) throw error;
    }
  }

  console.log(`[bootstrap] Seeded ${models.length} models into Supabase`);
}
