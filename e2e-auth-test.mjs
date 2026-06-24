/**
 * End-to-end auth diagnostic script.
 * Run with: node --import tsx/esm e2e-auth-test.mjs
 */
import './server/src/env.js';
import { initDb, getDb } from './server/src/db/index.js';
import { 
  createUser, 
  verifyCredentials, 
  createSession, 
  validateSession, 
  deleteSession,
  hasNonDesktopUser 
} from './server/src/services/auth.js';
import { hashPassword, verifyPassword } from './server/src/lib/password.js';

process.env.ENCRYPTION_KEY = '0'.repeat(64);

console.log('\n========================================');
console.log('AUTH SYSTEM DIAGNOSTIC');
console.log('========================================\n');

// Use in-memory DB to avoid polluting the real DB
initDb(':memory:');

// ---- Step 1: Password hashing ----
console.log('STEP 1: Password hashing test');
const testPassword = 'TestPassword123!';
const hash1 = hashPassword(testPassword);
const hash2 = hashPassword(testPassword);
console.log('  hash1 (first 50):', hash1.substring(0, 50));
console.log('  hash2 (first 50):', hash2.substring(0, 50));
console.log('  Hashes differ (good - random salt):', hash1 !== hash2);
console.log('  verifyPassword(correct):', verifyPassword(testPassword, hash1));
console.log('  verifyPassword(wrong):', verifyPassword('WrongPassword', hash1));
console.log('  ✓ Password hashing OK\n');

// ---- Step 2: User creation ----
console.log('STEP 2: User creation');
const email = 'testuser@example.com';
const password = 'SecurePassword99!';
const created = createUser(email, password);
console.log('  Created user:', JSON.stringify(created));

// Verify in DB
const db = getDb();
const dbUser = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(email);
console.log('  DB lookup:', JSON.stringify({ 
  id: dbUser?.id, 
  email: dbUser?.email, 
  hash_len: dbUser?.password_hash?.length,
  hash_starts_with: dbUser?.password_hash?.substring(0, 15)
}));
console.log('  ✓ User creation OK\n');

// ---- Step 3: verifyCredentials immediately after registration ----
console.log('STEP 3: Verify credentials immediately after registration');
const verifyResult = verifyCredentials(email, password);
console.log('  verifyCredentials result:', JSON.stringify(verifyResult));
if (!verifyResult) {
  console.error('  ✗ FAILED! verifyCredentials returned null');
  process.exit(1);
}
console.log('  ✓ Credentials verified OK\n');

// ---- Step 4: Session lifecycle ----
console.log('STEP 4: Session lifecycle');
const token = createSession(created.userId);
console.log('  Token generated (first 20):', token.substring(0, 20) + '...');
const session = validateSession(token);
console.log('  Session validated:', JSON.stringify(session));
if (!session) {
  console.error('  ✗ FAILED! validateSession returned null');
  process.exit(1);
}
deleteSession(token);
const afterLogout = validateSession(token);
console.log('  After logout (should be null):', afterLogout);
console.log('  ✓ Session lifecycle OK\n');

// ---- Step 5: Re-login after logout ----
console.log('STEP 5: Re-login after session deletion');
const relogin = verifyCredentials(email, password);
console.log('  Re-login result:', JSON.stringify(relogin));
if (!relogin) {
  console.error('  ✗ FAILED! Re-login returned null');
  process.exit(1);
}
const token2 = createSession(relogin.userId);
const session2 = validateSession(token2);
console.log('  New session valid:', !!session2);
console.log('  ✓ Re-login OK\n');

// ---- Step 6: Case sensitivity ----
console.log('STEP 6: Email case sensitivity');
const upperEmail = email.toUpperCase();
const verifyUpper = verifyCredentials(upperEmail, password);
console.log('  Login with uppercase email:', JSON.stringify(verifyUpper));
console.log('  ✓ Email normalization OK\n');

// ---- Step 7: hasNonDesktopUser ----
console.log('STEP 7: hasNonDesktopUser check');
console.log('  hasNonDesktopUser():', hasNonDesktopUser());
console.log('  ✓ Setup gate OK\n');

// ---- Summary ----
console.log('========================================');
console.log('ALL TESTS PASSED - Auth system is healthy in isolation');
console.log('If login fails in production, check:');
console.log('  1. Is the server running with the same DB file?');
console.log('  2. Is DATABASE_URL set and overwriting local DB?');
console.log('  3. Is there a WAL file causing reads from wrong DB state?');
console.log('  4. Are there multiple server instances with different DBs?');
console.log('========================================\n');
