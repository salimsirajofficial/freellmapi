// Sliding window rate limit tracker with Supabase persistence.

import {
  insertRateLimitUsage,
  countRateLimitUsage,
  sumRateLimitTokens,
  deleteOldRateLimitUsage,
  getRateLimitCooldown,
  upsertRateLimitCooldown,
  deleteRateLimitCooldown,
} from '../db/supabase-queries.js';

interface Window {
  timestamps: number[];
  tokenCount: number;
  tokenTimestamps: { ts: number; tokens: number }[];
}

const windows = new Map<string, Window>();
type UsageKind = 'request' | 'tokens';

function getWindow(key: string): Window {
  let w = windows.get(key);
  if (!w) {
    w = { timestamps: [], tokenCount: 0, tokenTimestamps: [] };
    windows.set(key, w);
  }
  return w;
}

function pruneTimestamps(timestamps: number[], windowMs: number, now: number): number[] {
  return timestamps.filter(ts => ts > now - windowMs);
}

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

async function recordUsage(
  userId: string,
  platform: string,
  modelId: string,
  keyId: string,
  kind: UsageKind,
  tokens: number,
  now: number,
) {
  try {
    await insertRateLimitUsage({
      user_id: userId,
      platform,
      model_id: modelId,
      key_id: keyId,
      kind,
      tokens,
      created_at_ms: now,
    });
    await deleteOldRateLimitUsage(userId, now - DAY);
  } catch (error) {
    console.error('Error recording rate limit usage:', error);
  }
}

async function countPersistedRequests(
  userId: string,
  platform: string,
  modelId: string,
  keyId: string,
  windowMs: number,
  now: number,
): Promise<number | undefined> {
  try {
    return await countRateLimitUsage(userId, platform, modelId, keyId, 'request', now - windowMs);
  } catch (error) {
    console.error('Error counting persisted requests:', error);
    return undefined;
  }
}

async function sumPersistedTokens(
  userId: string,
  platform: string,
  modelId: string,
  keyId: string,
  windowMs: number,
  now: number,
): Promise<number | undefined> {
  try {
    return await sumRateLimitTokens(userId, platform, modelId, keyId, now - windowMs);
  } catch (error) {
    console.error('Error summing persisted tokens:', error);
    return undefined;
  }
}

function memoryRequestCount(key: string, windowMs: number, now: number): number {
  const w = getWindow(key);
  w.timestamps = pruneTimestamps(w.timestamps, windowMs, now);
  return w.timestamps.length;
}

function memoryTokenCount(key: string, windowMs: number, now: number): number {
  const w = getWindow(key);
  w.tokenTimestamps = w.tokenTimestamps.filter(t => t.ts > now - windowMs);
  return w.tokenTimestamps.reduce((sum, t) => sum + t.tokens, 0);
}

async function requestCount(
  userId: string,
  platform: string,
  modelId: string,
  keyId: string,
  windowMs: number,
  now: number,
): Promise<number> {
  const persisted = await countPersistedRequests(userId, platform, modelId, keyId, windowMs, now);
  if (persisted !== undefined && persisted > 0) return persisted;
  const type = windowMs === MINUTE ? 'rpm' : 'rpd';
  return memoryRequestCount(`${platform}:${modelId}:${keyId}:${type}`, windowMs, now);
}

async function tokenCount(
  userId: string,
  platform: string,
  modelId: string,
  keyId: string,
  windowMs: number,
  now: number,
): Promise<number> {
  const persisted = await sumPersistedTokens(userId, platform, modelId, keyId, windowMs, now);
  if (persisted !== undefined && persisted > 0) return persisted;
  const type = windowMs === MINUTE ? 'tpm' : 'tpd';
  return memoryTokenCount(`${platform}:${modelId}:${keyId}:${type}`, windowMs, now);
}

