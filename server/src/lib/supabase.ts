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

// ── Realtime is intentionally disabled ──────────────────────────────────────
// This server only uses Supabase for Auth and PostgREST database access; it
// never opens Realtime channels. supabase-js still constructs a RealtimeClient
// eagerly in its constructor, and on Node < 22 (e.g. the node:20 Render image)
// that constructor throws "Node.js 20 detected without native WebSocket
// support" because no global WebSocket exists. Supplying a no-op transport
// short-circuits that WebSocket lookup so the client builds on any Node
// version. Since we never call `.channel()`, this socket never connects; it is
// a harmless stub even if instantiated.
class NoopRealtimeTransport {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = NoopRealtimeTransport.CLOSED;
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev?: unknown) => void) | null = null;

  constructor(_url?: string, _protocols?: string | string[]) {
    /* Realtime disabled: this socket never connects. */
  }

  send(): void {}
  close(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

const realtimeDisabled = {
  transport: NoopRealtimeTransport as unknown as never,
} as const;

/** Client for Supabase Auth (signUp, signIn, getUser with user JWT). */
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
  realtime: realtimeDisabled,
});

/** Service-role client for all server-side database operations (bypasses RLS). */
export const supabaseAdmin: SupabaseClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
  realtime: realtimeDisabled,
});

/** Returns the service-role client for backend queries. */
export function getSupabaseAdmin(): SupabaseClient {
  return supabaseAdmin;
}
