import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey =
  process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY;
const supabaseServiceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing required Supabase environment variables: SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_PUBLISHABLE_KEY)',
  );
}

if (!supabaseServiceRoleKey) {
  throw new Error(
    'Missing required Supabase environment variable: SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY)',
  );
}

/** Client for Supabase Auth (signUp, signIn, getUser with user JWT). */
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

/** Service-role client for all server-side database operations (bypasses RLS). */
export const supabaseAdmin: SupabaseClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

/** Returns the service-role client for backend queries. */
export function getSupabaseAdmin(): SupabaseClient {
  return supabaseAdmin;
}
