/**
 * Create a test account and verify it exists in Supabase (auth + profiles).
 * Usage: node scripts/verify-supabase-auth.mjs
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;

if (!url || !anonKey || !serviceKey) {
  console.error(
    'Missing SUPABASE_URL and client key (SUPABASE_ANON_KEY or SUPABASE_PUBLISHABLE_KEY) and server key (SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY) in .env',
  );
  process.exit(1);
}

const testEmail = `verify-${Date.now()}@gmail.com`;
const testPassword = 'VerifyTest123!';

const anon = createClient(url, anonKey);
const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function ok(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); }

console.log('\n=== Supabase Auth Verification ===\n');
console.log(`Test email: ${testEmail}`);
console.log(`Test password: ${testPassword}\n`);

// ── 1. Sign up via anon client (same path as /api/auth/setup) ──
console.log('1. Creating account via supabase.auth.signUp...');
let signUpData = null;
let userId = null;

const { data: anonSignUp, error: signUpError } = await anon.auth.signUp({
  email: testEmail,
  password: testPassword,
});

if (signUpError) {
  console.log(`  signUp via anon client: ${signUpError.message}`);
  if (signUpError.message.includes('already registered')) {
    console.log('  (User may already exist — trying signIn instead)');
  } else if (signUpError.message.includes('rate limit') || signUpError.message.includes('invalid')) {
    console.log('  Falling back to admin.createUser (bypasses signup rate limits)...');
    const { data: adminCreated, error: adminError } = await admin.auth.admin.createUser({
      email: testEmail,
      password: testPassword,
      email_confirm: true,
    });
    if (adminError) {
      fail(`admin.createUser failed: ${adminError.message}`);
      process.exit(1);
    }
    signUpData = { user: adminCreated.user, session: null };
    userId = adminCreated.user.id;
    ok(`admin.createUser succeeded — userId=${userId}`);
  } else {
    fail(`signUp failed: ${signUpError.message}`);
    process.exit(1);
  }
} else if (!anonSignUp.user) {
  fail('signUp returned no user');
  process.exit(1);
} else {
  signUpData = anonSignUp;
  userId = anonSignUp.user.id;
  ok(`signUp succeeded — userId=${userId}`);
  if (!anonSignUp.session) {
    console.log('  ⚠ No session returned (email confirmation may be required in Supabase dashboard)');
    console.log('    Fix: Authentication → Providers → Email → disable "Confirm email"');
  } else {
    ok(`session token received (${anonSignUp.session.access_token.slice(0, 20)}...)`);
  }
}

// ── 2. Verify user in auth.users (admin API) ──
console.log('\n2. Checking auth.users via admin API...');
const { data: listData, error: listError } = await admin.auth.admin.listUsers({ perPage: 200 });
if (listError) {
  fail(`listUsers failed: ${listError.message}`);
} else {
  const found = listData.users.find(u => u.email === testEmail);
  if (found) {
    ok(`User found in auth.users — id=${found.id}, email=${found.email}`);
    ok(`email_confirmed_at: ${found.email_confirmed_at ?? 'null (confirmation pending)'}`);
  } else {
    fail(`User NOT found in auth.users for ${testEmail}`);
  }
}

// ── 3. Verify profile row ──
console.log('\n3. Checking profiles table...');
if (userId) {
  // Wait briefly for trigger
  await new Promise(r => setTimeout(r, 1500));
  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (profileError) {
    fail(`profiles query failed: ${profileError.message}`);
  } else if (!profile) {
    fail('No profile row — handle_new_user() trigger may not be installed');
    console.log('  Run supabase/migrations/001_initial_schema.sql in Supabase SQL editor');
  } else {
    ok(`Profile exists — id=${profile.id}, email=${profile.email}`);
  }
}

// ── 4. Sign in with same credentials ──
console.log('\n4. Testing signInWithPassword (same credentials)...');
const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({
  email: testEmail,
  password: testPassword,
});

if (signInError) {
  fail(`signIn failed: ${signInError.message}`);
  if (signInError.message.includes('Email not confirmed')) {
    console.log('\n  → ROOT CAUSE: Supabase requires email confirmation.');
    console.log('    Dashboard: Authentication → Providers → Email → turn OFF "Confirm email"');
    console.log('    Or confirm the user manually in Authentication → Users');
  }
} else {
  ok(`signIn succeeded — userId=${signInData.user.id}`);
  ok(`access token received`);
}

// ── 5. Test settings write (simulates unified API key storage) ──
console.log('\n5. Testing settings table write...');
if (signInData?.user?.id || userId) {
  const uid = signInData?.user?.id ?? userId;
  const testKey = 'freellmapi-' + crypto.randomBytes(16).toString('hex');
  const { error: settingsError } = await admin
    .from('settings')
    .upsert({ user_id: uid, key: 'unified_api_key', value: testKey }, { onConflict: 'user_id,key' });

  if (settingsError) {
    fail(`settings upsert failed: ${settingsError.message}`);
  } else {
    const { data: setting } = await admin
      .from('settings')
      .select('value')
      .eq('user_id', uid)
      .eq('key', 'unified_api_key')
      .single();
    if (setting?.value === testKey) {
      ok(`settings row stored and read back correctly`);
    } else {
      fail('settings row not found after write');
    }
  }
}

// ── 6. Check models seeded ──
console.log('\n6. Checking models catalog...');
const { count, error: modelsError } = await admin
  .from('models')
  .select('*', { count: 'exact', head: true });

if (modelsError) {
  fail(`models query failed: ${modelsError.message}`);
} else {
  ok(`models table has ${count ?? 0} rows`);
  if ((count ?? 0) === 0) {
    console.log('  ⚠ Run server once to auto-seed, or apply seed SQL manually');
  }
}

// ── Summary ──
console.log('\n=== Summary ===');
console.log(`Email:    ${testEmail}`);
console.log(`Password: ${testPassword}`);
console.log('\nTo clean up, delete this user in Supabase Dashboard → Authentication → Users');
console.log('');
