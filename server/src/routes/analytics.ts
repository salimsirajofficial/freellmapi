import { Router } from 'express';
import type { Request, Response } from 'express';
import { getUserRequests } from '../db/supabase-queries.js';

export const analyticsRouter = Router();

const FALLBACK_INPUT_PER_M = 5;
const FALLBACK_OUTPUT_PER_M = 15;

function getSinceTimestamp(range: string): Date {
  const now = Date.now();
  switch (range) {
    case '24h':
      return new Date(now - 24 * 60 * 60 * 1000);
    case '30d':
      return new Date(now - 30 * 24 * 60 * 60 * 1000);
    case '7d':
    default:
      return new Date(now - 7 * 24 * 60 * 60 * 1000);
  }
}

analyticsRouter.get('/summary', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: { message: 'Authentication required' } });
    return;
  }

  try {
    const range = (req.query.range as string) ?? '7d';
    const since = getSinceTimestamp(range);
    const requests = await getUserRequests(user.userId, 10000);

    const filtered = requests.filter(r => new Date(r.created_at) >= since);
    
    const totalRequests = filtered.length;
    const successCount = filtered.filter(r => r.status === 'success').length;
    const successRate = totalRequests > 0 ? (successCount / totalRequests) * 100 : 0;
    
    const totalInputTokens = filtered.reduce((sum, r) => sum + (r.input_tokens || 0), 0);
    const totalOutputTokens = filtered.reduce((sum, r) => sum + (r.output_tokens || 0), 0);
    
    const latencies = filtered.filter(r => r.latency_ms > 0).map(r => r.latency_ms);
    const avgLatencyMs = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
    
    const pinnedCount = filtered.filter(r => r.requested_model !== null).length;
    const pinHonoredCount = filtered.filter(r => r.requested_model === r.model_id).length;
    
    const firstRequestAt = filtered.length > 0 ? filtered[filtered.length - 1].created_at : null;
    
    const estSavings = filtered
      .filter(r => r.status === 'success')
      .reduce((sum, r) => {
        return sum + (r.input_tokens * FALLBACK_INPUT_PER_M / 1000000) + (r.output_tokens * FALLBACK_OUTPUT_PER_M / 1000000);
      }, 0);

    res.json({
      totalRequests,
      successRate: Math.round(successRate * 10) / 10,
      totalInputTokens,
      totalOutputTokens,
      avgLatencyMs: Math.round(avgLatencyMs),
      estimatedCostSavings: Math.round(estSavings * 100) / 100,
      pinnedRequests: pinnedCount,
      pinHonoredRequests: pinHonoredCount,
      firstRequestAt,
    });
  } catch (error) {
    console.error('Error fetching analytics summary:', error);
    res.status(500).json({ error: { message: 'Failed to fetch analytics summary' } });
  }
});

analyticsRouter.get('/by-model', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: { message: 'Authentication required' } });
    return;
  }

  try {
    const range = (req.query.range as string) ?? '7d';
    const since = getSinceTimestamp(range);
    const requests = await getUserRequests(user.userId, 10000);
    const filtered = requests.filter(r => new Date(r.created_at) >= since);

    const byModel = new Map<string, any>();
    
    for (const r of filtered) {
      const key = `${r.platform}:${r.model_id}`;
      if (!byModel.has(key)) {
        byModel.set(key, {
          platform: r.platform,
          model_id: r.model_id,
          display_name: r.model_id,
          requests: 0,
          success_count: 0,
          total_latency_ms: 0,
          latency_count: 0,
          total_input_tokens: 0,
          total_output_tokens: 0,
          pinned_requests: 0,
          total_cost: 0,
        });
      }
      const stats = byModel.get(key);
      stats.requests++;
      if (r.status === 'success') stats.success_count++;
      if (r.latency_ms > 0) {
        stats.total_latency_ms += r.latency_ms;
        stats.latency_count++;
      }
      stats.total_input_tokens += r.input_tokens || 0;
      stats.total_output_tokens += r.output_tokens || 0;
      if (r.requested_model === r.model_id) stats.pinned_requests++;
      if (r.status === 'success') {
        stats.total_cost += (r.input_tokens * FALLBACK_INPUT_PER_M / 1000000) + (r.output_tokens * FALLBACK_OUTPUT_PER_M / 1000000);
      }
    }

    const result = Array.from(byModel.values()).map(r => ({
      platform: r.platform,
      modelId: r.model_id,
      displayName: r.display_name,
      requests: r.requests,
      successRate: r.requests > 0 ? Math.round((r.success_count / r.requests) * 1000) / 10 : 0,
      avgLatencyMs: r.latency_count > 0 ? Math.round(r.total_latency_ms / r.latency_count) : 0,
      totalInputTokens: r.total_input_tokens,
      totalOutputTokens: r.total_output_tokens,
      pinnedRequests: r.pinned_requests,
      estimatedCost: Math.round(r.total_cost * 100) / 100,
    })).sort((a, b) => b.requests - a.requests);

    res.json(result);
  } catch (error) {
    console.error('Error fetching analytics by model:', error);
    res.status(500).json({ error: { message: 'Failed to fetch analytics by model' } });
  }
});

