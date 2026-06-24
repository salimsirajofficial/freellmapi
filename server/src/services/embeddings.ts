import {
  getAllEmbeddingModels,
  getEmbeddingModelsByFamily,
  getEnabledApiKeysByPlatform,
  getUserSetting,
  insertRequest,
  type EmbeddingModel,
} from '../db/supabase-queries.js';
import { decrypt } from '../lib/crypto.js';

export type EmbeddingModelRow = EmbeddingModel;

export interface EmbeddingsResult {
  family: string;
  platform: string;
  modelId: string;
  dimensions: number;
  vectors: number[][];
  inputTokens: number;
}

export class EmbeddingsError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function listEmbeddingModels(): Promise<EmbeddingModelRow[]> {
  return getAllEmbeddingModels();
}

export async function getDefaultFamily(userId: string): Promise<string> {
  return (await getUserSetting(userId, 'embeddings_default_family')) ?? 'gemini-embedding-001';
}

export async function resolveFamily(userId: string, model: string | undefined): Promise<string | null> {
  if (!model || model === 'auto') return getDefaultFamily(userId);
  const rows = await listEmbeddingModels();
  if (rows.some(r => r.family === model)) return model;
  const byModelId = rows.find(r => r.model_id === model);
  return byModelId?.family ?? null;
}

async function getPlatformKey(userId: string, platform: string): Promise<string | null> {
  const keys = await getEnabledApiKeysByPlatform(userId, platform);
  const row = keys[0];
  if (!row) return null;
  try {
    return decrypt(row.encrypted_key, row.iv, row.auth_tag);
  } catch {
    return null;
  }
}

function estimateTokens(inputs: string[]): number {
  return Math.ceil(inputs.reduce((n, s) => n + s.length, 0) / 4);
}

const FETCH_TIMEOUT_MS = 30_000;

interface ProviderCallResult {
  vectors: number[][];
  inputTokens: number | null;
}

async function openAiStyleEmbed(
  url: string,
  key: string,
  modelId: string,
  inputs: string[],
  extra: Record<string, unknown> = {},
): Promise<ProviderCallResult> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: modelId, input: inputs, ...extra }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!r.ok) {
    throw new EmbeddingsError(`upstream ${r.status}: ${(await r.text()).slice(0, 200)}`, r.status);
  }
  const j = (await r.json()) as {
    data?: { index?: number; embedding: number[] }[];
    usage?: { prompt_tokens?: number; total_tokens?: number };
  };
  const data = [...(j.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return {
    vectors: data.map(d => d.embedding),
    inputTokens: j.usage?.prompt_tokens ?? j.usage?.total_tokens ?? null,
  };
}

async function callProvider(row: EmbeddingModelRow, key: string, inputs: string[]): Promise<ProviderCallResult> {
  switch (row.platform) {
    case 'google':
      return openAiStyleEmbed('https://generativelanguage.googleapis.com/v1beta/openai/embeddings', key, row.model_id, inputs);
    case 'nvidia':
      return openAiStyleEmbed('https://integrate.api.nvidia.com/v1/embeddings', key, row.model_id, inputs, { input_type: 'query' });
    case 'openrouter':
      return openAiStyleEmbed('https://openrouter.ai/api/v1/embeddings', key, row.model_id, inputs);
    case 'github':
      return openAiStyleEmbed('https://models.github.ai/inference/embeddings', key, row.model_id, inputs);
    case 'cloudflare': {
      const sep = key.indexOf(':');
      if (sep === -1) throw new EmbeddingsError('cloudflare key is not in account_id:token form', 500);
      const accountId = key.slice(0, sep);
      const token = key.slice(sep + 1);
      return openAiStyleEmbed(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/embeddings`, token, row.model_id, inputs);
    }
    case 'huggingface': {
      const r = await fetch(
        `https://router.huggingface.co/hf-inference/models/${row.model_id}/pipeline/feature-extraction`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ inputs }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        },
      );
      if (!r.ok) throw new EmbeddingsError(`upstream ${r.status}: ${(await r.text()).slice(0, 200)}`, r.status);
      const j = (await r.json()) as number[][] | number[];
      const vectors = Array.isArray(j[0]) ? (j as number[][]) : [j as number[]];
      return { vectors, inputTokens: null };
    }
    case 'cohere': {
      const r = await fetch('https://api.cohere.com/v2/embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: row.model_id, texts: inputs, input_type: 'search_document', embedding_types: ['float'] }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!r.ok) throw new EmbeddingsError(`upstream ${r.status}: ${(await r.text()).slice(0, 200)}`, r.status);
      const j = (await r.json()) as { embeddings?: { float?: number[][] }; meta?: { billed_units?: { input_tokens?: number } } };
      return { vectors: j.embeddings?.float ?? [], inputTokens: j.meta?.billed_units?.input_tokens ?? null };
    }
    default:
      throw new EmbeddingsError(`no embeddings adapter for platform '${row.platform}'`, 500);
  }
}

async function logEmbeddingRequest(
  userId: string,
  row: EmbeddingModelRow,
  status: 'success' | 'error',
  inputTokens: number,
  latencyMs: number,
  error: string | null,
): Promise<void> {
  try {
    await insertRequest({
      user_id: userId,
      platform: row.platform,
      model_id: row.model_id,
      key_id: null,
      status,
      input_tokens: inputTokens,
      output_tokens: 0,
      latency_ms: latencyMs,
      error,
      request_type: 'embedding',
    });
  } catch (e) {
    console.error('Failed to log embedding request:', e);
  }
}

export async function runEmbeddings(userId: string, model: string | undefined, inputs: string[]): Promise<EmbeddingsResult> {
  const family = await resolveFamily(userId, model);
  if (!family) {
    throw new EmbeddingsError(`Unknown embedding model '${model}'. Use 'auto', a family name, or a provider model id.`, 400);
  }

  const chain = await getEmbeddingModelsByFamily(family);
  if (chain.length === 0) {
    throw new EmbeddingsError(`No enabled providers for embedding family '${family}'.`, 503);
  }

  let lastError: EmbeddingsError | null = null;
  for (const row of chain) {
    const key = await getPlatformKey(userId, row.platform);
    if (!key) continue;
    const started = Date.now();
    try {
      const out = await callProvider(row, key, inputs);
      if (out.vectors.length !== inputs.length || out.vectors.some(v => !Array.isArray(v) || v.length === 0)) {
        throw new EmbeddingsError('upstream returned malformed embeddings', 502);
      }
      const tokens = out.inputTokens ?? estimateTokens(inputs);
      await logEmbeddingRequest(userId, row, 'success', tokens, Date.now() - started, null);
      return {
        family,
        platform: row.platform,
        modelId: row.model_id,
        dimensions: out.vectors[0].length,
        vectors: out.vectors,
        inputTokens: tokens,
      };
    } catch (err: any) {
      const e = err instanceof EmbeddingsError ? err : new EmbeddingsError(String(err?.message ?? err), 502);
      await logEmbeddingRequest(userId, row, 'error', 0, Date.now() - started, e.message.slice(0, 300));
      lastError = e;
    }
  }

  throw new EmbeddingsError(
    `All providers for embedding family '${family}' failed${lastError ? ` (last: ${lastError.message.slice(0, 160)})` : ' (no usable keys)'}.`,
    lastError && lastError.status === 429 ? 429 : 502,
  );
}
