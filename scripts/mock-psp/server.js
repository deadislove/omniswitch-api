'use strict';

const http = require('http');
const crypto = require('crypto');

// Where AchBankTransferAdapter's/WireBankTransferAdapter's async settlement
// callback gets POSTed — docker-compose.yml sets this to
// http://api:3000/api/v1 (the app's own container DNS name inside the
// compose network); unset in a plain `node server.js` local run, in which
// case the async callback below is skipped (logged, not thrown) rather
// than failing the whole request.
const APP_BASE_URL = process.env.APP_BASE_URL || '';
const BANK_TRANSFER_WEBHOOK_SECRET = process.env.BANK_TRANSFER_WEBHOOK_SECRET || '';
// Same "APP_BASE_URL configured -> callback fires for real" story as
// bank-transfer, for PersonaKycProviderAdapter's async review decision.
const KYC_WEBHOOK_SECRET = process.env.KYC_WEBHOOK_SECRET || '';

// Mirrors BinInfo.isEuropean() — PSD2 requires an SCA challenge for these.
const EU_COUNTRIES = new Set([
  'AT',
  'BE',
  'BG',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HR',
  'HU',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK',
  'GB',
]);

// Settlement records — what a real PSP would eventually report back via its
// balance-transactions / settlement-report API. Recorded only at the point
// funds actually move (immediate charge, or capture of a manual-capture
// authorization) — not at authorization time, matching how this project's
// own ledger only books at confirmed-charge time, not intent creation. This
// is what ReconciliationService diffs the app's own ledger_outbox against.
const stripeSettlements = [];
const adyenSettlements = [];
// Currency isn't sent on Stripe's capture call (only amount_to_capture) or
// looked up any other way in this mock, so pending authorizations are
// tracked here to recover it at capture time.
const pendingAuthorizations = new Map(); // id -> { currency }

// Approximate real-world rates, 1 USD = X units of currency — a plausible
// mock, not a live feed. Deliberately static (no jitter) so a test
// asserting an exact converted amount stays deterministic rather than
// flaky; this is FXRateProviderAdapter's target, not a real market-data
// provider.
const USD_RATES = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  JPY: 149.5,
  AUD: 1.52,
  CAD: 1.36,
  CHF: 0.88,
  CNY: 7.24,
  HKD: 7.82,
  SGD: 1.34,
  SEK: 10.4,
  NOK: 10.6,
  DKK: 6.86,
  NZD: 1.64,
  MXN: 17.1,
  BRL: 5.4,
  INR: 83.3,
  TWD: 31.9,
  THB: 35.6,
  KRW: 1330,
};

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Same scheme BankTransferWebhookGuard/StripeWebhookGuard verify:
// signedPayload = `${timestamp}.${rawBody}`, HMAC-SHA256 hex digest.
function signBankTransferCallback(bodyStr) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHmac('sha256', BANK_TRANSFER_WEBHOOK_SECRET)
    .update(`${timestamp}.${bodyStr}`)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

// In-memory transfer state, keyed by transferId — what GET /ach/transfers/:id
// and GET /wire/transfers/:id serve back. Real Dwolla webhooks don't carry
// settlement detail inline (see scheduleBankTransferSettlement() below); the
// receiver has to fetch the actual resource to learn anything beyond
// success/failure, exactly like this map backs.
const bankTransferState = new Map();