export async function canMakeRequest(
  userId: string,
  platform: string,
  modelId: string,
  keyId: string,
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null },
): Promise<boolean> {
  const now = Date.now();
  if (limits.rpm !== null && (await requestCount(userId, platform, modelId, keyId, MINUTE, now)) >= limits.rpm) return false;
  if (limits.rpd !== null && (await requestCount(userId, platform, modelId, keyId, DAY, now)) >= limits.rpd) return false;
  return true;
}

export async function canUseTokens(
  userId: string,
  platform: string,
  modelId: string,
  keyId: string,
  estimatedTokens: number,
  limits: { tpm: number | null; tpd: number | null },
): Promise<boolean> {
  const now = Date.now();
  if (limits.tpm !== null) {
    const used = await tokenCount(userId, platform, modelId, keyId, MINUTE, now);
    if (used + estimatedTokens > limits.tpm) return false;
  }
  if (limits.tpd !== null) {
    const used = await tokenCount(userId, platform, modelId, keyId, DAY, now);
    if (used + estimatedTokens > limits.tpd) return false;
  }
  return true;
}

const DEFAULT_PROVIDER_DAILY_REQUEST_CAPS: Record<string, number> = {
  openrouter: 1000,
};

export function getProviderDailyRequestCap(platform: string): number | null {
  const raw = process.env[`PROVIDER_DAILY_REQUEST_CAP_${platform.toUpperCase()}`];
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n === 0 ? null : n;
  }
  return DEFAULT_PROVIDER_DAILY_REQUEST_CAPS[platform] ?? null;
}

async function countPersistedProviderRequests(
  userId: string,
  platform: string,
  keyId: string,
  windowMs: number,
  now: number,
): Promise<number | undefined> {
  try {
    return await countRateLimitUsage(userId, platform, '', keyId, 'request', now - windowMs);
  } catch (error) {
    console.error('Error counting provider requests:', error);
    return undefined;
  }
}

export async function providerDailyRequestCount(userId: string, platform: string, keyId: string, now = Date.now()): Promise<number> {
  const persisted = await countPersistedProviderRequests(userId, platform, keyId, DAY, now);
  if (persisted !== undefined && persisted > 0) return persisted;
  let total = 0;
  for (const [key, w] of windows) {
    if (key.startsWith(`${platform}:`) && key.endsWith(`:${keyId}:rpd`)) {
      total += pruneTimestamps(w.timestamps, DAY, now).length;
    }
  }
  return total;
}

export async function canUseProvider(userId: string, platform: string, keyId: string, now = Date.now()): Promise<boolean> {
  const cap = getProviderDailyRequestCap(platform);
  if (cap === null) return true;
  return (await providerDailyRequestCount(userId, platform, keyId, now)) < cap;
}

export async function recordRequest(userId: string, platform: string, modelId: string, keyId: string) {
  const now = Date.now();
  getWindow(`${platform}:${modelId}:${keyId}:rpm`).timestamps.push(now);
  getWindow(`${platform}:${modelId}:${keyId}:rpd`).timestamps.push(now);
  await recordUsage(userId, platform, modelId, keyId, 'request', 0, now);
}

export async function recordTokens(userId: string, platform: string, modelId: string, keyId: string, tokens: number) {
  const now = Date.now();
  getWindow(`${platform}:${modelId}:${keyId}:tpm`).tokenTimestamps.push({ ts: now, tokens });
  getWindow(`${platform}:${modelId}:${keyId}:tpd`).tokenTimestamps.push({ ts: now, tokens });
  await recordUsage(userId, platform, modelId, keyId, 'tokens', tokens, now);
}

const cooldowns = new Map<string, number>();
const cooldownHits = new Map<string, number[]>();
const HOUR = 60 * MINUTE;
const COOLDOWN_DURATIONS = [2 * MINUTE, 10 * MINUTE, HOUR, DAY];

