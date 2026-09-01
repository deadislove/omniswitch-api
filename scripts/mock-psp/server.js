'use strict';

const http = require('http');

// Mirrors BinInfo.isEuropean() — PSD2 requires an SCA challenge for these.
const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI',
  'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT',
  'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'GB',
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
  USD: 1, EUR: 0.92, GBP: 0.79, JPY: 149.5, AUD: 1.52, CAD: 1.36,
  CHF: 0.88, CNY: 7.24, HKD: 7.82, SGD: 1.34, SEK: 10.4, NOK: 10.6,
  DKK: 6.86, NZD: 1.64, MXN: 17.1, BRL: 5.4, INR: 83.3, TWD: 31.9,
  THB: 35.6, KRW: 1330,
};

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Decline-code markers for a charge — a paymentMethodId/storedPaymentMethodId
// containing one of these substrings (case-insensitive) declines the charge
// with that code, the same "magic substring" convention as FORCE_3DS/
// "invalid" elsewhere in this file, since there's no real card-number-based
// decline simulation anywhere in this mock. Mirrors Subscription.aggregate.ts's
// HARD_DECLINE_CODES set — see SubscriptionService's decline-code-aware
// dunning. Deliberately the *same* code strings for both Stripe- and
// Adyen-shaped responses below (real Adyen actually returns numeric
// refusalReasonCodes, not semantic strings — this mock skips that
// translation layer for simplicity, since nothing here needs to round-trip
// through a real Adyen account).
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
  if (lower.includes('forcetimeoutalways') || lower.includes('forcetimeoutresolvesucceed') || lower.includes('forcetimeoutresolvefail')) {
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
const FORCE_SLOW_DELAY_MS = 6000; // over SLOW_CALL_THRESHOLD_MS (5s)

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
        maybeRecordTimeoutResolution(params.get('payment_method'), req.headers['idempotency-key'], id, amount, currency);
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
      stripeSettlements.push({ id, amount, currency: pending ? pending.currency : 'USD', createdAt: new Date().toISOString() });
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
        return send(res, 200, { pspReference, resultCode: 'Refused', refusalReasonCode: '2', refusalReason: 'Refused' });
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
        maybeRecordTimeoutResolution((parsedBody.paymentMethod || {}).storedPaymentMethodId, req.headers['idempotency-key'], pspReference, amountValue, amountCurrency);
        if (resolvedOutcomeForKey.get(req.headers['idempotency-key'])?.outcome === 'SUCCEEDED') {
          adyenSettlements.push({ id: pspReference, amount: amountValue, currency: amountCurrency, createdAt: new Date().toISOString() });
        }
        return forceTimeout(res);
      }
      if (shouldForceServerError((parsedBody.paymentMethod || {}).storedPaymentMethodId, req.headers['idempotency-key'])) {
        return forceServerError(res);
      }
      if (shouldForceSlow((parsedBody.paymentMethod || {}).storedPaymentMethodId)) {
        await delay(FORCE_SLOW_DELAY_MS);
      }
      const declineCode = declineCodeFor((parsedBody.paymentMethod || {}).storedPaymentMethodId);
      if (declineCode) {
        return send(res, 200, { pspReference, resultCode: 'Refused', refusalReasonCode: declineCode, refusalReason: 'Refused' });
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
      adyenSettlements.push({ id: pspReference, amount: amountValue, currency: amountCurrency, createdAt: new Date().toISOString() });
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
        refusalReasonCode: resolved.declineCode,
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
      adyenSettlements.push({ id, amount: amountValue, currency: pending ? pending.currency : (parsedBody.amount || {}).currency || 'USD', createdAt: new Date().toISOString() });
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