// Simulates a real ACH/wire rail's async clearing cycle: accept synchronously
// (the caller already got its `pending` response), then — after a short,
// fixed delay standing in for what's actually hours/days in reality — POST
// a lightweight settlement *notification* back to the app's real webhook
// receiver, signed exactly the way a real provider's webhook would be.
// Silently skipped (not thrown) when APP_BASE_URL/BANK_TRANSFER_WEBHOOK_SECRET
// aren't configured (e.g. a bare `node server.js` run with no docker-compose
// env) so this never crashes the mock server itself — those two env vars
// only get set together, by docker-compose.yml's mock-psp service block.
//
// Real Dwolla webhook shape (developers.dwolla.com/docs/webhook-events):
// `{id, topic, resourceId, _links: {resource: {href}}}` — no settlement
// detail inline. `topic` alone tells the receiver success/failure
// (`customer_transfer_completed`/`customer_transfer_failed`); anything more
// (a failure reason, in this codebase's case) requires a follow-up
// authenticated GET against the resource — which is exactly what
// `GET /ach|wire/transfers/:id` below now serves, and what
// `AchBankTransferAdapter.getTransferStatus()`/`WireBankTransferAdapter`'s
// own copy calls. This mock used to skip that follow-up entirely and embed
// the outcome inline; that was a real, cited simplification, closed by
// this change.
function scheduleBankTransferSettlement(transferId, outcome, reason) {
  bankTransferState.set(transferId, { status: outcome, ...(reason ? { reason } : {}) });
  if (!APP_BASE_URL || !BANK_TRANSFER_WEBHOOK_SECRET) {
    console.warn(
      `mock-psp: APP_BASE_URL/BANK_TRANSFER_WEBHOOK_SECRET not set — skipping settlement callback for ${transferId}`,
    );
    return;
  }
  setTimeout(async () => {
    const topic = outcome === 'settled' ? 'customer_transfer_completed' : 'customer_transfer_failed';
    const bodyStr = JSON.stringify({
      id: 'evt_mock_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      topic,
      resourceId: transferId,
      _links: { resource: { href: `${APP_BASE_URL.replace(/\/api\/v1$/, '')}/mock-psp/transfers/${transferId}` } },
    });
    try {
      const res = await fetch(`${APP_BASE_URL}/webhooks/bank-transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bank-Transfer-Signature': signBankTransferCallback(bodyStr) },
        body: bodyStr,
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        console.error(`mock-psp: bank-transfer settlement callback for ${transferId} got HTTP ${res.status}`);
      }
    } catch (err) {
      console.error(`mock-psp: bank-transfer settlement callback for ${transferId} failed: ${err.message}`);
    }
  }, 200);
}

// Same scheme KycWebhookGuard verifies.
function signKycCallback(bodyStr) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac('sha256', KYC_WEBHOOK_SECRET).update(`${timestamp}.${bodyStr}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

// Same "accept now, decide later, signed callback" shape as
// scheduleBankTransferSettlement() — a real identity/business review
// (Persona/Onfido) takes hours to days, sometimes a human reviewer, never
// seconds. `outcome` is 'approved'/'declined' — Persona's own real status
// vocabulary (docs.withpersona.com/model-lifecycle), not an invented
// 'rejected' an earlier revision of this mock used.
function scheduleKycDecision(applicationId, outcome) {
  if (!APP_BASE_URL || !KYC_WEBHOOK_SECRET) {
    console.warn(`mock-psp: APP_BASE_URL/KYC_WEBHOOK_SECRET not set — skipping KYC decision callback for ${applicationId}`);
    return;
  }
  setTimeout(async () => {
    // Real Persona webhook event envelope (docs.withpersona.com/events) —
    // an *event* (data.attributes.name) wrapping the actual Inquiry
    // (data.attributes.payload.data), not a flat {applicationId, status}
    // body an earlier revision of this mock sent.
    const bodyStr = JSON.stringify({
      data: {
        type: 'event',
        id: 'evt_mock_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        attributes: {
          name: `inquiry.${outcome}`,
          payload: { data: { type: 'inquiry', id: applicationId, attributes: { status: outcome } } },
        },
      },
    });
    try {
      const res = await fetch(`${APP_BASE_URL}/webhooks/kyc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-KYC-Signature': signKycCallback(bodyStr) },
        body: bodyStr,
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        console.error(`mock-psp: KYC decision callback for ${applicationId} got HTTP ${res.status}`);
      }
    } catch (err) {
      console.error(`mock-psp: KYC decision callback for ${applicationId} failed: ${err.message}`);
    }
  }, 200);
}

// Base fee schedule — kept identical to PspFeeScheduleService's own
// defaults on purpose: the point of the /statement endpoints below is to
// simulate a REAL PSP invoice diverging from this app's routing-time
// *estimate* the same way a real interchange schedule would (different
// card types/networks costing different amounts), not to test against an
// arbitrary different number.
const BASE_FEE_SCHEDULE = {
  STRIPE: { feePercentage: 2.9, fixedFeeMinorUnits: 30 },
  ADYEN: { feePercentage: 0.3, fixedFeeMinorUnits: 10 },
};

// A real interchange bill is not one flat rate — different card
// types/networks (premium rewards cards, corporate cards, cross-border
// cards) cost a real PSP more to process, and that variance is exactly
// what PspCostReconciliationService's report exists to catch drifting
// from a flat-rate *estimate*. Deterministic (hashed from the PSP's own
// transaction id, not random) so a statement is reproducible for the
// same settlement data rather than different on every call — a fifth of
// transactions simulate a "premium card" surcharge, matching real-world
// premium-card mix being a minority, not the majority, of volume.
function realFeeForTransactionMinorUnits(provider, amountMinorUnits, txId) {
  const schedule = BASE_FEE_SCHEDULE[provider];
  let hash = 0;
  for (let i = 0; i < txId.length; i++) {
    hash = (hash * 31 + txId.charCodeAt(i)) >>> 0;
  }
  const isPremiumCard = hash % 5 === 0;
  const effectivePercentage = schedule.feePercentage + (isPremiumCard ? 1.5 : 0);
  return Math.round((amountMinorUnits * effectivePercentage) / 100) + schedule.fixedFeeMinorUnits;
}

// Decline-code markers for a charge — a paymentMethodId/storedPaymentMethodId
// containing one of these substrings (case-insensitive) declines the charge
// with that code, the same "magic substring" convention as FORCE_3DS/
// "invalid" elsewhere in this file, since there's no real card-number-based
// decline simulation anywhere in this mock. Mirrors
// Subscription.aggregate.ts's HARD_DECLINE_CODES.STRIPE set — used
// verbatim for Stripe-shaped responses below. Adyen-shaped responses
// translate this to a real Adyen refusalReasonCode via
// ADYEN_REFUSAL_REASON_CODES below instead (Phase 1) — real Adyen
// returns numeric refusalReasonCodes, not these Stripe-style semantic
// strings, and HARD_DECLINE_CODES.ADYEN is keyed on those numeric codes,
// not this vocabulary.
const DECLINE_CODE_MARKERS = {
  insufficientfunds: 'insufficient_funds',
  stolencard: 'stolen_card',
  lostcard: 'lost_card',
  frauddecline: 'fraudulent',
  pickupcard: 'pickup_card',
  restrictedcard: 'restricted_card',
  expiredcard: 'expired_card',
  carddeclined: 'card_declined',
};

function declineCodeFor(paymentMethodRef) {
  const lower = (paymentMethodRef || '').toLowerCase();
  for (const [marker, code] of Object.entries(DECLINE_CODE_MARKERS)) {
    if (lower.includes(marker)) return code;
  }
  return null;
}

// Real, documented Adyen refusalReasonCode values (Phase 1) — translates
// DECLINE_CODE_MARKERS' Stripe-style semantic string to what Adyen would
// actually return, so an Adyen-routed charge exercises
// Subscription.aggregate.ts's HARD_DECLINE_CODES.ADYEN table (numeric
// codes) rather than silently reusing Stripe's vocabulary. '5' Blocked
// Card covers stolen/lost/pickup — Adyen's standard refusalReasonCode
// list has no distinct code for each of those, unlike Stripe's decline_code
// vocabulary which does.
const ADYEN_REFUSAL_REASON_CODES = {
  insufficient_funds: '12', // Not enough balance — retryable
  stolen_card: '5', // Blocked Card — hard
  lost_card: '5', // Blocked Card — hard
  fraudulent: '20', // FRAUD — hard
  pickup_card: '5', // Blocked Card — hard
  restricted_card: '25', // Restricted Card — hard
  expired_card: '6', // Expired Card — hard
  card_declined: '4', // Acquirer Error — retryable, same posture as Stripe's own card_declined
};

function adyenRefusalReasonCodeFor(stripeStyleDeclineCode) {
  return ADYEN_REFUSAL_REASON_CODES[stripeStyleDeclineCode] ?? stripeStyleDeclineCode;
}

// Simulates "PSP call got no response at all" (timeout/network failure) for
// the ambiguous-outcome recovery path — see isAmbiguousOutcomeError and
// PaymentProcessorFactory.executeWithFallback()'s same-provider retry. Keyed
// by idempotency key (not connection-global) so a test can assert the exact
// same-provider-replay behavior a real PSP's idempotency guarantee provides:
// the first call for a given key times out, a retry with that SAME key
// succeeds — mirroring how Stripe/Adyen would actually resolve a retried
// request against the charge they already recorded.
const timedOutOnceForKey = new Set();

function shouldForceTimeout(paymentMethodRef, idempotencyKey) {
  const lower = (paymentMethodRef || '').toLowerCase();
  // forcetimeoutresolvesucceed/forcetimeoutresolvefail times out every
  // attempt too, same as forcetimeoutalways — including the same-provider
  // retry PaymentProcessorFactory.executeWithFallback() makes, so the
  // payment genuinely reaches AMBIGUOUS through the existing mechanism
  // before a later queryOutcome() lookup reveals what "really" happened.
  if (
    lower.includes('forcetimeoutalways') ||
    lower.includes('forcetimeoutresolvesucceed') ||
    lower.includes('forcetimeoutresolvefail')
  ) {
    return true;
  }
  if (lower.includes('forcetimeoutonce')) {
    if (timedOutOnceForKey.has(idempotencyKey)) return false;
    timedOutOnceForKey.add(idempotencyKey);
    return true;
  }
  return false;
}

function forceTimeout(res) {
  res.socket.destroy();
}

// Records the outcome the PSP actually reached for a request whose response
// never made it back to the caller (forceTimeout above) — real Stripe/Adyen
// idempotency-key replay would return this if the same key were used again;
// this is what the /lookup routes below read back for
// PSPAdapterPort.queryOutcome(). Keyed by idempotency key. Only
// forcetimeoutresolvesucceed/forcetimeoutresolvefail ever write an entry
// here — forcetimeoutalways (and forcetimeoutonce, already resolved in-band
// by its own retry-succeeds behavior) leave no entry, which is exactly the
// STILL_UNKNOWN case a lookup needs to be able to return: the PSP itself has
// no record either.
const resolvedOutcomeForKey = new Map();

function maybeRecordTimeoutResolution(paymentMethodRef, idempotencyKey, id, amount, currency) {
  const lower = (paymentMethodRef || '').toLowerCase();
  if (lower.includes('forcetimeoutresolvesucceed')) {
    resolvedOutcomeForKey.set(idempotencyKey, { outcome: 'SUCCEEDED', id, amount, currency });
  } else if (lower.includes('forcetimeoutresolvefail')) {
    resolvedOutcomeForKey.set(idempotencyKey, { outcome: 'FAILED', id, declineCode: 'card_declined' });
  }
}

// Simulates a PSP call that eventually succeeds but takes real wall-clock
// time to do so — distinct from forceTimeout above (no response at all).
// This is what the slow-call-rate circuit-breaker trigger (see
// RedisCircuitBreakerService.recordSlowCallSample()) is meant to detect: a
// hanging-but-not-erroring PSP. Delay is deliberately real (not mocked
// timers) so an e2e test exercises the actual code path — the adapter's
// real fetch(), the real elapsed-time measurement feeding recordSuccess().
// 1s of margin over SLOW_CALL_THRESHOLD_MS (5s) was enough for the
// intended real-fetch()-elapsed-time measurement under normal load, but
// left too little room under real host CPU contention (observed:
// latency-based-circuit-breaker.e2e-spec.ts failing to detect its own 5
// deliberately-slow calls as slow, under a full parallel e2e run on a
// busy shared dev machine — mechanism not pinned down with certainty, but
// widening the margin is a real, low-risk hedge regardless of the exact
// cause, since contention can only add latency here, never remove it).
const FORCE_SLOW_DELAY_MS = 10000; // over SLOW_CALL_THRESHOLD_MS (5s)

function shouldForceSlow(paymentMethodRef) {
  return (paymentMethodRef || '').toLowerCase().includes('forceslow');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Simulates the PSP's own transient 5xx server error — a response IS
// received (unlike forceTimeout above), just an unsuccessful one, and it's
// not a business decision about the charge the way a decline is. This is
// what PaymentProcessorFactory.isTransientPspError()/the same-provider
// retry it triggers is meant to handle. Keyed by idempotency key, not by
// which adapter is calling — PaymentProcessorFactory's same-provider
// retry AND its fallback-to-a-different-provider both reuse the exact
// same idempotency key for the same charge, and this marker string
// travels with paymentMethodId regardless of which PSP ends up
// processing it, so "once"/"twice" here means "for the first N calls
// carrying this idempotency key, from whichever adapter," not
// "N calls to this specific PSP."
const serverErrorCountForKey = new Map();

function shouldForceServerError(paymentMethodRef, idempotencyKey) {
  const lower = (paymentMethodRef || '').toLowerCase();
  if (lower.includes('forceservererroralways')) return true;

  let failuresRemaining = 0;
  if (lower.includes('forceservererrortwice')) failuresRemaining = 2;
  else if (lower.includes('forceservererroronce')) failuresRemaining = 1;
  else return false;

  const failuresSoFar = serverErrorCountForKey.get(idempotencyKey) || 0;
  if (failuresSoFar >= failuresRemaining) return false;
  serverErrorCountForKey.set(idempotencyKey, failuresSoFar + 1);
  return true;
}

function forceServerError(res) {
  send(res, 500, { error: { message: 'mock-psp: simulated internal server error' } });
}

const server = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', async () => {
    const url = req.url;

    const path = url.split('?')[0];
    const query = new URLSearchParams(url.split('?')[1] || '');
    const segments = path.split('/').filter(Boolean);

    // Stripe-shaped routes (/v1/...)
    if (path === '/v1/payment_intents' && req.method === 'POST') {
      const params = new URLSearchParams(data);
      const id = 'pi_mock_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const amount = Number(params.get('amount')) || 0;
      const currency = (params.get('currency') || 'usd').toUpperCase();
      const binCountry = (params.get('metadata[bin_country]') || '').toUpperCase();
      if (shouldForceTimeout(params.get('payment_method'), req.headers['idempotency-key'])) {
        maybeRecordTimeoutResolution(
          params.get('payment_method'),
          req.headers['idempotency-key'],
          id,
          amount,
          currency,
        );
        if (resolvedOutcomeForKey.get(req.headers['idempotency-key'])?.outcome === 'SUCCEEDED') {
          stripeSettlements.push({ id, amount, currency, createdAt: new Date().toISOString() });
        }
        return forceTimeout(res);
      }
      if (shouldForceServerError(params.get('payment_method'), req.headers['idempotency-key'])) {
        return forceServerError(res);
      }
      if (shouldForceSlow(params.get('payment_method'))) {
        await delay(FORCE_SLOW_DELAY_MS);
      }
      const declineCode = declineCodeFor(params.get('payment_method'));
      if (declineCode) {
        return send(res, 200, {
          id,
          status: 'requires_payment_method',
          object: 'payment_intent',
          last_payment_error: { code: declineCode, message: 'The card was declined.' },
        });
      }
      const forced = (params.get('description') || '').includes('FORCE_3DS');
      if (forced || EU_COUNTRIES.has(binCountry)) {
        return send(res, 200, {
          id,
          status: 'requires_action',
          object: 'payment_intent',
          next_action: { redirect_to_url: { url: 'https://mock-psp.local/3ds/' + id } },
        });
      }
      if (params.get('capture_method') === 'manual') {
        pendingAuthorizations.set(id, { currency });
        return send(res, 200, { id, status: 'requires_capture', object: 'payment_intent' });
      }
      stripeSettlements.push({ id, amount, currency, createdAt: new Date().toISOString() });
      return send(res, 200, { id, status: 'succeeded', object: 'payment_intent' });
    }
    // PSPAdapterPort.queryOutcome()'s target — a read-only lookup by
    // idempotency key, not a replay of the original charge request (this
    // mock has no card reference to replay with, matching what a real
    // automated resolution sweep would also be missing). Real Stripe
    // doesn't expose a GET-by-idempotency-key endpoint like this; this
    // models the same information a real Idempotency-Key header replay
    // would surface, without requiring a full request body this mock
    // (and the calling adapter) can no longer construct.
    if (path === '/v1/payment_intents/lookup' && req.method === 'GET') {
      const key = query.get('idempotency_key');
      const resolved = resolvedOutcomeForKey.get(key);
      if (!resolved) {
        return send(res, 200, { found: false });
      }
      if (resolved.outcome === 'SUCCEEDED') {
        return send(res, 200, { found: true, id: resolved.id, status: 'succeeded', object: 'payment_intent' });
      }
      return send(res, 200, {
        found: true,
        id: resolved.id,
        status: 'requires_payment_method',
        object: 'payment_intent',
        last_payment_error: { code: resolved.declineCode, message: 'The card was declined.' },
      });
    }
    if (segments[0] === 'v1' && segments[1] === 'payment_intents' && segments[3] === 'capture') {
      const id = segments[2];
      const params = new URLSearchParams(data);
      const amount = Number(params.get('amount_to_capture')) || 0;
      const pending = pendingAuthorizations.get(id);
      // Deliberately NOT deleting `id` from pendingAuthorizations here — a
      // manual-capture authorization can be captured multiple times (partial
      // captures against the same auth), and each one needs the same
      // currency lookup. Each capture pushes its own settlement record,
      // still keyed by the original id; ReconciliationService sums entries
      // sharing an id rather than assuming exactly one per id, to match.
      stripeSettlements.push({
        id,
        amount,
        currency: pending ? pending.currency : 'USD',
        createdAt: new Date().toISOString(),
      });
      return send(res, 200, { id, status: 'succeeded' });
    }
    if (segments[0] === 'v1' && segments[1] === 'payment_intents' && segments[3] === 'cancel') {
      pendingAuthorizations.delete(segments[2]);
      return send(res, 200, { id: segments[2], status: 'canceled' });
    }
    // Real Stripe SetupIntent: confirms a payment method off-session
    // *without* moving money. Unlike every other route in this file, no
    // settlement row is ever pushed here — nothing charged, nothing to
    // reconcile. `payment_method` containing "invalid" (case-insensitive)
    // is this mock's decline marker for verification — the same "magic
    // substring" convention FORCE_3DS already uses above, there being no
    // real card-number-based decline simulation anywhere in this mock.
    if (path === '/v1/setup_intents' && req.method === 'POST') {
      const params = new URLSearchParams(data);
      const id = 'seti_mock_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const paymentMethod = params.get('payment_method') || '';
      if (/invalid/i.test(paymentMethod)) {
        return send(res, 200, {
          id,
          status: 'requires_payment_method',
          object: 'setup_intent',
          last_setup_error: { code: 'card_declined', message: 'Your card was declined.' },
        });
      }
      return send(res, 200, { id, status: 'succeeded', object: 'setup_intent' });
    }
    if (path === '/v1/refunds' && req.method === 'POST') {
      return send(res, 200, { id: 're_mock_' + Date.now(), status: 'succeeded' });
    }
    if (path === '/v1/balance_transactions' && req.method === 'GET') {
      const since = Number(query.get('created[gte]')) || 0;
      const until = Number(query.get('created[lte]')) || Infinity;
      const matching = stripeSettlements.filter((t) => {
        const ts = new Date(t.createdAt).getTime() / 1000;
        return ts >= since && ts <= until;
      });
      return send(res, 200, { object: 'list', data: matching });
    }
    // PspCostReconciliationService's "actual invoiced fee" side — a real
    // fee statement computed from this mock's own settlement records
    // (realFeeForTransactionMinorUnits, above), not the flat-rate estimate
    // PspFeeScheduleService uses for routing. Real Stripe exposes this via
    // fee_details on each balance transaction / the Reporting API; this
    // mock exposes the aggregate directly since nothing here needs the
    // per-transaction breakdown.
    if (path === '/v1/statement' && req.method === 'GET') {
      const since = Number(query.get('since')) || 0;
      const until = Number(query.get('until')) || Infinity;
      const currency = (query.get('currency') || 'USD').toUpperCase();
      const matching = stripeSettlements.filter((t) => {
        const ts = new Date(t.createdAt).getTime() / 1000;
        return ts >= since && ts <= until && t.currency.toUpperCase() === currency;
      });
      const totalFeeMinorUnits = matching.reduce(
        (sum, t) => sum + realFeeForTransactionMinorUnits('STRIPE', t.amount, t.id),
        0,
      );
      return send(res, 200, { totalFeeMinorUnits, transactionCount: matching.length, currency });
    }
    if (segments[0] === 'v1' && segments[1] === 'disputes' && segments.length === 3 && req.method === 'POST') {
      // Real Stripe: submitting evidence[...] fields + submit=true moves a
      // dispute to 'under_review'. This mock doesn't validate the evidence
      // taxonomy, just that something was submitted.
      const params = new URLSearchParams(data);
      const hasEvidence = params.get('evidence[uncategorized_text]');
      if (!hasEvidence) {
        return send(res, 400, { error: { message: 'evidence is required' } });
      }
      return send(res, 200, { id: segments[2], status: 'under_review' });
    }

    // Adyen-shaped routes (/adyen/...)
    // Zero-value authorization for verifying a stored payment method
    // without moving money — see AdyenPSPAdapter.verifyPaymentMethod()'s
    // docblock for why this is a dedicated path rather than reusing
    // /adyen/payments with amount.value: 0. Same "invalid" substring
    // decline marker as Stripe's /v1/setup_intents above; no settlement
    // row is ever pushed here.
    if (path === '/adyen/payments/verify' && req.method === 'POST') {
      const pspReference = 'adyen_verify_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      let parsedBody = {};
      try {
        parsedBody = JSON.parse(data || '{}');
      } catch (e) {
        // malformed body — fall through with an empty parsed body
      }
      const storedPaymentMethodId = (parsedBody.paymentMethod || {}).storedPaymentMethodId || '';
      if (/invalid/i.test(storedPaymentMethodId)) {
        return send(res, 200, {
          pspReference,
          resultCode: 'Refused',
          refusalReasonCode: '2',
          refusalReason: 'Refused',
        });
      }
      return send(res, 200, { pspReference, resultCode: 'Authorised' });
    }
    if (path === '/adyen/payments' && req.method === 'POST') {
      const pspReference = 'adyen_mock_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      let parsedBody = {};
      try {
        parsedBody = JSON.parse(data || '{}');
      } catch (e) {
        // malformed body — fall through with an empty parsed body
      }
      const binCountry = ((parsedBody.metadata || {}).binCountry || '').toUpperCase();
      const amountValue = (parsedBody.amount || {}).value || 0;
      const amountCurrency = (parsedBody.amount || {}).currency || 'USD';
      const isManualCapture = (parsedBody.additionalData || {}).manualCapture === 'true';
      if (shouldForceTimeout((parsedBody.paymentMethod || {}).storedPaymentMethodId, req.headers['idempotency-key'])) {
        maybeRecordTimeoutResolution(
          (parsedBody.paymentMethod || {}).storedPaymentMethodId,
          req.headers['idempotency-key'],
          pspReference,
          amountValue,
          amountCurrency,
        );
        if (resolvedOutcomeForKey.get(req.headers['idempotency-key'])?.outcome === 'SUCCEEDED') {
          adyenSettlements.push({
            id: pspReference,
            amount: amountValue,
            currency: amountCurrency,
            createdAt: new Date().toISOString(),
          });
        }
        return forceTimeout(res);
      }
      if (
        shouldForceServerError((parsedBody.paymentMethod || {}).storedPaymentMethodId, req.headers['idempotency-key'])
      ) {
        return forceServerError(res);
      }
      if (shouldForceSlow((parsedBody.paymentMethod || {}).storedPaymentMethodId)) {
        await delay(FORCE_SLOW_DELAY_MS);
      }
      const declineCode = declineCodeFor((parsedBody.paymentMethod || {}).storedPaymentMethodId);
      if (declineCode) {
        return send(res, 200, {
          pspReference,
          resultCode: 'Refused',
          refusalReasonCode: adyenRefusalReasonCodeFor(declineCode),
          refusalReason: 'Refused',
        });
      }
      if (EU_COUNTRIES.has(binCountry)) {
        return send(res, 200, {
          pspReference,
          resultCode: 'RedirectShopper',
          action: { url: 'https://mock-psp.local/3ds/' + pspReference },
        });
      }
      if (isManualCapture) {
        pendingAuthorizations.set(pspReference, { currency: amountCurrency });
        return send(res, 200, { pspReference, resultCode: 'Authorised' });
      }
      adyenSettlements.push({
        id: pspReference,
        amount: amountValue,
        currency: amountCurrency,
        createdAt: new Date().toISOString(),
      });
      return send(res, 200, { pspReference, resultCode: 'Authorised' });
    }
    // See the matching comment on the Stripe /v1/payment_intents/lookup
    // route above — PSPAdapterPort.queryOutcome()'s Adyen-shaped target.
    if (path === '/adyen/payments/lookup' && req.method === 'GET') {
      const key = query.get('idempotencyKey');
      const resolved = resolvedOutcomeForKey.get(key);
      if (!resolved) {
        return send(res, 200, { found: false });
      }
      if (resolved.outcome === 'SUCCEEDED') {
        return send(res, 200, { found: true, pspReference: resolved.id, resultCode: 'Authorised' });
      }
      return send(res, 200, {
        found: true,
        pspReference: resolved.id,
        resultCode: 'Refused',
        refusalReasonCode: adyenRefusalReasonCodeFor(resolved.declineCode),
        refusalReason: 'Refused',
      });
    }
    if (segments[0] === 'adyen' && segments[1] === 'payments' && segments[3] === 'captures') {
      const id = segments[2];
      const pspReference = 'adyen_capture_' + Date.now();
      let parsedBody = {};
      try {
        parsedBody = JSON.parse(data || '{}');
      } catch (e) {
        // malformed body — fall through with an empty parsed body
      }
      const amountValue = (parsedBody.amount || {}).value || 0;
      const pending = pendingAuthorizations.get(id);
      // Not deleted here either — see the matching comment on the Stripe
      // capture route above; Adyen also supports multiple partial captures
      // against one authorisation.
      adyenSettlements.push({
        id,
        amount: amountValue,
        currency: pending ? pending.currency : (parsedBody.amount || {}).currency || 'USD',
        createdAt: new Date().toISOString(),
      });
      return send(res, 200, { pspReference });
    }
    if (segments[0] === 'adyen' && segments[1] === 'payments' && segments[3] === 'cancels') {
      pendingAuthorizations.delete(segments[2]);
      return send(res, 200, { pspReference: 'adyen_cancel_' + Date.now() });
    }
    if (segments[0] === 'adyen' && segments[1] === 'payments' && segments[3] === 'refunds') {
      return send(res, 200, { pspReference: 'adyen_refund_' + Date.now() });
    }
    if (segments[0] === 'adyen' && segments[1] === 'disputes' && segments[3] === 'defense' && req.method === 'POST') {
      let parsedBody = {};
      try {
        parsedBody = JSON.parse(data || '{}');
      } catch (e) {
        // malformed body — fall through with an empty parsed body
      }
      if (!parsedBody.content) {
        return send(res, 400, { error: 'content is required' });
      }
      return send(res, 200, { pspReference: 'adyen_defense_' + Date.now(), success: true });
    }
    if (path === '/adyen/settlement-report' && req.method === 'GET') {
      const since = Number(query.get('since')) || 0;
      const until = Number(query.get('until')) || Infinity;
      const transactions = adyenSettlements.filter((t) => {
        const ts = new Date(t.createdAt).getTime() / 1000;
        return ts >= since && ts <= until;
      });
      return send(res, 200, { transactions });
    }
    // Adyen counterpart of /v1/statement above — real Adyen exposes this
    // via its settlement batch reports (a CSV export), which include a
    // real per-line commission amount; this mock exposes the same
    // aggregate directly.
    if (path === '/adyen/statement' && req.method === 'GET') {
      const since = Number(query.get('since')) || 0;
      const until = Number(query.get('until')) || Infinity;
      const currency = (query.get('currency') || 'USD').toUpperCase();
      const matching = adyenSettlements.filter((t) => {
        const ts = new Date(t.createdAt).getTime() / 1000;
        return ts >= since && ts <= until && (t.currency || '').toUpperCase() === currency;
      });
      const totalFeeMinorUnits = matching.reduce(
        (sum, t) => sum + realFeeForTransactionMinorUnits('ADYEN', t.amount, t.id),
        0,
      );
      return send(res, 200, { totalFeeMinorUnits, transactionCount: matching.length, currency });
    }

    // KYC verification — MockKYCProviderAdapter's target. Resolves
    // synchronously (a real provider takes days); "reject" anywhere in
    // legalName (case-insensitive) is this mock's decline marker, same
    // "magic substring" convention as FORCE_3DS/"invalid" above.
    if (path === '/kyc/verify' && req.method === 'POST') {
      let parsedBody = {};
      try {
        parsedBody = JSON.parse(data || '{}');
      } catch (e) {
        // malformed body — fall through with an empty parsed body
      }
      const legalName = parsedBody.legalName || '';
      const taxId = parsedBody.taxId || '';
      const applicationId = 'kyc_mock_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      if (!legalName || !taxId) {
        return send(res, 400, { error: 'legalName and taxId are required' });
      }
      if (/reject/i.test(legalName)) {
        return send(res, 200, { approved: false, applicationId, reason: 'identity_verification_failed' });
      }
      return send(res, 200, { approved: true, applicationId });
    }

    // Persona-shaped KYC application submission — PersonaKycProviderAdapter's
    // target. Genuinely two-phase, unlike /kyc/verify above: accepted as
    // `pending`, then the real decision (`approved`/`declined`) arrives
    // later via scheduleKycDecision()'s signed callback to
    // POST /webhooks/kyc. "invalidinput" anywhere in legalName is this
    // mock's synchronous-rejection marker (malformed submission — a real
    // provider can tell this immediately, before ever starting a review);
    // "reject" is accepted, then declined during review — same two-marker
    // convention as /ach/transfers and /wire/transfers above. Response
    // shapes are real Persona JSON:API ones (docs.withpersona.com/
    // integration-guide-understanding-a-persona-api-payload,
    // docs.withpersona.com/errors) — see PersonaKycProviderAdapter's
    // docblock for the same fidelity note.
    if (path === '/persona/kyc-applications' && req.method === 'POST') {
      let parsedBody = {};
      try {
        parsedBody = JSON.parse(data || '{}');
      } catch (e) {
        // malformed body — fall through with an empty parsed body
      }
      const legalName = parsedBody.legalName || '';
      const taxId = parsedBody.taxId || '';
      const id = 'persona_mock_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      if (!legalName || !taxId) {
        return send(res, 400, { errors: [{ title: 'Bad Request', details: 'legalName and taxId are required' }] });
      }
      if (/invalidinput/i.test(legalName)) {
        return send(res, 200, { data: { type: 'inquiry', id, attributes: { status: 'declined' } } });
      }
      send(res, 200, { data: { type: 'inquiry', id, attributes: { status: 'pending' } } });
      if (/reject/i.test(legalName)) {
        scheduleKycDecision(id, 'declined');
      } else {
        scheduleKycDecision(id, 'approved');
      }
      return;
    }

    // Bank transfer initiation — MockBankTransferAdapter's target.
    // Resolves synchronously ("sent"); a real transfer settles over days.
    // "transferfail" anywhere in merchantId (case-insensitive) is this
    // mock's decline marker, same convention as the others above.
    if (path === '/bank/transfers' && req.method === 'POST') {
      let parsedBody = {};
      try {
        parsedBody = JSON.parse(data || '{}');
      } catch (e) {
        // malformed body — fall through with an empty parsed body
      }
      const id = 'bt_mock_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const merchantId = parsedBody.merchantId || '';
      if (/transferfail/i.test(merchantId)) {
        return send(res, 200, { id, status: 'failed', reason: 'account_details_invalid' });
      }
      return send(res, 200, { id, status: 'sent' });
    }

    // ACH/Wire transfer initiation — AchBankTransferAdapter's/
    // WireBankTransferAdapter's target. Unlike /bank/transfers above,
    // this is genuinely two-phase: accepted synchronously as `pending`,
    // then the real outcome (`settled`/`failed`) arrives later via
    // scheduleBankTransferSettlement()'s signed callback to
    // POST /webhooks/bank-transfer — the same two-phase shape a real
    // ACH/wire rail actually has. Two distinct markers in merchantId
    // (case-insensitive), same "magic substring" convention as the other
    // mock endpoints: "transferreject" is an outright synchronous
    // rejection (bad account details — a real rail can tell this
    // immediately, before ever submitting to clearing); "transferfail" is
    // accepted, then fails during clearing (insufficient funds — a real
    // rail can only discover this once it actually tries to move money).
    if ((path === '/ach/transfers' || path === '/wire/transfers') && req.method === 'POST') {
      const rail = path === '/ach/transfers' ? 'ach' : 'wire';
      let parsedBody = {};
      try {
        parsedBody = JSON.parse(data || '{}');
      } catch (e) {
        // malformed body — fall through with an empty parsed body
      }
      const id = rail + '_mock_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const merchantId = parsedBody.merchantId || '';
      if (/transferreject/i.test(merchantId)) {
        return send(res, 200, { id, status: 'rejected', reason: 'invalid_account_number' });
      }
      send(res, 200, { id, status: 'pending' });
      if (/transferfail/i.test(merchantId)) {
        scheduleBankTransferSettlement(id, 'failed', 'insufficient_funds');
      } else {
        scheduleBankTransferSettlement(id, 'settled');
      }
      return;
    }

    // ACH/Wire transfer follow-up GET — AchBankTransferAdapter's/
    // WireBankTransferAdapter's getTransferStatus() target, and what a real
    // Dwolla webhook's {id, topic, resourceId} notification actually
    // requires a follow-up call for (the notification itself carries no
    // settlement detail — see scheduleBankTransferSettlement()'s docblock
    // above). Serves back whatever bankTransferState was last set to for
    // this id; a transfer that scheduleBankTransferSettlement() hasn't
    // resolved yet (webhook already fired, GET race) returns 404, matching
    // how a real not-yet-indexed resource would look mid-race.
    if (
      (segments[0] === 'ach' || segments[0] === 'wire') &&
      segments[1] === 'transfers' &&
      segments[2] &&
      req.method === 'GET'
    ) {
      const state = bankTransferState.get(segments[2]);
      if (!state) {
        return send(res, 404, { error: 'transfer not found' });
      }
      return send(res, 200, { id: segments[2], ...state });
    }

    // Transactional email send — EmailDisputeNotificationAdapter's target.
    // Mimics a real provider's `{to, subject, body}` shape (SendGrid's
    // /v3/mail/send and similar all take some variant of this) closely
    // enough to stand in for one. "reject" anywhere in `to` (case-
    // insensitive) is this mock's decline marker, same convention as the
    // other mock endpoints.
    if (path === '/v1/email/send' && req.method === 'POST') {
      let parsedBody = {};
      try {
        parsedBody = JSON.parse(data || '{}');
      } catch (e) {
        // malformed body — fall through with an empty parsed body
      }
      const { to, subject, body } = parsedBody;
      if (!to || !subject || !body) {
        return send(res, 400, { error: 'to, subject, and body are required' });
      }
      if (/reject/i.test(to)) {
        return send(res, 422, { error: 'recipient address rejected' });
      }
      const id = 'email_mock_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      return send(res, 200, { id, status: 'queued' });
    }

    // FX rate quote — FXRateProviderAdapter's target. Cross rate computed
    // via USD from the static USD_RATES table above.
    if (path === '/fx/rates' && req.method === 'GET') {
      const from = (query.get('from') || '').toUpperCase();
      const to = (query.get('to') || '').toUpperCase();
      if (!from || !to) {
        return send(res, 400, { error: 'from and to query params are required' });
      }
      if (!(from in USD_RATES) || !(to in USD_RATES)) {
        return send(res, 422, { error: `Unsupported currency pair: ${from}/${to}` });
      }
      const rate = Math.round((USD_RATES[to] / USD_RATES[from]) * 1e6) / 1e6;
      return send(res, 200, { from, to, rate, provider: 'mock-fx', capturedAt: new Date().toISOString() });
    }

    send(res, 404, { error: 'not found', url });
  });
});

server.listen(4000, () => console.log('Mock PSP running on port 4000'));