export function getNextCooldownDuration(platform: string, modelId: string, keyId: string): number {
  const key = `${platform}:${modelId}:${keyId}`;
  const now = Date.now();
  const hits = (cooldownHits.get(key) ?? []).filter(t => t > now - DAY);
  hits.push(now);
  cooldownHits.set(key, hits);
  const idx = Math.min(hits.length - 1, COOLDOWN_DURATIONS.length - 1);
  return COOLDOWN_DURATIONS[idx]!;
}

const TRANSIENT_COOLDOWN_MS = 90 * 1000;
export const PAYMENT_REQUIRED_COOLDOWN_MS = DAY;

export async function getCooldownDurationForLimit(
  userId: string,
  platform: string,
  modelId: string,
  keyId: string,
  limits: { rpd: number | null; tpd: number | null },
): Promise<number> {
  const now = Date.now();
  const rpdExhausted = limits.rpd !== null && (await requestCount(userId, platform, modelId, keyId, DAY, now)) >= limits.rpd;
  const tpdExhausted = limits.tpd !== null && (await tokenCount(userId, platform, modelId, keyId, DAY, now)) >= limits.tpd;
  if (rpdExhausted || tpdExhausted) return getNextCooldownDuration(platform, modelId, keyId);
  return TRANSIENT_COOLDOWN_MS;
}

async function persistedCooldownExpiry(
  userId: string,
  platform: string,
  modelId: string,
  keyId: string,
): Promise<number | null | undefined> {
  try {
    const cooldown = await getRateLimitCooldown(userId, platform, modelId, keyId);
    return cooldown?.expires_at_ms ?? null;
  } catch (error) {
    console.error('Error getting persisted cooldown:', error);
    return undefined;
  }
}

async function persistCooldown(userId: string, platform: string, modelId: string, keyId: string, expiresAtMs: number) {
  try {
    await upsertRateLimitCooldown({ user_id: userId, platform, model_id: modelId, key_id: keyId, expires_at_ms: expiresAtMs });
  } catch (error) {
    console.error('Error persisting cooldown:', error);
  }
}

async function clearPersistedCooldown(userId: string, platform: string, modelId: string, keyId: string) {
  try {
    await deleteRateLimitCooldown(userId, platform, modelId, keyId);
  } catch (error) {
    console.error('Error clearing persisted cooldown:', error);
  }
}

export async function setCooldown(userId: string, platform: string, modelId: string, keyId: string, durationMs = 60_000) {
  const key = `${platform}:${modelId}:${keyId}:cooldown`;
  const expiresAtMs = Date.now() + durationMs;
  cooldowns.set(key, expiresAtMs);
  await persistCooldown(userId, platform, modelId, keyId, expiresAtMs);
}

export async function isOnCooldown(userId: string, platform: string, modelId: string, keyId: string): Promise<boolean> {
  const key = `${platform}:${modelId}:${keyId}:cooldown`;
  const now = Date.now();
  const persistedExpiry = await persistedCooldownExpiry(userId, platform, modelId, keyId);
  if (persistedExpiry !== undefined && persistedExpiry !== null) {
    if (now > persistedExpiry) {
      cooldowns.delete(key);
      await clearPersistedCooldown(userId, platform, modelId, keyId);
      return false;
    }
    cooldowns.set(key, persistedExpiry);
    return true;
  }

  const expiry = cooldowns.get(key);
  if (!expiry) return false;
  if (now > expiry) {
    cooldowns.delete(key);
    return false;
  }
  return true;
}

export async function getRateLimitStatus(
  userId: string,
  platform: string,
  modelId: string,
  keyId: string,
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null },
) {
  const now = Date.now();
  return {
    rpm: { used: await requestCount(userId, platform, modelId, keyId, MINUTE, now), limit: limits.rpm },
    rpd: { used: await requestCount(userId, platform, modelId, keyId, DAY, now), limit: limits.rpd },
    tpm: { used: await tokenCount(userId, platform, modelId, keyId, MINUTE, now), limit: limits.tpm },
  };
}
