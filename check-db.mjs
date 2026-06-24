import Database from 'better-sqlite3';
import path from 'path';

const dbPath = 'server/data/freeapi.db';
const db = new Database(dbPath);

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log('Tables:', tables.map(t => t.name));

console.log('\n=== USERS ===');
const users = db.prepare('SELECT id, email, LENGTH(password_hash) as hash_len, SUBSTR(password_hash, 1, 30) as hash_preview FROM users').all();
console.log('Count:', users.length);
users.forEach(u => console.log('  ', JSON.stringify(u)));

console.log('\n=== SESSIONS ===');
const sessions = db.prepare('SELECT COUNT(*) as c FROM sessions').get();
console.log('Count:', sessions.c);

console.log('\n=== SETTINGS (relevant) ===');
const settings = db.prepare("SELECT key, SUBSTR(value, 1, 30) as val FROM settings WHERE key IN ('unified_api_key', 'encryption_key')").all();
settings.forEach(s => console.log('  ', JSON.stringify(s)));

db.close();
