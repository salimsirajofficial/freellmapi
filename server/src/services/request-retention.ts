import { deleteOldRequests, getUserRequests } from '../db/supabase-queries.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_MAX_ROWS = 100_000;
const PRUNE_INTERVAL_MS = 60_000;

export interface RequestAnalyticsRetentionConfig {
  retentionDays: number;
  maxRows: number;
}

let nextPruneAtMs = 0;

function readNonNegativeInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return defaultValue;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return defaultValue;
  return parsed;
}

export function getRequestAnalyticsRetentionConfig(): RequestAnalyticsRetentionConfig {
  return {
    retentionDays: readNonNegativeInt('REQUEST_ANALYTICS_RETENTION_DAYS', DEFAULT_RETENTION_DAYS),
    maxRows: readNonNegativeInt('REQUEST_ANALYTICS_MAX_ROWS', DEFAULT_MAX_ROWS),
  };
}

export async function pruneRequestAnalytics(options: {
  userId?: string;
  force?: boolean;
  now?: Date;
} = {}): Promise<{ deleted: number; skipped: boolean }> {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();

  if (!options.force && nowMs < nextPruneAtMs) {
    return { deleted: 0, skipped: true };
  }
  nextPruneAtMs = nowMs + PRUNE_INTERVAL_MS;

  const { retentionDays, maxRows } = getRequestAnalyticsRetentionConfig();
  let deleted = 0;

  if (!options.userId) {
    // If no userId provided, skip (we need userId for Supabase RLS)
    return { deleted: 0, skipped: true };
  }

  if (retentionDays > 0) {
    const cutoff = new Date(nowMs - retentionDays * DAY_MS);
    try {
      await deleteOldRequests(options.userId, cutoff);
      deleted += 1; // We don't get exact count from Supabase delete
    } catch (error) {
      console.error('Error pruning old requests:', error);
    }
  }

  if (maxRows > 0) {
    try {
      const requests = await getUserRequests(options.userId, maxRows + 1);
      if (requests.length > maxRows) {
        // Delete excess rows
        const cutoffDate = new Date(requests[maxRows].created_at);
        await deleteOldRequests(options.userId, cutoffDate);
        deleted += requests.length - maxRows;
      }
    } catch (error) {
      console.error('Error pruning excess requests:', error);
    }
  }

  return { deleted, skipped: false };
}
