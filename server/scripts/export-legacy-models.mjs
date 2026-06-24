import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const serverRoot = path.resolve(import.meta.dirname, '..');
const gitRoot = path.resolve(serverRoot, '..');
const exportDir = path.join(serverRoot, 'tmp-export');
const outDir = path.join(serverRoot, 'src', 'db', 'seed-data');

fs.rmSync(exportDir, { recursive: true, force: true });
fs.mkdirSync(path.join(exportDir, 'db'), { recursive: true });
fs.mkdirSync(path.join(exportDir, 'lib'), { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(path.join(exportDir, 'db', 'index.ts'), execSync('git show HEAD:server/src/db/index.ts', { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, cwd: gitRoot }));
fs.writeFileSync(path.join(exportDir, 'db', 'model-pricing.ts'), execSync('git show HEAD:server/src/db/model-pricing.ts', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, cwd: gitRoot }));
fs.writeFileSync(path.join(exportDir, 'db', 'postgres-sync.ts'), 'export function startPostgresSync() {}');
fs.writeFileSync(path.join(exportDir, 'lib', 'crypto.ts'), execSync('git show HEAD:server/src/lib/crypto.ts', { encoding: 'utf8', cwd: gitRoot }));
fs.writeFileSync(path.join(exportDir, 'lib', 'budget.ts'), `export function parseBudget(s: string): number {
  const m = String(s ?? '').match(/([0-9.]+)M/);
  return m ? Number(m[1]) * 1e6 : 0;
}`);

fs.writeFileSync(path.join(exportDir, 'export.mjs'), `
import { initDb, getDb } from './db/index.js';
import fs from 'fs';
import path from 'path';
initDb(':memory:');
const db = getDb();
const models = db.prepare(\`
  SELECT platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
         rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
         enabled, supports_vision, supports_tools
  FROM models
\`).all();
const embeddings = db.prepare(\`
  SELECT family, platform, model_id, display_name, dimensions, max_input_tokens, priority, enabled, quota_label
  FROM embedding_models
\`).all();
const outDir = ${JSON.stringify(outDir)};
fs.writeFileSync(path.join(outDir, 'full-models.json'), JSON.stringify(models, null, 2));
fs.writeFileSync(path.join(outDir, 'full-embedding-models.json'), JSON.stringify(embeddings, null, 2));
console.log('exported', models.length, 'models,', embeddings.length, 'embeddings');
`);

execSync(`npx tsx "${path.join(exportDir, 'export.mjs')}"`, {
  stdio: 'inherit',
  cwd: serverRoot,
  env: { ...process.env, ENCRYPTION_KEY: 'a'.repeat(64), NODE_ENV: 'development' },
});

fs.rmSync(exportDir, { recursive: true, force: true });
