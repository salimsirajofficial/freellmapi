import {
  getFallbackChain,
  getRequestStatsBuckets,
  getMonthlyChatUsageByModel,
  getEnabledApiKeysByPlatform,
  updateApiKey,
  getUserSetting,
  setUserSetting,
  type FallbackChainRow,
} from '../db/supabase-queries.js';
import { getProvider, resolveProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { canMakeRequest, canUseTokens, isOnCooldown, canUseProvider } from './ratelimit.js';
import {
  BANDIT_PRESETS, DEFAULT_STRATEGY, type RoutingStrategy, type RoutingWeights,
  reliabilityPosterior, expectedReliability, sampleBeta,
  speedScore, intelligenceScore, headroomFactor, rateLimitFactor, combineScore,
} from './scoring.js';
import { parseBudget } from '../lib/budget.js';
import type { BaseProvider } from '../providers/base.js';

interface KeyRow {
  id: string;
  platform: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  status: string;
  enabled: number;
  base_url: string | null;
}

type ChainRow = FallbackChainRow;

export interface RouteResult {
  provider: BaseProvider;
  modelId: string;
  modelDbId: string;
  apiKey: string;
  keyId: string;
  platform: string;
  displayName: string;
  rpdLimit: number | null;
  tpdLimit: number | null;
}

const roundRobinIndex = new Map<string, number>();
const rateLimitPenalties = new Map<string, { count: number; lastHit: number; penalty: number }>();

const PENALTY_PER_429 = 3;
const MAX_PENALTY = 10;
const DECAY_INTERVAL_MS = 2 * 60 * 1000;
const DECAY_AMOUNT = 1;

export function recordRateLimitHit(modelDbId: string) {
  const existing = rateLimitPenalties.get(modelDbId);
  const now = Date.now();
  if (existing) {
    existing.count++;
    existing.lastHit = now;
    existing.penalty = Math.min(existing.penalty + PENALTY_PER_429, MAX_PENALTY);
  } else {
    rateLimitPenalties.set(modelDbId, { count: 1, lastHit: now, penalty: PENALTY_PER_429 });
  }
}

export function recordSuccess(modelDbId: string) {
  const existing = rateLimitPenalties.get(modelDbId);
  if (existing) {
    existing.penalty = Math.max(0, existing.penalty - 1);
    if (existing.penalty === 0) rateLimitPenalties.delete(modelDbId);
  }
}

function getPenalty(modelDbId: string): number {
  const entry = rateLimitPenalties.get(modelDbId);
  if (!entry) return 0;
  const now = Date.now();
  const decaySteps = Math.floor((now - entry.lastHit) / DECAY_INTERVAL_MS);
  if (decaySteps > 0) {
    entry.penalty = Math.max(0, entry.penalty - (decaySteps * DECAY_AMOUNT));
    entry.lastHit = now;
    if (entry.penalty === 0) {
      rateLimitPenalties.delete(modelDbId);
      return 0;
    }
  }
  return entry.penalty;
}

export function getAllPenalties(): Array<{ modelDbId: string; count: number; penalty: number }> {
  const result: Array<{ modelDbId: string; count: number; penalty: number }> = [];
  for (const [modelDbId, entry] of rateLimitPenalties) {
    const penalty = getPenalty(modelDbId);
    if (penalty > 0) result.push({ modelDbId, count: entry.count, penalty });
  }
  return result.sort((a, b) => b.penalty - a.penalty);
}

const STRATEGY_KEY = 'routing_strategy';
const CUSTOM_WEIGHTS_KEY = 'routing_custom_weights';
const VALID_STRATEGIES: RoutingStrategy[] = ['priority', 'balanced', 'smartest', 'fastest', 'reliable', 'custom'];

export async function getRoutingStrategy(userId: string): Promise<RoutingStrategy> {
  const raw = await getUserSetting(userId, STRATEGY_KEY);
  return (raw && VALID_STRATEGIES.includes(raw as RoutingStrategy))
    ? (raw as RoutingStrategy)
    : DEFAULT_STRATEGY;
}

export async function setRoutingStrategy(userId: string, strategy: RoutingStrategy): Promise<void> {
  if (!VALID_STRATEGIES.includes(strategy)) {
    throw new Error(`Unknown routing strategy: ${strategy}`);
  }
  await setUserSetting(userId, STRATEGY_KEY, strategy);
}

export async function getCustomWeights(userId: string): Promise<RoutingWeights> {
  const raw = await getUserSetting(userId, CUSTOM_WEIGHTS_KEY);
  if (raw) {
    try {
      const w = JSON.parse(raw) as RoutingWeights;
      if (
        [w.reliability, w.speed, w.intelligence].every(v => Number.isFinite(v) && v >= 0) &&
        w.reliability + w.speed + w.intelligence > 0
      ) {
        return { reliability: w.reliability, speed: w.speed, intelligence: w.intelligence };
      }
    } catch { /* fall through */ }
  }
  return { ...BANDIT_PRESETS.balanced };
}

export async function setCustomWeights(userId: string, weights: RoutingWeights): Promise<void> {
  const { reliability, speed, intelligence } = weights;
  if (![reliability, speed, intelligence].every(v => Number.isFinite(v) && v >= 0)) {
    throw new Error('Custom weights must be non-negative numbers');
  }
  const sum = reliability + speed + intelligence;
  if (sum <= 0) throw new Error('Custom weights must not all be zero');
  await setUserSetting(userId, CUSTOM_WEIGHTS_KEY, JSON.stringify({
    reliability: reliability / sum,
    speed: speed / sum,
    intelligence: intelligence / sum,
  }));
}

async function weightsFor(userId: string, strategy: RoutingStrategy): Promise<RoutingWeights | null> {
  if (strategy === 'priority') return null;
  if (strategy === 'custom') return getCustomWeights(userId);
  return BANDIT_PRESETS[strategy];
}

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const HALF_LIFE_DAYS = 2;
const CACHE_TTL_MS = 60 * 1000;

interface ModelStats {
  successes: number;
  failures: number;
  tokPerSec: number;
  avgTtfbMs: number | null;
  monthlyUsedTokens: number;
}

const statsCacheByUser = new Map<string, { cache: Map<string, ModelStats>; time: number }>();

function decayWeight(ageDays: number): number {
  return Math.pow(0.5, Math.max(0, ageDays) / HALF_LIFE_DAYS);
}

export async function refreshStatsCache(userId: string, force = false): Promise<void> {
  const entry = statsCacheByUser.get(userId);
  if (!force && entry && Date.now() - entry.time < CACHE_TTL_MS) return;

  const since = new Date(Date.now() - WINDOW_MS);
  const buckets = await getRequestStatsBuckets(userId, since);
  const usageMap = await getMonthlyChatUsageByModel(userId);

  const acc = new Map<string, { wSucc: number; wFail: number; wOut: number; wLat: number; wTtfbSum: number; wTtfbCnt: number }>();
  for (const b of buckets) {
    const key = `${b.platform}:${b.model_id}`;
    const w = decayWeight(b.age_days);
    const a = acc.get(key) ?? { wSucc: 0, wFail: 0, wOut: 0, wLat: 0, wTtfbSum: 0, wTtfbCnt: 0 };
    a.wSucc += w * b.successes;
    a.wFail += w * (b.total - b.successes);
    a.wOut += w * b.succ_out;
    a.wLat += w * b.succ_lat;
    a.wTtfbSum += w * b.succ_ttfb_sum;
    a.wTtfbCnt += w * b.succ_ttfb_cnt;
    acc.set(key, a);
  }

  const next = new Map<string, ModelStats>();
  for (const [key, a] of acc) {
    next.set(key, {
      successes: a.wSucc,
      failures: a.wFail,
      tokPerSec: a.wLat > 0 ? (a.wOut * 1000) / a.wLat : 0,
      avgTtfbMs: a.wTtfbCnt > 0 ? a.wTtfbSum / a.wTtfbCnt : null,
      monthlyUsedTokens: usageMap.get(key) ?? 0,
    });
  }
  for (const [key, used] of usageMap) {
    if (!next.has(key)) {
      next.set(key, { successes: 0, failures: 0, tokPerSec: 0, avgTtfbMs: null, monthlyUsedTokens: used });
    }
  }

  statsCacheByUser.set(userId, { cache: next, time: Date.now() });
}

function getStatsCache(userId: string): Map<string, ModelStats> | null {
  return statsCacheByUser.get(userId)?.cache ?? null;
}

const TIER_VALUE: Record<string, number> = { Frontier: 4, Large: 3, Medium: 2, Small: 1 };

function intelligenceComposite(sizeLabel: string, intelligenceRank: number): number {
  const tier = TIER_VALUE[sizeLabel] ?? 0;
  return tier * 1000 - intelligenceRank;
}

interface ScoredEntry {
  axes: { reliability: number; speed: number; intelligence: number };
  headroom: number;
  rateLimit: number;
  score: number;
}

function scoreChainEntry(
  userId: string,
  entry: ChainRow,
  weights: RoutingWeights,
  intelMin: number,
  intelMax: number,
  sampled: boolean,
): ScoredEntry {
  const stats = getStatsCache(userId)?.get(`${entry.platform}:${entry.model_id}`);
  const successes = stats?.successes ?? 0;
  const failures = stats?.failures ?? 0;

  let reliability: number;
  if (sampled) {
    const { alpha, beta } = reliabilityPosterior(successes, failures);
    reliability = sampleBeta(alpha, beta);
  } else {
    reliability = expectedReliability(successes, failures);
  }

  const speed = speedScore(stats?.tokPerSec ?? 0, stats?.avgTtfbMs ?? null);
  const intelligence = intelligenceScore(intelligenceComposite(entry.size_label, entry.intelligence_rank), intelMin, intelMax);
  const budget = parseBudget(entry.monthly_token_budget);
  const headroom = headroomFactor(stats?.monthlyUsedTokens ?? 0, budget);
  const rl = rateLimitFactor(getPenalty(entry.model_db_id));
  const score = combineScore({ reliability, speed, intelligence, headroom, rateLimit: rl }, weights);
  return { axes: { reliability, speed, intelligence }, headroom, rateLimit: rl, score };
}

function orderChain(userId: string, chain: ChainRow[], strategy: RoutingStrategy, weights: RoutingWeights | null): ChainRow[] {
  if (!weights) {
    return chain
      .map(e => ({ e, eff: e.priority + getPenalty(e.model_db_id) }))
      .sort((a, b) => a.eff - b.eff || a.e.priority - b.e.priority)
      .map(x => x.e);
  }

  const composites = chain.map(e => intelligenceComposite(e.size_label, e.intelligence_rank));
  const intelMin = composites.length ? Math.min(...composites) : 0;
  const intelMax = composites.length ? Math.max(...composites) : 0;

  return chain
    .map(e => ({ e, s: scoreChainEntry(userId, e, weights, intelMin, intelMax, true).score }))
    .sort((a, b) => b.s - a.s || a.e.priority - b.e.priority)
    .map(x => x.e);
}

export async function routeRequest(
  userId: string,
  estimatedTokens = 1000,
  skipKeys?: Set<string>,
  preferredModelDbId?: string,
  requireVision = false,
  requireTools = false,
): Promise<RouteResult> {
  const strategy = await getRoutingStrategy(userId);
  if (strategy !== 'priority') await refreshStatsCache(userId);

  const chain = await getFallbackChain(userId);
  const weights = await weightsFor(userId, strategy);
  const sortedChain = orderChain(userId, chain, strategy, weights);

  if (preferredModelDbId) {
    const idx = sortedChain.findIndex(e => e.model_db_id === preferredModelDbId);
    if (idx > 0) {
      const [preferred] = sortedChain.splice(idx, 1);
      sortedChain.unshift(preferred);
    }
  }

  for (const entry of sortedChain) {
    if (requireVision && !entry.supports_vision) continue;
    if (requireTools && !entry.supports_tools) continue;
    if (entry.context_window != null && estimatedTokens > entry.context_window) continue;

    const provider = getProvider(entry.platform as any);
    if (!provider) continue;

    const keys = (await getEnabledApiKeysByPlatform(userId, entry.platform)) as KeyRow[];
    if (keys.length === 0) continue;

    const limits = { rpm: entry.rpm_limit, rpd: entry.rpd_limit, tpm: entry.tpm_limit, tpd: entry.tpd_limit };
    const rrKey = `${entry.platform}:${entry.model_id}`;
    let idx = roundRobinIndex.get(rrKey) ?? 0;

    for (let attempt = 0; attempt < keys.length; attempt++) {
      const key = keys[idx % keys.length];
      idx++;

      if (entry.platform === 'custom' && entry.key_id != null && key.id !== entry.key_id) continue;

      const skipId = `${entry.platform}:${entry.model_id}:${key.id}`;
      if (skipKeys?.has(skipId)) continue;
      if (await isOnCooldown(userId, entry.platform, entry.model_id, key.id)) continue;
      if (!(await canUseProvider(userId, entry.platform, key.id))) continue;
      if (!(await canMakeRequest(userId, entry.platform, entry.model_id, key.id, limits))) continue;
      if (!(await canUseTokens(userId, entry.platform, entry.model_id, key.id, estimatedTokens, limits))) continue;

      let decryptedKey: string;
      try {
        decryptedKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);
      } catch {
        await updateApiKey(key.id, { status: 'error', last_checked_at: new Date().toISOString() });
        continue;
      }

      const resolvedProvider = entry.platform === 'custom'
        ? resolveProvider('custom', key.base_url)
        : provider;
      if (!resolvedProvider) continue;

      roundRobinIndex.set(rrKey, idx);
      return {
        provider: resolvedProvider,
        modelId: entry.model_id,
        modelDbId: entry.model_db_id,
        apiKey: decryptedKey,
        keyId: key.id,
        platform: entry.platform,
        displayName: entry.display_name,
        rpdLimit: limits.rpd,
        tpdLimit: limits.tpd,
      };
    }

    roundRobinIndex.set(rrKey, idx);
  }

  const err = new Error('All models exhausted. Add more API keys or wait for rate limits to reset.') as any;
  err.status = 429;
  throw err;
}

