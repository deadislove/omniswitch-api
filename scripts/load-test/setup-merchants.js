'use strict';

// Seeds N distinct merchants via the real admin API and logs each in via the
// real /auth/token endpoint, writing their credentials to .merchants.json.
//
// A single-merchant load test is bottlenecked by MerchantThrottlerGuard's
// per-merchant rate limit almost immediately — confirmed live, see
// docs/technical/load-testing.md's "single-merchant" run. Spreading load
// across many merchants (a more realistic multi-tenant traffic shape
// anyway) is what actually exercises this app's own processing capacity
// instead of just the rate limiter's ceiling.

const http = require('http');

const TARGET = process.env.TARGET_URL || 'http://localhost:3000';
const ADMIN_API_KEY_ID = process.env.LOAD_TEST_ADMIN_API_KEY_ID;
const ADMIN_API_KEY_SECRET = process.env.LOAD_TEST_ADMIN_API_KEY_SECRET;
const MERCHANT_COUNT = Number(process.env.LOAD_TEST_MERCHANT_COUNT || 20);

function requestOnce(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const url = new URL(TARGET + path);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            const err = new Error(`${method} ${path} -> ${res.statusCode}: ${raw}`);
            err.statusCode = res.statusCode;
            return reject(err);
          }
          resolve(raw ? JSON.parse(raw) : {});
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// This setup script's own calls share the same IP-scoped rate limit as
// everything else — retrying a 429 with backoff here is just robustness for
// a fixture-seeding step, not part of what the load test itself measures.
async function request(method, path, body, token, attempt = 1) {
  try {
    return await requestOnce(method, path, body, token);
  } catch (err) {
    if (err.statusCode === 429 && attempt <= 5) {
      await sleep(1000 * attempt);
      return request(method, path, body, token, attempt + 1);
    }
    throw err;
  }
}

async function main() {
  if (!ADMIN_API_KEY_ID || !ADMIN_API_KEY_SECRET) {
    console.error('LOAD_TEST_ADMIN_API_KEY_ID / LOAD_TEST_ADMIN_API_KEY_SECRET must be set (from npm run seed:admin)');
    process.exit(1);
  }

  const { accessToken: adminToken } = await request('POST', '/api/v1/auth/token', {
    apiKeyId: ADMIN_API_KEY_ID,
    apiKeySecret: ADMIN_API_KEY_SECRET,
  });

  const merchants = [];
  for (let i = 0; i < MERCHANT_COUNT; i++) {
    const merchantId = `loadtest_${Date.now()}_${i}`;
    const created = await request(
      'POST',
      '/api/v1/admin/merchants',
      { merchantId, name: `Load Test Merchant ${i}`, roles: ['MERCHANT'] },
      adminToken,
    );
    // This setup script's own calls are IP-scoped-throttled the same as any
    // other caller (RATE_LIMIT_BURST_MAX/sec) — pacing here isn't part of
    // what's being measured, it's just avoiding tripping over the guardrail
    // while seeding fixtures.
    await sleep(150);
    const { accessToken } = await request('POST', '/api/v1/auth/token', {
      apiKeyId: created.apiKeyId,
      apiKeySecret: created.apiKeySecret,
    });
    merchants.push({ merchantId, hmacSecret: created.hmacSecret, jwt: accessToken });
    if (merchants.length % 10 === 0) process.stdout.write(`${merchants.length}`);
    else process.stdout.write(`.`);
    await sleep(150);
  }
  console.log(`\nSeeded ${merchants.length} merchants`);

  require('fs').writeFileSync(
    require('path').join(__dirname, '.merchants.json'),
    JSON.stringify(merchants, null, 2),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
