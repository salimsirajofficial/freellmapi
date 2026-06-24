/**
 * End-to-end production validation against live Supabase.
 * Exercises signup, login, JWT, profile, API keys, settings, analytics, models.
 * Creates a fresh throwaway user and cleans it up at the end.
 *
 * Usage: node scripts/e2e-validation.mjs
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Apply the same alias normalization env.ts does.
if (!process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_PUBLISHABLE_KEY)
  process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
if (!process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SUPABASE_SECRET_KEY)
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY;

// Simulate the Render Node-20 runtime (no native WebSocket).
Object.defineProperty(globalThis, 'WebSocket', { value: undefined, configurable: true });

const crypto = await import('crypto');
const sb = await import('../dist/lib/supabase.js');
const q = await import('../dist/db/supabase-queries.js');
const auth = await import('../dist/services/auth-supabase.js');
const cryptoLib = await import('../dist/lib/crypto.js');

cryptoLib.initEncryptionKey();

let pass = 0, fail = 0;
const ok = (n, extra = '') => { console.log(`  PASS  ${n}${extra ? ' — ' + extra : ''}`); pass++; };
const bad = (n, e) => { console.log(`  FAIL  ${n} — ${e}`); fail++; };

const email = `e2e-${Date.now()}@gmail.com`;
const password = 'E2eValidate123!';
let userId = null;
let token = null;

console.log('\n=== E2E PRODUCTION VALIDATION (simulated Node 20, live Supabase) ===\n');
console.log('Test user:', email, '\n');

try {
  // 1. Signup
  const signup = await auth.signUp(email, password);
  userId = signup.user.userId;
  token = signup.session;
  ok('1. User signup', `userId=${userId}`);
} catch (e) { bad('1. User signup', e.message); }

try {
  // 2. Login
  const login = await auth.signIn(email, password);
  token = login.session;
  ok('2. User login', `token=${token.slice(0, 16)}…`);
} catch (e) { bad('2. User login', e.message); }

try {
  // 3. JWT validation
  const u = await auth.getUser(token);
  if (u && u.userId === userId) ok('3. JWT validation', `email=${u.email}`);
  else bad('3. JWT validation', 'token did not resolve to the user');
} catch (e) { bad('3. JWT validation', e.message); }

try {
  // 4. Protected-route gate (invalid token must be rejected)
  const u = await auth.getUser('invalid.token.value');
  if (!u) ok('4. Protected route rejects bad JWT');
  else bad('4. Protected route rejects bad JWT', 'bad token resolved to a user');
} catch (e) { bad('4. Protected route rejects bad JWT', e.message); }

try {
  // 5. Profile creation (handle_new_user trigger)
  await new Promise(r => setTimeout(r, 1200));
  const { data: profile, error } = await sb.supabaseAdmin
    .from('profiles').select('id, email').eq('id', userId).maybeSingle();
  if (error) bad('5. Profile creation', error.message);
  else if (profile) ok('5. Profile creation', `profiles.email=${profile.email}`);
  else bad('5. Profile creation', 'no profile row (trigger missing?)');
} catch (e) { bad('5. Profile creation', e.message); }

try {
  // 6. API key creation (encrypt + insert + decrypt round-trip)
  const { encrypted, iv, authTag } = cryptoLib.encrypt('sk-test-secret-value');
  const key = await q.insertApiKey({
    user_id: userId, platform: 'groq', label: 'e2e',
    encrypted_key: encrypted, iv, auth_tag: authTag, status: 'unknown', enabled: 1,
  });
  const back = await q.getUserApiKeys(userId);
  const dec = cryptoLib.decrypt(key.encrypted_key, key.iv, key.auth_tag);
  if (back.length === 1 && dec === 'sk-test-secret-value')
    ok('6. API key creation', 'stored + decrypted round-trip OK');
  else bad('6. API key creation', `keys=${back.length} dec=${dec}`);
} catch (e) { bad('6. API key creation', e.message); }

try {
  // 6b. Fallback enrollment on key add
  const enrolled = await q.enrollPlatformModelsInFallback(userId, 'groq');
  const chain = await q.getFallbackChain(userId);
  ok('6b. Fallback config enrollment', `enrolled=${enrolled}, chain=${chain.length}`);
} catch (e) { bad('6b. Fallback config enrollment', e.message); }

try {
  // 7. Settings storage
  const val = 'freellmapi-' + crypto.randomBytes(8).toString('hex');
  await q.setUserSetting(userId, 'unified_api_key', val);
  const read = await q.getUserSetting(userId, 'unified_api_key');
  const lookup = await q.findUserIdByUnifiedApiKey(val);
  if (read === val && lookup === userId) ok('7. Settings storage', 'write/read/lookup OK');
  else bad('7. Settings storage', `read=${read} lookup=${lookup}`);
} catch (e) { bad('7. Settings storage', e.message); }

try {
  // 8. Analytics storage
  await q.insertRequest({
    user_id: userId, platform: 'groq', model_id: 'llama-3.3-70b-versatile',
    status: 'success', input_tokens: 10, output_tokens: 20, latency_ms: 123,
    request_type: 'chat',
  });
  const reqs = await q.getUserRequests(userId, 10);
  if (reqs.length >= 1) ok('8. Analytics storage', `requests=${reqs.length}`);
  else bad('8. Analytics storage', 'no request rows');
} catch (e) { bad('8. Analytics storage', e.message); }

try {
  // 9. Models loading
  const models = await q.getAllModels();
  if (models.length > 0) ok('9. Models loading', `models=${models.length}`);
  else bad('9. Models loading', 'models table empty');
} catch (e) { bad('9. Models loading', e.message); }

// Cleanup
try {
  if (userId) {
    await sb.supabaseAdmin.from('requests').delete().eq('user_id', userId);
    await sb.supabaseAdmin.from('settings').delete().eq('user_id', userId);
    await sb.supabaseAdmin.from('fallback_config').delete().eq('user_id', userId);
    await sb.supabaseAdmin.from('api_keys').delete().eq('user_id', userId);
    await sb.supabaseAdmin.auth.admin.deleteUser(userId);
    console.log('\n  (cleanup) removed test user and all its rows');
  }
} catch (e) { console.log('\n  (cleanup) warning:', e.message); }

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
