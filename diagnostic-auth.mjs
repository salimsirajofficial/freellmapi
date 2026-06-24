/**
 * Comprehensive auth diagnostic test covering edge cases that could cause login failures.
 * Run with: npx tsx diagnostic-auth.mjs
 */
import './server/src/env.js';

process.env.ENCRYPTION_KEY = '0'.repeat(64);

import { initDb, getDb } from './server/src/db/index.js';
import { 
  createUser, 
  verifyCredentials, 
  createSession, 
  validateSession, 
  deleteSession,
  hasNonDesktopUser,
  userCount
} from './server/src/services/auth.js';
import { hashPassword, verifyPassword } from './server/src/lib/password.js';

const PASS = 'TestPassword99!';
const EMAIL = 'admin@test.com';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result === false) {
      console.error(`  ✗ FAIL: ${name}`);
      failed++;
    } else {
      console.log(`  ✓ PASS: ${name}`);
      passed++;
    }
  } catch (e) {
    console.error(`  ✗ FAIL: ${name}`, e.message);
    failed++;
  }
}

function asyncTest(name, fn) {
  return fn().then(result => {
    if (result === false) {
      console.error(`  ✗ FAIL: ${name}`);
      failed++;
    } else {
      console.log(`  ✓ PASS: ${name}`);
      passed++;
    }
  }).catch(e => {
    console.error(`  ✗ FAIL: ${name}`, e.message);
    failed++;
  });
}

