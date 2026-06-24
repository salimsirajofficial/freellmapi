/**
 * Live HTTP E2E auth test against the running server.
 * Tests the full registration -> login -> protected route -> logout -> re-login flow.
 */

const BASE_URL = 'http://127.0.0.1:3001';
const TEST_EMAIL = `e2etest_${Date.now()}@example.com`;
const TEST_PASSWORD = 'TestPass123!';

async function api(method, path, body, token) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  
  const data = await res.json().catch(() => null);
  return { status: res.status, body: data };
}

async function run() {
  console.log('\n========================================');
  console.log('LIVE HTTP AUTH E2E TEST');
  console.log('========================================\n');
  console.log(`Server: ${BASE_URL}`);
  console.log(`Test email: ${TEST_EMAIL}\n`);

  // ---- Step 1: Check server reachability ----
  console.log('[1] Checking server...');
  const ping = await api('GET', '/api/ping').catch(e => ({ status: 0, body: { error: e.message } }));
  console.log('    /api/ping:', ping.status, JSON.stringify(ping.body));
  if (ping.status !== 200) {
    console.error('    ✗ Server not reachable! Is it running?');
    return;
  }
  console.log('    ✓ Server is running\n');

  // ---- Step 2: Check status (needsSetup?) ----
  console.log('[2] Auth status...');
  const status = await api('GET', '/api/auth/status');
  console.log('    /api/auth/status:', status.status, JSON.stringify(status.body));
  const needsSetup = status.body?.needsSetup;
  console.log('    needsSetup:', needsSetup, '\n');

  // ---- Step 3: Setup or attempt login ----
  let token = null;

  if (needsSetup) {
    console.log('[3] Running /setup (first-time account creation)...');
    const setup = await api('POST', '/api/auth/setup', { email: TEST_EMAIL, password: TEST_PASSWORD });
    console.log('    Response status:', setup.status);
    console.log('    Response body:', JSON.stringify(setup.body));
    
    if (setup.status === 201 && setup.body?.token) {
      token = setup.body.token;
      console.log('    ✓ Setup succeeded, got token:', token.substring(0, 20) + '...');
    } else {
      console.error('    ✗ Setup failed!');
    }
  } else {
    console.log('[3] Account already exists, skipping setup.');
    console.log('    Note: Will try login only (no fresh registration possible)\n');
  }

  console.log();

  // ---- Step 4: Verify status now shows authenticated ----
  console.log('[4] Status after setup...');
  const status2 = await api('GET', '/api/auth/status', null, token);
  console.log('    /api/auth/status:', status2.status, JSON.stringify(status2.body));
  if (token && !status2.body?.authenticated) {
    console.error('    ✗ Status should show authenticated after setup!');
  } else if (token) {
    console.log('    ✓ Authenticated confirmed\n');
  }

  // ---- Step 5: Access protected route ----
  if (token) {
    console.log('[5] Accessing protected route /api/keys...');
    const keys = await api('GET', '/api/keys', null, token);
    console.log('    /api/keys status:', keys.status);
    if (keys.status === 200) {
      console.log('    ✓ Protected route accessible\n');
    } else {
      console.error('    ✗ Protected route blocked!', JSON.stringify(keys.body));
    }
  }

  // ---- Step 6: Logout ----
  if (token) {
    console.log('[6] Logout...');
    const logout = await api('POST', '/api/auth/logout', {}, token);
    console.log('    /api/auth/logout:', logout.status, JSON.stringify(logout.body));
    
    // Verify token is invalidated
    const postLogout = await api('GET', '/api/keys', null, token);
    if (postLogout.status === 401) {
      console.log('    ✓ Token invalidated after logout\n');
    } else {
      console.error('    ✗ Token still valid after logout! Status:', postLogout.status);
    }
  }

  // ---- Step 7: LOGIN after setup (the critical test) ----
  console.log('[7] LOGIN with same credentials used in setup...');
  const loginPayload = { email: TEST_EMAIL, password: TEST_PASSWORD };
  console.log('    Payload:', JSON.stringify({ ...loginPayload, password: '***' }));
  const login = await api('POST', '/api/auth/login', loginPayload);
  console.log('    /api/auth/login status:', login.status);
  console.log('    /api/auth/login body:', JSON.stringify(login.body));
  
  if (login.status === 200 && login.body?.token) {
    const loginToken = login.body.token;
    console.log('    ✓ LOGIN SUCCEEDED! Token:', loginToken.substring(0, 20) + '...\n');
    
    // ---- Step 8: Verify login token works ----
    console.log('[8] Verify login token works on protected route...');
    const protected2 = await api('GET', '/api/keys', null, loginToken);
    console.log('    /api/keys status:', protected2.status);
    if (protected2.status === 200) {
      console.log('    ✓ Login token works on protected routes\n');
    } else {
      console.error('    ✗ Login token REJECTED on protected route!', JSON.stringify(protected2.body));
    }
    
    // ---- Step 9: Second login (re-login) ----
    console.log('[9] Second login (re-login)...');
    const login2 = await api('POST', '/api/auth/login', loginPayload);
    console.log('    /api/auth/login status:', login2.status, login2.body?.token ? '✓' : '✗');
    
  } else if (login.status === 401) {
    console.error('\n    ✗ LOGIN FAILED WITH 401!');
    console.error('    This is the reported bug: registered user cannot log in');
    console.error('    Error body:', JSON.stringify(login.body));
    
    // Diagnostics
    console.log('\n    [DIAGNOSTICS] Checking if user exists in DB...');
    console.log('    Please check server logs for [AUTH] messages near this timestamp.');
    
  } else if (login.status === 429) {
    console.error('\n    ✗ RATE LIMITED! Multiple failed attempts counted as failures');
    console.error('    This means verifyCredentials is returning null even for valid credentials');
  } else {
    console.error('\n    ✗ UNEXPECTED STATUS:', login.status, JSON.stringify(login.body));
  }

  console.log('\n========================================');
  console.log('E2E TEST COMPLETE');
  console.log('========================================\n');
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