analyticsRouter.get('/by-platform', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: { message: 'Authentication required' } });
    return;
  }

  try {
    const range = (req.query.range as string) ?? '7d';
    const since = getSinceTimestamp(range);
    const requests = await getUserRequests(user.userId, 10000);
    const filtered = requests.filter(r => new Date(r.created_at) >= since);

    const byPlatform = new Map<string, any>();
    
    for (const r of filtered) {
      if (!byPlatform.has(r.platform)) {
        byPlatform.set(r.platform, {
          platform: r.platform,
          requests: 0,
          success_count: 0,
          total_latency_ms: 0,
          latency_count: 0,
          total_input_tokens: 0,
          total_output_tokens: 0,
        });
      }
      const stats = byPlatform.get(r.platform);
      stats.requests++;
      if (r.status === 'success') stats.success_count++;
      if (r.latency_ms > 0) {
        stats.total_latency_ms += r.latency_ms;
        stats.latency_count++;
      }
      stats.total_input_tokens += r.input_tokens || 0;
      stats.total_output_tokens += r.output_tokens || 0;
    }

    const result = Array.from(byPlatform.values()).map(r => ({
      platform: r.platform,
      requests: r.requests,
      successRate: r.requests > 0 ? Math.round((r.success_count / r.requests) * 1000) / 10 : 0,
      avgLatencyMs: r.latency_count > 0 ? Math.round(r.total_latency_ms / r.latency_count) : 0,
      totalInputTokens: r.total_input_tokens,
      totalOutputTokens: r.total_output_tokens,
    })).sort((a, b) => b.requests - a.requests);

    res.json(result);
  } catch (error) {
    console.error('Error fetching analytics by platform:', error);
    res.status(500).json({ error: { message: 'Failed to fetch analytics by platform' } });
  }
});

analyticsRouter.get('/timeline', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: { message: 'Authentication required' } });
    return;
  }

  try {
    const range = (req.query.range as string) ?? '7d';
    const interval = (req.query.interval as string) ?? (range === '24h' ? 'hour' : 'day');
    const since = getSinceTimestamp(range);
    const requests = await getUserRequests(user.userId, 10000);
    const filtered = requests.filter(r => new Date(r.created_at) >= since);

    const timeline = new Map<string, any>();
    
    for (const r of filtered) {
      const date = new Date(r.created_at);
      let key: string;
      if (interval === 'hour') {
        key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:00:00`;
      } else {
        key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      }
      
      if (!timeline.has(key)) {
        timeline.set(key, { timestamp: key, requests: 0, success_count: 0, failure_count: 0 });
      }
      const stats = timeline.get(key);
      stats.requests++;
      if (r.status === 'success') stats.success_count++;
      else if (r.status === 'error') stats.failure_count++;
    }

    const result = Array.from(timeline.values()).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    res.json(result);
  } catch (error) {
    console.error('Error fetching analytics timeline:', error);
    res.status(500).json({ error: { message: 'Failed to fetch analytics timeline' } });
  }
});

analyticsRouter.get('/error-distribution', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: { message: 'Authentication required' } });
    return;
  }

  try {
    const range = (req.query.range as string) ?? '7d';
    const since = getSinceTimestamp(range);
    const requests = await getUserRequests(user.userId, 10000);
    const filtered = requests.filter(r => new Date(r.created_at) >= since && r.status === 'error');

    const byCategory = new Map<string, number>();
    const byPlatform = new Map<string, number>();
    const detailed = new Map<string, any>();

    function categorizeError(error: string | null): string {
      if (!error) return 'Other';
      const e = error.toLowerCase();
      if (e.includes('429') || e.includes('rate limit') || e.includes('too many') || e.includes('quota')) return 'Rate Limited (429)';
      if (e.includes('401') || e.includes('unauthorized') || e.includes('invalid')) return 'Auth Error (401)';
      if (e.includes('403') || e.includes('forbidden')) return 'Forbidden (403)';
      if (e.includes('404') || e.includes('not found')) return 'Not Found (404)';
      if (e.includes('timeout') || e.includes('etimedout') || e.includes('econnrefused')) return 'Timeout/Connection';
      if (e.includes('500') || e.includes('internal server')) return 'Server Error (500)';
      if (e.includes('503') || e.includes('unavailable')) return 'Unavailable (503)';
      return 'Other';
    }

    for (const r of filtered) {
      const category = categorizeError(r.error);
      byCategory.set(category, (byCategory.get(category) || 0) + 1);
      byPlatform.set(r.platform, (byPlatform.get(r.platform) || 0) + 1);
      
      const key = `${r.platform}:${r.model_id}:${category}`;
      if (!detailed.has(key)) {
        detailed.set(key, { platform: r.platform, model_id: r.model_id, error_category: category, count: 0 });
      }
      detailed.get(key).count++;
    }

    res.json({
      byCategory: Array.from(byCategory.entries()).map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
      byPlatform: Array.from(byPlatform.entries()).map(([platform, count]) => ({ platform, count })).sort((a, b) => b.count - a.count),
      detailed: Array.from(detailed.values()).sort((a, b) => b.count - a.count),
    });
  } catch (error) {
    console.error('Error fetching error distribution:', error);
    res.status(500).json({ error: { message: 'Failed to fetch error distribution' } });
  }
});

analyticsRouter.get('/errors', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: { message: 'Authentication required' } });
    return;
  }

  try {
    const range = (req.query.range as string) ?? '7d';
    const since = getSinceTimestamp(range);
    const requests = await getUserRequests(user.userId, 10000);
    const filtered = requests.filter(r => new Date(r.created_at) >= since && r.status === 'error');

    const result = filtered.slice(0, 50).map(r => ({
      id: r.id,
      platform: r.platform,
      modelId: r.model_id,
      error: r.error,
      latencyMs: r.latency_ms,
      createdAt: r.created_at,
    }));

    res.json(result);
  } catch (error) {
    console.error('Error fetching errors:', error);
    res.status(500).json({ error: { message: 'Failed to fetch errors' } });
  }
});
