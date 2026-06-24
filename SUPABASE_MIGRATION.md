# Supabase Migration — Complete

The FreeLLMAPI **server** backend is now Supabase-only. SQLite, hybrid database logic, and custom password/session auth have been removed from the server package.

## Architecture

| Layer | Technology |
|-------|------------|
| API | Express (Node.js) |
| Database | Supabase PostgreSQL |
| Auth | Supabase Auth (`signUp`, `signInWithPassword`, `signOut`, `getUser`) |
| Server DB access | Service-role client (`SUPABASE_SERVICE_ROLE_KEY`) — bypasses RLS for trusted backend operations |
| User isolation | RLS on all user tables; backend filters by `user_id` |

## Environment Variables

```env
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
ENCRYPTION_KEY=
PORT=
```

## Database Setup

1. Run `supabase/migrations/001_initial_schema.sql` in the Supabase SQL editor (includes all schema extensions)
2. **If you already ran 001 before the merge**, also run `supabase/migrations/002_schema_extensions.sql`
3. Run setup: `cd server && node scripts/complete-setup.mjs` (seeds models + smoke-tests auth)
4. On first server boot, `seedModelsIfEmpty()` also loads models if the table is still empty

## Auth Flow

1. **Setup** (`POST /api/auth/setup`) — creates a pre-confirmed user via admin API, then signs in (no email verification)
2. **Login** (`POST /api/auth/login`) — `supabase.auth.signInWithPassword()`; emails normalized to lowercase
3. **Protected routes** — `requireAuth` validates JWT via `supabase.auth.getUser(token)`
4. **Proxy** (`/v1/*`) — unified API key looked up in `settings` table (`findUserIdByUnifiedApiKey`)

## Root Cause of Prior Auth Failures

1. **Anon client + RLS** — `supabase-queries.ts` used the anon key without a user JWT, so writes failed silently under RLS
2. **Missing service role** — backend now requires `SUPABASE_SERVICE_ROLE_KEY`
3. **Email case sensitivity** — signup/login now trim and lowercase emails
4. **`hasNonDesktopUser()` bug** — called `supabase.auth.admin` on the anon client; now uses `supabaseAdmin`

## Deleted / Removed

- `server/src/db/index.ts` (SQLite)
- `server/src/services/auth.ts` (custom scrypt auth)
- `server/src/db/postgres-sync.ts`
- `server/src/db/model-pricing.ts`
- `server/src/lib/password.ts`
- `diagnostic-auth.mjs`, `e2e-auth-test.mjs`, `check-db.mjs`
- `server/src/scripts/routing-sim.ts`, `test-all-models.ts`
- Dependencies: `better-sqlite3`, `drizzle-orm`, `drizzle-kit`, `pg`

## Remaining Work

- **Tests** (`server/src/__tests__/`) still reference SQLite — need Supabase test harness or mocks
- **Desktop app** (`desktop/`) still bundles SQLite separately — out of server migration scope
- **Client** timestamp helpers (`formatSqliteUtcToLocalTime`) work with ISO timestamps from Supabase

## Security (RLS)

All tables have RLS enabled. User tables enforce `auth.uid() = user_id`. `models` and `embedding_models` allow public read. Backend uses service role and always passes explicit `user_id`.
