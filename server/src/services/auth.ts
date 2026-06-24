import crypto from 'crypto';
import { getDb } from '../db/index.js';
import { hashPassword, verifyPassword } from '../lib/password.js';

// Dashboard authentication: email + password accounts with opaque session
// tokens. Distinct from the unified API key, which authenticates the /v1 proxy
// for apps — this gates the /api/* admin surface for the human operator (#35).

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface SessionUser {
  userId: number;
  email: string;
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function userCount(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
  return row.c;
}

export function hasNonDesktopUser(): boolean {
  const row = getDb().prepare("SELECT 1 FROM users WHERE email != 'desktop@localhost' LIMIT 1").get();
  return !!row;
}

/** Create a user. Throws { code: 'email_taken' } if the email already exists. */
export function createUser(email: string, password: string): SessionUser {
  const db = getDb();
  const normalized = normalizeEmail(email);
  console.log('[AUTH] createUser called with email:', normalized);
  
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalized);
  if (existing) {
    console.log('[AUTH] Email already exists:', normalized);
    const err = new Error('An account with that email already exists') as any;
    err.code = 'email_taken';
    throw err;
  }
  
  const passwordHash = hashPassword(password);
  console.log('[AUTH] Password hashed successfully, length:', passwordHash.length);
  
  const result = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
    .run(normalized, passwordHash);
  
  console.log('[AUTH] User created successfully with ID:', result.lastInsertRowid);
  
  // Verify the user was actually inserted
  const verify = db.prepare('SELECT id, email, password_hash FROM users WHERE id = ?').get(result.lastInsertRowid);
  console.log('[AUTH] Verification query result:', verify ? 'User found in DB' : 'User NOT found in DB');
  
  return { userId: Number(result.lastInsertRowid), email: normalized };
}

/** Verify credentials. Returns the user on success, null on failure. */
export function verifyCredentials(email: string, password: string): SessionUser | null {
  const db = getDb();
  const normalized = normalizeEmail(email);
  console.log('[AUTH] verifyCredentials called with email:', normalized);
  
  const row = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?')
    .get(normalized) as { id: number; email: string; password_hash: string } | undefined;
  
  if (!row) {
    console.log('[AUTH] User not found in database for email:', normalized);
    return null;
  }
  
  console.log('[AUTH] User found in database, ID:', row.id, 'email:', row.email);
  console.log('[AUTH] Password hash exists in DB, length:', row.password_hash.length);
  
  const passwordValid = verifyPassword(password, row.password_hash);
  console.log('[AUTH] Password verification result:', passwordValid);
  
  if (!passwordValid) {
    console.log('[AUTH] Password verification failed for email:', normalized);
    return null;
  }
  
  console.log('[AUTH] Credentials verified successfully for email:', normalized);
  return { userId: row.id, email: row.email };
}

/** Mint a session and return the raw token (only the hash is persisted). */
export function createSession(userId: number): string {
  const token = crypto.randomBytes(32).toString('hex');
  console.log('[AUTH] Creating session for user ID:', userId);
  getDb().prepare('INSERT INTO sessions (token_hash, user_id, expires_at_ms) VALUES (?, ?, ?)')
    .run(sha256(token), userId, Date.now() + SESSION_TTL_MS);
  console.log('[AUTH] Session created successfully');
  return token;
}

/** Resolve a session token to its user, or null if missing/expired. */
export function validateSession(token: string | undefined | null): SessionUser | null {
  if (!token) {
    console.log('[AUTH] validateSession called with no token');
    return null;
  }
  const db = getDb();
  const row = db.prepare(`
    SELECT s.user_id, s.expires_at_ms, u.email
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(sha256(token)) as { user_id: number; expires_at_ms: number; email: string } | undefined;
  if (!row) {
    console.log('[AUTH] Session not found in database');
    return null;
  }
  if (row.expires_at_ms < Date.now()) {
    console.log('[AUTH] Session expired, deleting');
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    return null;
  }
  console.log('[AUTH] Session validated successfully for user:', row.email);
  return { userId: row.user_id, email: row.email };
}

export function deleteSession(token: string | undefined | null): void {
  if (!token) return;
  getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}