async function runTests() {
  // ---- Setup: fresh in-memory DB ----
  initDb(':memory:');
  const db = getDb();
  
  console.log('\n=== SECTION 1: Password Hashing ===');
  test('scrypt hash format is correct', () => {
    const hash = hashPassword(PASS);
    return hash.startsWith('scrypt$') && hash.split('$').length === 3;
  });
  test('hash length is 168 chars', () => hashPassword(PASS).length === 168);
  test('same password produces different hashes (random salt)', () => {
    const h1 = hashPassword(PASS);
    const h2 = hashPassword(PASS);
    return h1 !== h2;
  });
  test('verifyPassword returns true for correct password', () => {
    const hash = hashPassword(PASS);
    return verifyPassword(PASS, hash) === true;
  });
  test('verifyPassword returns false for wrong password', () => {
    const hash = hashPassword(PASS);
    return verifyPassword('wrong', hash) === false;
  });
  test('verifyPassword returns false for empty string', () => {
    const hash = hashPassword(PASS);
    return verifyPassword('', hash) === false;
  });
  test('verifyPassword returns false for invalid hash format', () => {
    return verifyPassword(PASS, 'notahash') === false;
  });
  test('verifyPassword returns false for partial hash', () => {
    return verifyPassword(PASS, 'scrypt$onlytwoparts') === false;
  });
  test('verifyPassword is case-sensitive for password', () => {
    const hash = hashPassword('password');
    return verifyPassword('Password', hash) === false;
  });

  console.log('\n=== SECTION 2: User Creation ===');
  test('userCount starts at 0', () => userCount() === 0);
  test('hasNonDesktopUser returns false when empty', () => hasNonDesktopUser() === false);
  
  const user = createUser(EMAIL, PASS);
  test('createUser returns userId and email', () => user.userId > 0 && user.email === EMAIL);
  test('userCount is 1 after creation', () => userCount() === 1);
  test('hasNonDesktopUser returns true', () => hasNonDesktopUser() === true);
  
  const dbUser = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(EMAIL);
  test('user exists in DB', () => !!dbUser);
  test('DB email is lowercase normalized', () => dbUser?.email === EMAIL.toLowerCase());
  test('DB password_hash starts with scrypt$', () => dbUser?.password_hash?.startsWith('scrypt$'));
  test('DB password_hash has correct format', () => dbUser?.password_hash?.split('$').length === 3);
  test('DB password_hash verifies correctly', () => verifyPassword(PASS, dbUser?.password_hash));
  
  test('duplicate email throws error', () => {
    try {
      createUser(EMAIL, PASS);
      return false; // should have thrown
    } catch (e) {
      return e.code === 'email_taken';
    }
  });
  
  console.log('\n=== SECTION 3: Email Normalization ===');
  const EMAIL_UPPER = EMAIL.toUpperCase();
  const EMAIL_SPACES = `  ${EMAIL}  `;
  const EMAIL_MIXED = 'Admin@Test.Com';
  
  test('registration normalizes uppercase email', () => {
    const u2 = createUser(`DIFFERENT_${EMAIL_UPPER}`, PASS);
    const stored = db.prepare('SELECT email FROM users WHERE id = ?').get(u2.userId);
    return stored?.email === `different_${EMAIL}`;
  });
  
  console.log('\n=== SECTION 4: Credential Verification ===');
  const v1 = verifyCredentials(EMAIL, PASS);
  test('verifyCredentials returns user for correct creds', () => v1?.email === EMAIL);
  
  const v2 = verifyCredentials(EMAIL, 'wrongpassword');
  test('verifyCredentials returns null for wrong password', () => v2 === null);
  
  const v3 = verifyCredentials('nonexistent@test.com', PASS);
  test('verifyCredentials returns null for nonexistent user', () => v3 === null);
  
  // Case-insensitive email lookup
  const v4 = verifyCredentials(EMAIL.toUpperCase(), PASS);
  test('verifyCredentials accepts uppercase email', () => v4?.email === EMAIL);
  
  const v5 = verifyCredentials(EMAIL.toLowerCase(), PASS);
  test('verifyCredentials accepts lowercase email', () => v5?.email === EMAIL);
  
  // Empty creds
  const v6 = verifyCredentials('', PASS);
  test('verifyCredentials returns null for empty email', () => v6 === null);
  
  const v7 = verifyCredentials(EMAIL, '');
  test('verifyCredentials returns null for empty password', () => v7 === null);

  console.log('\n=== SECTION 5: Session Management ===');
  const token = createSession(user.userId);
  test('token is 64-char hex string', () => /^[0-9a-f]{64}$/.test(token));
  
  const session = validateSession(token);
  test('session is valid immediately after creation', () => session?.userId === user.userId);
  test('session has correct email', () => session?.email === EMAIL);
  
  test('validateSession returns null for null token', () => validateSession(null) === null);
  test('validateSession returns null for undefined', () => validateSession(undefined) === null);
  test('validateSession returns null for empty string', () => validateSession('') === null);
  test('validateSession returns null for garbage token', () => validateSession('notarealtoken') === null);
  
  deleteSession(token);
  const afterDelete = validateSession(token);
  test('session is invalid after deletion', () => afterDelete === null);
  
  // Create another session and verify it works
  const token2 = createSession(user.userId);
  test('new session can be created after logout', () => !!token2);
  const session2 = validateSession(token2);
  test('new session is valid', () => session2?.userId === user.userId);
  
  console.log('\n=== SECTION 6: Session Expiry ===');
  // Insert an expired session directly
  const expiredToken = 'aaaa'.repeat(16);
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at_ms) VALUES (?, ?, ?)').run(
    require('crypto').createHash('sha256').update(expiredToken).digest('hex'),
    user.userId,
    Date.now() - 1000 // already expired
  );
  const expiredSession = validateSession(expiredToken);
  test('expired session returns null', () => expiredSession === null);
  
  const expiredInDb = db.prepare('SELECT COUNT(*) as c FROM sessions WHERE expires_at_ms < ?').get(Date.now());
  test('expired session is cleaned up from DB', () => expiredInDb?.c === 0);

  console.log('\n=== SECTION 7: Full Registration → Login Flow ===');
  const flowEmail = 'flow@test.com';
  const flowPass = 'FlowTestPwd1!';
  
  // Simulate setup
  const flowUser = createUser(flowEmail, flowPass);
  const setupToken = createSession(flowUser.userId);
  test('setup: user created and session token issued', () => !!setupToken);
  
  // Simulate logout
  deleteSession(setupToken);
  test('logout: session invalidated', () => validateSession(setupToken) === null);
  
  // Simulate login
  const loginResult = verifyCredentials(flowEmail, flowPass);
  test('login: credentials verify after logout', () => loginResult?.email === flowEmail);
  
  const loginToken = createSession(loginResult.userId);
  const loginSession = validateSession(loginToken);
  test('login: new session is valid', () => loginSession?.email === flowEmail);
  
  // Access protected resource (simulated as session validation)
  test('login token works on protected routes', () => validateSession(loginToken) !== null);
  
  // Re-login
  const loginResult2 = verifyCredentials(flowEmail, flowPass);
  test('re-login: second login works', () => loginResult2?.email === flowEmail);

  console.log('\n=== SECTION 8: Desktop User Special Case ===');
  db.prepare("INSERT INTO users (email, password_hash) VALUES ('desktop@localhost', 'fakehash')").run();
  test('hasNonDesktopUser returns true with real + desktop user', () => hasNonDesktopUser() === true);
  
  // Create a fresh DB with only desktop user
  const db2 = initDb(':memory:');
  db2.prepare("INSERT INTO users (email, password_hash) VALUES ('desktop@localhost', 'fakehash')").run();
  test('hasNonDesktopUser returns false with only desktop user', () => hasNonDesktopUser() === false);

  // ---- Summary ----
  console.log('\n========================================');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('✓ AUTH SYSTEM IS FULLY FUNCTIONAL');
  } else {
    console.error(`✗ ${failed} TEST(S) FAILED - Auth system has issues`);
  }
  console.log('========================================\n');
  
  if (failed > 0) process.exit(1);
}

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

runTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
