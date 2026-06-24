-- Schema extensions for full Supabase migration

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