export interface RoutingScore {
  modelDbId: string;
  platform: string;
  modelId: string;
  displayName: string;
  enabled: boolean;
  reliability: number;
  speed: number;
  intelligence: number;
  headroom: number;
  rateLimit: number;
  score: number;
  totalRequests: number;
}

export async function getRoutingScores(userId: string): Promise<{ strategy: RoutingStrategy; weights: RoutingWeights | null; scores: RoutingScore[] }> {
  const strategy = await getRoutingStrategy(userId);
  await refreshStatsCache(userId);

  const chain = await getFallbackChain(userId);
  const weights = (await weightsFor(userId, strategy)) ?? BANDIT_PRESETS.balanced;
  const composites = chain.map(e => intelligenceComposite(e.size_label, e.intelligence_rank));
  const intelMin = composites.length ? Math.min(...composites) : 0;
  const intelMax = composites.length ? Math.max(...composites) : 0;

  const scores: RoutingScore[] = chain.map(entry => {
    const scored = scoreChainEntry(userId, entry, weights, intelMin, intelMax, false);
    const stats = getStatsCache(userId)?.get(`${entry.platform}:${entry.model_id}`);
    return {
      modelDbId: entry.model_db_id,
      platform: entry.platform,
      modelId: entry.model_id,
      displayName: entry.display_name,
      enabled: entry.enabled === 1,
      reliability: scored.axes.reliability,
      speed: scored.axes.speed,
      intelligence: scored.axes.intelligence,
      headroom: scored.headroom,
      rateLimit: scored.rateLimit,
      score: scored.score,
      totalRequests: Math.round((stats?.successes ?? 0) + (stats?.failures ?? 0)),
    };
  }).sort((a, b) => b.score - a.score);

  return { strategy, weights: await weightsFor(userId, strategy), scores };
}

export async function hasEnabledVisionModel(userId: string): Promise<boolean> {
  const chain = await getFallbackChain(userId);
  return chain.some(e => e.supports_vision === 1);
}

export async function hasEnabledToolsModel(userId: string): Promise<boolean> {
  const chain = await getFallbackChain(userId);
  return chain.some(e => e.supports_tools === 1);
}
