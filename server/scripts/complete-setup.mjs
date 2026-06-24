/**
 * Post-migration setup: verify schema, seed models, smoke-test auth.
 * Usage: node scripts/complete-setup.mjs
 */
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;

if (!url || !serviceKey) {
  console.error('Missing SUPABASE_URL or server key (SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEY)');
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function ok(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); }

console.log('\n=== FreeLLMAPI Supabase Setup ===\n');

// ── 1. Schema check ──
console.log('1. Checking database schema...');
const checks = [
  { table: 'profiles', column: 'id' },
  { table: 'models', column: 'supports_tools' },
  { table: 'requests', column: 'request_type' },
  { table: 'embedding_models', column: 'id' },
];

let schemaOk = true;
for (const { table, column } of checks) {
  const { error } = await admin.from(table).select(column).limit(1);
  if (error) {
    fail(`${table}.${column} — ${error.message}`);
    schemaOk = false;
  } else {
    ok(`${table}.${column}`);
  }
}

if (!schemaOk) {
  console.error('\nSchema incomplete. Run this in Supabase SQL Editor:');
  console.error('  supabase/migrations/002_schema_extensions.sql');
  console.error('\n(If you only ran 001, you still need 002.)\n');
  process.exit(1);
}

// ── 2. Seed models ──
console.log('\n2. Seeding models catalog...');
const { count: modelCount, error: countError } = await admin
  .from('models')
  .select('*', { count: 'exact', head: true });

if (countError) {
  fail(`models count failed: ${countError.message}`);
  process.exit(1);
}

if ((modelCount ?? 0) > 0) {
  ok(`models already seeded (${modelCount} rows)`);
} else {
  const modelsPath = path.join(__dirname, '../src/db/seed-data/full-models.json');
  const embeddingsPath = path.join(__dirname, '../src/db/seed-data/full-embedding-models.json');

  if (!fs.existsSync(modelsPath)) {
    fail('Seed file missing: server/src/db/seed-data/full-models.json');
    process.exit(1);
  }

  const models = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
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
    const { error } = await admin.from('models').insert(batch);
    if (error) {
      fail(`models insert failed: ${error.message}`);
      process.exit(1);
    }
  }
  ok(`seeded ${models.length} models`);

  if (fs.existsSync(embeddingsPath)) {
    const embeddings = JSON.parse(fs.readFileSync(embeddingsPath, 'utf8'));
    if (embeddings.length > 0) {
      const { error } = await admin.from('embedding_models').insert(embeddings.map(e => ({
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
      if (error) {
        fail(`embedding_models insert failed: ${error.message}`);
      } else {
        ok(`seeded ${embeddings.length} embedding models`);
      }
    }
  }
}

// ── 3. Auth + profile smoke test ──
console.log('\n3. Testing auth + profile trigger...');
const testEmail = `setup-${Date.now()}@gmail.com`;
const testPassword = 'SetupTest123!';

const { data: created, error: createError } = await admin.auth.admin.createUser({
  email: testEmail,
  password: testPassword,
  email_confirm: true,
});

if (createError) {
  fail(`admin.createUser failed: ${createError.message}`);
  process.exit(1);
}

const userId = created.user.id;
ok(`created test user ${userId}`);

await new Promise(r => setTimeout(r, 1500));

const { data: profile, error: profileError } = await admin
  .from('profiles')
  .select('id, email')
  .eq('id', userId)
  .maybeSingle();

if (profileError) {
  fail(`profiles query failed: ${profileError.message}`);
} else if (!profile) {
  fail('profile row missing — handle_new_user() trigger may not be installed');
} else {
  ok(`profile row created for ${profile.email}`);
}

const testKey = 'freellmapi-' + crypto.randomBytes(16).toString('hex');
const { error: settingsError } = await admin
  .from('settings')
  .upsert({ user_id: userId, key: 'unified_api_key', value: testKey }, { onConflict: 'user_id,key' });

if (settingsError) {
  fail(`settings upsert failed: ${settingsError.message}`);
} else {
  ok('settings write OK');
}

await admin.auth.admin.deleteUser(userId);
ok('cleaned up test user');

console.log('\n=== Setup complete ===');
console.log('Start the server:  cd server && npm run dev');
console.log('Open the dashboard and use POST /api/auth/setup to create your account.\n');
