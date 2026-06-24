import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// FREEAPI_ENV_PATH lets embedders (e.g. the desktop app, where __dirname sits
// inside a bundle) point at an explicit .env — or at nothing: dotenv silently
// no-ops on a missing file either way. On Render the variables come from the
// service environment, so a missing .env file is expected and fine.
dotenv.config({ path: process.env.FREEAPI_ENV_PATH ?? path.resolve(__dirname, '../../.env') });

// ── Supabase key aliases ────────────────────────────────────────────────────
// Supabase's newer dashboard issues `sb_publishable_…` / `sb_secret_…` keys
// under the names SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY, while older
// projects use the legacy SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY JWTs.
// Normalize either naming scheme to the canonical names the app reads, so both
// continue to work.
if (!process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_PUBLISHABLE_KEY) {
  process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
}
if (!process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SUPABASE_SECRET_KEY) {
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY;
}

// ── Required-variable validation ────────────────────────────────────────────
// Fail fast at boot with a single, clear message listing everything that is
// missing, instead of crashing deep inside a client constructor later.
const missing: string[] = [];
if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
if (!process.env.SUPABASE_ANON_KEY) missing.push('SUPABASE_ANON_KEY (or SUPABASE_PUBLISHABLE_KEY)');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY)');
if (!process.env.ENCRYPTION_KEY) missing.push('ENCRYPTION_KEY');

if (missing.length > 0) {
  console.error(
    '\n[server] Cannot start — missing required environment variables:\n' +
      missing.map(m => `  - ${m}`).join('\n') +
      '\n\nSet these in your Render service environment (Dashboard → Environment),' +
      '\nor in a local .env file for development.\n',
  );
  process.exit(1);
}
