import { getApiKeyById, updateApiKey, getUserApiKeys } from '../db/supabase-queries.js';
import { resolveProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import type { Platform, KeyStatus } from '@freellmapi/shared/types.js';

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const CONSECUTIVE_FAILURES_TO_DISABLE = 3;

const failureCount = new Map<string, number>();

export async function checkKeyHealth(keyId: string): Promise<KeyStatus> {
  const row = await getApiKeyById(keyId);
  if (!row) return 'error';

  const provider = resolveProvider(row.platform as Platform, row.base_url);
  if (!provider) return 'error';

  try {
    const apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
    const isValid = await provider.validateKey(apiKey);
    const status: KeyStatus = isValid ? 'healthy' : 'invalid';

    await updateApiKey(keyId, { status, last_checked_at: new Date().toISOString() });

    if (isValid) {
      failureCount.delete(keyId);
    } else {
      const count = (failureCount.get(keyId) ?? 0) + 1;
      failureCount.set(keyId, count);
      if (count >= CONSECUTIVE_FAILURES_TO_DISABLE) {
        await updateApiKey(keyId, { enabled: 0 });
        console.log(`[Health] Auto-disabled key ${keyId} after ${count} consecutive failures`);
      }
    }

    return status;
  } catch (err: any) {
    console.error(`[Health] Key ${keyId} transport error:`, err.message);
    await updateApiKey(keyId, { status: 'error', last_checked_at: new Date().toISOString() });
    return 'error';
  }
}

export async function checkAllKeys(userId: string): Promise<void> {
  const keys = await getUserApiKeys(userId);
  const enabledKeys = keys.filter(k => k.enabled === 1);
  console.log(`[Health] Checking ${enabledKeys.length} keys...`);
  for (const key of enabledKeys) {
    await checkKeyHealth(key.id);
  }
  console.log('[Health] Check complete.');
}

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startHealthChecker(userId: string): void {
  if (intervalId) return;
  console.log(`[Health] Starting health checker (every ${CHECK_INTERVAL_MS / 1000}s)`);
  intervalId = setInterval(() => {
    checkAllKeys(userId).catch(err => console.error('[Health] Check failed:', err));
  }, CHECK_INTERVAL_MS);
}

export function stopHealthChecker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
