-- FreeLLMAPI Supabase Migration
-- This replaces the entire SQLite database with Supabase PostgreSQL

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- PROFILES TABLE (User profiles linked to Supabase Auth)
-- ============================================================================
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- MODELS TABLE (Global model definitions - no user isolation needed)
-- ============================================================================
CREATE TABLE IF NOT EXISTS models (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  platform TEXT NOT NULL,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  intelligence_rank INTEGER NOT NULL,
  speed_rank INTEGER NOT NULL,
  size_label TEXT NOT NULL DEFAULT '',
  rpm_limit INTEGER,
  rpd_limit INTEGER,
  tpm_limit INTEGER,
  tpd_limit INTEGER,
  monthly_token_budget TEXT NOT NULL DEFAULT '',
  context_window INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  supports_vision INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(platform, model_id)
);

-- ============================================================================
-- API KEYS TABLE (User-specific - requires user_id)
-- ============================================================================
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  encrypted_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  enabled INTEGER NOT NULL DEFAULT 1,
  base_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_checked_at TIMESTAMP WITH TIME ZONE
);

-- ============================================================================
-- REQUESTS TABLE (User-specific analytics - requires user_id)
-- ============================================================================
CREATE TABLE IF NOT EXISTS requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  model_id TEXT NOT NULL,
  key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  ttfb_ms INTEGER,
  requested_model TEXT,
  error TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- RATE LIMIT USAGE TABLE (User-specific - requires user_id)
-- ============================================================================
CREATE TABLE IF NOT EXISTS rate_limit_usage (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  model_id TEXT NOT NULL,
  key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('request', 'tokens')),
  tokens INTEGER NOT NULL DEFAULT 0,
  created_at_ms BIGINT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- RATE LIMIT COOLDOWNS TABLE (User-specific - requires user_id)
-- ============================================================================
CREATE TABLE IF NOT EXISTS rate_limit_cooldowns (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  model_id TEXT NOT NULL,
  key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  expires_at_ms BIGINT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (user_id, platform, model_id, key_id)
);

-- ============================================================================
-- FALLBACK CONFIG TABLE (User-specific - requires user_id)
-- ============================================================================
CREATE TABLE IF NOT EXISTS fallback_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  model_id UUID NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, model_id)
);

-- ============================================================================
-- SETTINGS TABLE (User-specific - requires user_id)
-- ============================================================================
CREATE TABLE IF NOT EXISTS settings (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (user_id, key)
);

-- ============================================================================
-- INDEXES
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_platform ON api_keys(platform);
CREATE INDEX IF NOT EXISTS idx_requests_user_id ON requests(user_id);
CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at);
CREATE INDEX IF NOT EXISTS idx_requests_platform ON requests(platform);
CREATE INDEX IF NOT EXISTS idx_requests_key_id ON requests(key_id);
CREATE INDEX IF NOT EXISTS idx_rate_limit_usage_user_id ON rate_limit_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_rate_limit_usage_lookup ON rate_limit_usage(user_id, platform, model_id, key_id, kind, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_rate_limit_cooldowns_user_id ON rate_limit_cooldowns(user_id);
CREATE INDEX IF NOT EXISTS idx_rate_limit_cooldowns_expires ON rate_limit_cooldowns(expires_at_ms);
CREATE INDEX IF NOT EXISTS idx_fallback_config_user_id ON fallback_config(user_id);
CREATE INDEX IF NOT EXISTS idx_settings_user_id ON settings(user_id);

-- ============================================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================================

-- Enable RLS on all tables
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE models ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_cooldowns ENABLE ROW LEVEL SECURITY;
ALTER TABLE fallback_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- RLS POLICIES
-- ============================================================================

-- Profiles: Users can only access their own profile
CREATE POLICY "Users can view own profile" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Users can insert own profile" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);

-- Models: Public read access (global configuration)
CREATE POLICY "Allow public read on models" ON models FOR SELECT USING (true);

-- API Keys: Users can only access their own keys
CREATE POLICY "Users can view own api_keys" ON api_keys FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own api_keys" ON api_keys FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own api_keys" ON api_keys FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own api_keys" ON api_keys FOR DELETE USING (auth.uid() = user_id);

-- Requests: Users can only access their own requests
CREATE POLICY "Users can view own requests" ON requests FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own requests" ON requests FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Rate Limit Usage: Users can only access their own usage
CREATE POLICY "Users can view own rate_limit_usage" ON rate_limit_usage FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own rate_limit_usage" ON rate_limit_usage FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Rate Limit Cooldowns: Users can only access their own cooldowns
CREATE POLICY "Users can view own rate_limit_cooldowns" ON rate_limit_cooldowns FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own rate_limit_cooldowns" ON rate_limit_cooldowns FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own rate_limit_cooldowns" ON rate_limit_cooldowns FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own rate_limit_cooldowns" ON rate_limit_cooldowns FOR DELETE USING (auth.uid() = user_id);

-- Fallback Config: Users can only access their own config
CREATE POLICY "Users can view own fallback_config" ON fallback_config FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own fallback_config" ON fallback_config FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own fallback_config" ON fallback_config FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own fallback_config" ON fallback_config FOR DELETE USING (auth.uid() = user_id);

-- Settings: Users can only access their own settings
CREATE POLICY "Users can view own settings" ON settings FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own settings" ON settings FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own settings" ON settings FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own settings" ON settings FOR DELETE USING (auth.uid() = user_id);

-- ============================================================================
-- TRIGGERS FOR UPDATED_AT
-- ============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_models_updated_at BEFORE UPDATE ON models
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_settings_updated_at BEFORE UPDATE ON settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- TRIGGER TO CREATE PROFILE ON USER SIGNUP
-- ============================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================================
-- SCHEMA EXTENSIONS (formerly 002_schema_extensions.sql)
-- ============================================================================
ALTER TABLE models ADD COLUMN IF NOT EXISTS supports_tools INTEGER NOT NULL DEFAULT 0;
ALTER TABLE models ADD COLUMN IF NOT EXISTS key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL;

ALTER TABLE requests ADD COLUMN IF NOT EXISTS request_type TEXT NOT NULL DEFAULT 'chat';

CREATE TABLE IF NOT EXISTS embedding_models (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  family TEXT NOT NULL,
  platform TEXT NOT NULL,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  max_input_tokens INTEGER,
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  quota_label TEXT NOT NULL DEFAULT '',
  UNIQUE(platform, model_id)
);

ALTER TABLE embedding_models ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read on embedding_models" ON embedding_models FOR SELECT USING (true);

CREATE INDEX IF NOT EXISTS idx_embedding_models_family ON embedding_models(family);
CREATE INDEX IF NOT EXISTS idx_models_key_id ON models(key_id);
