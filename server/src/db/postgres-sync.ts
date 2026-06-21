import pg from 'pg';
import zlib from 'zlib';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../data/freeapi.db');

let lastBackupTime = 0;
let backupInFlight: Promise<void> | null = null;
let backupQueued = false;

export async function restoreDbFromPostgres(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log('[postgres-sync] DATABASE_URL is not set. Running with local SQLite database only.');
    lastBackupTime = Date.now();
    return;
  }

  console.log('[postgres-sync] Connecting to Supabase Postgres to restore database...');
  const client = new Client({
    connectionString: dbUrl,
    ssl: dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1') ? false : { rejectUnauthorized: false }
  });

  try {
    await client.connect();

    // Create backup table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS sqlite_backup (
        id INTEGER PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
      );
    `);

    // Fetch the backup row
    const res = await client.query('SELECT data, updated_at FROM sqlite_backup WHERE id = 1');
    if (res.rows.length > 0) {
      const postgresUpdatedAt = new Date(res.rows[0].updated_at).getTime();
      const localMtime = getSqliteMtime();
      if (localMtime > postgresUpdatedAt) {
        console.log('[postgres-sync] Local SQLite database is newer than the Postgres backup. Skipping restore.');
        lastBackupTime = localMtime;
        return;
      }

      console.log('[postgres-sync] Found SQLite backup in Supabase Postgres. Restoring...');
      const base64Data = res.rows[0].data;
      const compressedBuffer = Buffer.from(base64Data, 'base64');
      const decompressed = zlib.gunzipSync(compressedBuffer);

      // Make sure the data directory exists
      const dataDir = path.dirname(DB_PATH);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      // Replace the whole SQLite store. Stale WAL/SHM files from a previous
      // local DB can otherwise replay over the restored main file on open.
      for (const suffix of ['', '-wal', '-shm']) {
        const file = `${DB_PATH}${suffix}`;
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
      fs.writeFileSync(DB_PATH, decompressed);
      lastBackupTime = fs.statSync(DB_PATH).mtimeMs;
      console.log(`[postgres-sync] Database successfully restored to ${DB_PATH}`);
    } else {
      console.log('[postgres-sync] No SQLite backup found in Supabase Postgres (id = 1). Starting with a fresh database.');
      lastBackupTime = 0; // Trigger backup of the newly seeded database immediately
    }
  } catch (err: any) {
    console.error('[postgres-sync] ERROR restoring database from Postgres:', err?.message || err);
    // Crashing on boot is safer if DATABASE_URL is configured but fails, to prevent overwriting the DB
    throw err;
  } finally {
    await client.end();
  }
}

function getSqliteMtime(): number {
  let maxMtime = 0;

  if (fs.existsSync(DB_PATH)) {
    maxMtime = Math.max(maxMtime, fs.statSync(DB_PATH).mtimeMs);
  }

  const walPath = `${DB_PATH}-wal`;
  if (fs.existsSync(walPath)) {
    maxMtime = Math.max(maxMtime, fs.statSync(walPath).mtimeMs);
  }

  return maxMtime;
}

async function uploadSqliteBackup(db: Database.Database, reason: string, force = false): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return;

  const maxMtime = getSqliteMtime();
  if (!force && maxMtime <= lastBackupTime) return;

  console.log(`[postgres-sync] Database backup requested (${reason}). Preparing backup...`);

  const tempBackupPath = `${DB_PATH}.backup-tmp`;
  if (fs.existsSync(tempBackupPath)) {
    fs.unlinkSync(tempBackupPath);
  }

  await db.backup(tempBackupPath);

  try {
    const fileData = fs.readFileSync(tempBackupPath);
    const compressed = zlib.gzipSync(fileData);
    const base64Data = compressed.toString('base64');

    const client = new Client({
      connectionString: dbUrl,
      ssl: dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1') ? false : { rejectUnauthorized: false }
    });

    await client.connect();
    try {
      await client.query(`
        INSERT INTO sqlite_backup (id, data, updated_at)
        VALUES (1, $1, NOW())
        ON CONFLICT (id) DO UPDATE
        SET data = EXCLUDED.data, updated_at = NOW();
      `, [base64Data]);
    } finally {
      await client.end();
    }

    lastBackupTime = Math.max(maxMtime, getSqliteMtime());
    console.log(`[postgres-sync] SQLite database successfully backed up to Supabase Postgres. size: ${(fileData.length / 1024).toFixed(1)} KB (compressed: ${(compressed.length / 1024).toFixed(1)} KB)`);
  } finally {
    if (fs.existsSync(tempBackupPath)) {
      fs.unlinkSync(tempBackupPath);
    }
  }
}

export async function backupDbToPostgres(db: Database.Database, reason = 'manual', force = true): Promise<void> {
  if (!process.env.DATABASE_URL) return;

  if (backupInFlight) {
    backupQueued = true;
    await backupInFlight;
    if (!backupQueued) return;
  }

  backupQueued = false;
  backupInFlight = uploadSqliteBackup(db, reason, force).finally(() => {
    backupInFlight = null;
  });
  await backupInFlight;

  if (backupQueued) {
    await backupDbToPostgres(db, `${reason}:queued`, true);
  }
}

export function startPostgresSync(db: Database.Database): void {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return;

  const checkInterval = 15000; // Check every 15 seconds

  console.log('[postgres-sync] Background backup sync started (checking every 15s).');

  setInterval(async () => {
    try {
      await backupDbToPostgres(db, 'interval', false);
    } catch (err: any) {
      console.error('[postgres-sync] Background backup error:', err?.message || err);
    }
  }, checkInterval);
}
