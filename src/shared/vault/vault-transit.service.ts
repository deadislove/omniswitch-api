import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const TRANSIT_KEY_NAME = 'hmac-secrets';
const REQUEST_TIMEOUT_MS = 5000;
// Renew at 2/3 of the lease rather than waiting until it's nearly expired —
// leaves headroom for a slow/failed renewal attempt to retry before the
// token actually stops working. Floored so a very short-lived test/dev
// lease doesn't produce a sub-second renewal loop.
const RENEWAL_FRACTION = 2 / 3;
const MIN_RENEWAL_DELAY_MS = 5000;
// Bounds how aggressively a *failed* renewal retries — frequent enough to
// recover quickly once Vault is reachable again, capped so a long Vault
// outage doesn't turn into a tight retry loop.
const RENEWAL_RETRY_DELAY_MS = 30000;

type VaultAuthMethod = 'static-token' | 'approle';

interface VaultLoginResponse {
  auth: {
    client_token: string;
    lease_duration: number;
    renewable: boolean;
  };
}

interface VaultRenewResponse {
  auth: {
    lease_duration: number;
    renewable: boolean;
  };
}

/**
 * Vault Transit Service
 * Envelope-encrypts merchants.hmac_secret_ciphertext via Vault's Transit
 * secrets engine ("encryption as a service") — see
 * docs/technical/secret-management.md for why this exists and what it
 * doesn't cover.
 *
 * This app never sees or manages the actual encryption key — it only ever
 * sends plaintext to `/encrypt` and gets a ciphertext back (and vice versa
 * for `/decrypt`). Vault owns key storage, rotation, and access policy; a
 * database compromise alone yields ciphertext, not usable secrets.
 *
 * Fails closed: if Vault is unreachable or returns an error, encrypt/decrypt
 * throw rather than falling back to storing/using plaintext. HMAC
 * verification (the only caller of decrypt()) already fails closed on a
 * missing/weak secret — this is the same posture applied one layer earlier.
 *
 * Two auth methods, selected by `VAULT_AUTH_METHOD` (default
 * `static-token`, so existing deployments are unaffected unless they
 * explicitly opt in):
 * - `static-token`: the original behavior — a long-lived token (dev-mode's
 *   root token today) read once from `VAULT_TOKEN` and used forever. This
 *   mode also self-bootstraps the transit engine/key on boot, since a root
 *   token has the privilege to do so.
 * - `approle`: logs in via `VAULT_APPROLE_ROLE_ID`/`VAULT_APPROLE_SECRET_ID`
 *   to get a short-lived, narrowly-scoped token, and renews it in the
 *   background before it expires (`scripts/vault/bootstrap-approle.sh`
 *   provisions the AppRole and its policy). Deliberately does *not*
 *   self-bootstrap the transit engine/key — an AppRole token scoped to
 *   exactly `encrypt`/`decrypt` on `hmac-secrets` (least privilege, the
 *   whole point of moving off a root token) has no permission to mount
 *   engines or create keys, so that must already exist before this mode is
 *   used. If renewal ever falls behind the token's actual expiry, the next
 *   encrypt/decrypt call fails closed the same way an unreachable Vault
 *   already does — no separate failure mode to reason about.
 */
@Injectable()
export class VaultTransitService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VaultTransitService.name);
  private readonly baseUrl: string;
  private readonly authMethod: VaultAuthMethod;
  private readonly roleId: string;
  private readonly secretId: string;
  private token: string;
  private renewalTimer?: NodeJS.Timeout;

  constructor(private readonly configService: ConfigService) {
    this.baseUrl = this.configService.get<string>('VAULT_ADDR', 'http://localhost:8200');
    this.authMethod = this.configService.get<string>('VAULT_AUTH_METHOD', 'static-token') as VaultAuthMethod;
    this.token = this.configService.get<string>('VAULT_TOKEN', '');
    this.roleId = this.configService.get<string>('VAULT_APPROLE_ROLE_ID', '');
    this.secretId = this.configService.get<string>('VAULT_APPROLE_SECRET_ID', '');

    if (this.authMethod === 'approle' && (!this.roleId || !this.secretId)) {
      // A genuine misconfiguration (forgot to set role_id/secret_id), not a
      // "Vault isn't up yet" timing issue — those two are handled
      // differently on purpose (see onModuleInit()'s own comment): this one
      // fails loud and immediately at boot instead of producing a confusing
      // runtime error on the first request.
      throw new Error('VAULT_AUTH_METHOD=approle requires VAULT_APPROLE_ROLE_ID and VAULT_APPROLE_SECRET_ID to be set');
    }
    if (this.authMethod !== 'static-token' && this.authMethod !== 'approle') {
      throw new Error(`Unknown VAULT_AUTH_METHOD: "${this.authMethod}" (expected static-token/approle)`);
    }
  }

  /**
   * Idempotent bootstrap for static-token mode: ensures the transit engine
   * is mounted and the key this service uses exists. Safe to run on every
   * boot — mounting an already-mounted engine or creating an
   * already-existing key are both no-ops here (checked first, not just
   * "POST and ignore the error"), so multiple replicas starting
   * concurrently don't race destructively.
   *
   * approle mode skips this entirely — see the class docblock for why —
   * and logs in instead.
   */
  async onModuleInit(): Promise<void> {
    try {
      if (this.authMethod === 'approle') {
        await this.loginWithAppRole();
        this.logger.log(`Vault AppRole login succeeded; renewal scheduled`);
        return;
      }
      await this.ensureTransitEngineMounted();
      await this.ensureKeyExists();
      this.logger.log(`Vault transit key '${TRANSIT_KEY_NAME}' ready`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Not rethrown: a POC/dev environment might boot the app before Vault
      // is ready despite depends_on/healthcheck (e.g. running the app
      // outside docker-compose entirely). The first real encrypt/decrypt
      // call will surface a clear error if Vault genuinely isn't usable —
      // failing app boot entirely over this would be a worse failure mode
      // than a clear error on first actual use.
      this.logger.warn(`Vault transit bootstrap failed (will retry lazily on first use): ${msg}`);
    }
  }

  onModuleDestroy(): void {
    if (this.renewalTimer) clearTimeout(this.renewalTimer);
  }

  async encrypt(plaintext: string): Promise<string> {
    const body = { plaintext: Buffer.from(plaintext, 'utf8').toString('base64') };
    const res = await this.request<{ data: { ciphertext: string } }>(
      'POST',
      `/v1/transit/encrypt/${TRANSIT_KEY_NAME}`,
      body,
    );
    return res.data.ciphertext;
  }

  async decrypt(ciphertext: string): Promise<string> {
    const res = await this.request<{ data: { plaintext: string } }>('POST', `/v1/transit/decrypt/${TRANSIT_KEY_NAME}`, {
      ciphertext,
    });
    return Buffer.from(res.data.plaintext, 'base64').toString('utf8');
  }

  /**
   * POST /v1/auth/approle/login itself takes no token (it's how one is
   * obtained) — every other call in this class does.
   */
  private async loginWithAppRole(): Promise<void> {
    const res = await this.request<VaultLoginResponse>(
      'POST',
      '/v1/auth/approle/login',
      { role_id: this.roleId, secret_id: this.secretId },
      { unauthenticated: true },
    );
    this.token = res.auth.client_token;
    this.scheduleRenewal(res.auth.lease_duration);
  }

  private scheduleRenewal(leaseDurationSeconds: number): void {
    if (this.renewalTimer) clearTimeout(this.renewalTimer);
    if (!leaseDurationSeconds || leaseDurationSeconds <= 0) return;

    const delayMs = Math.max(leaseDurationSeconds * 1000 * RENEWAL_FRACTION, MIN_RENEWAL_DELAY_MS);
    this.renewalTimer = setTimeout(() => {
      void this.renewSelf();
    }, delayMs);
    // Doesn't keep the process alive on its own — same reasoning as any
    // other background interval in this codebase; app shutdown shouldn't
    // wait on a token renewal timer.
    this.renewalTimer.unref?.();
  }

  private async renewSelf(): Promise<void> {
    try {
      const res = await this.request<VaultRenewResponse>('POST', '/v1/auth/token/renew-self', {});
      this.logger.log(
        `Vault AppRole token renewed (next renewal in ~${Math.round((res.auth.lease_duration * RENEWAL_FRACTION) / 60)}m)`,
      );
      this.scheduleRenewal(res.auth.lease_duration);
    } catch (err: unknown) {
      // Deliberately not rethrown and not fatal: the current token is
      // still valid until its actual TTL expires, so a single failed
      // renewal (Vault briefly unreachable, a leader-election blip) isn't
      // an outage on its own. Retry sooner than the normal 2/3-of-lease
      // cadence so a transient failure gets a real chance to recover
      // before the token actually runs out — if it never does, the next
      // encrypt/decrypt call fails closed on its own, same as an
      // unreachable Vault always has.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Vault AppRole token renewal failed, will retry: ${msg}`);
      this.renewalTimer = setTimeout(() => {
        void this.renewSelf();
      }, RENEWAL_RETRY_DELAY_MS);
      this.renewalTimer.unref?.();
    }
  }

  private async ensureTransitEngineMounted(): Promise<void> {
    const mounts = await this.request<{ data: Record<string, unknown> }>('GET', '/v1/sys/mounts');
    if (mounts.data['transit/']) return;

    await this.request('POST', '/v1/sys/mounts/transit', { type: 'transit' });
    this.logger.log('Vault transit secrets engine mounted');
  }

  private async ensureKeyExists(): Promise<void> {
    try {
      await this.request('GET', `/v1/transit/keys/${TRANSIT_KEY_NAME}`);
      return; // already exists
    } catch {
      // Fall through to create — any other failure (Vault down, sealed,
      // etc.) surfaces from the create call below instead of being masked.
    }

    await this.request('POST', `/v1/transit/keys/${TRANSIT_KEY_NAME}`, {});
    this.logger.log(`Vault transit key '${TRANSIT_KEY_NAME}' created`);
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    options?: { unauthenticated?: boolean },
  ): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (!options?.unauthenticated) headers['X-Vault-Token'] = this.token;

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Vault request failed: ${method} ${path} -> ${response.status} ${text}`);
    }

    // 204 No Content (e.g. a bare key-exists check) has no body to parse.
    if (response.status === 204) return {} as T;
    return response.json() as Promise<T>;
  }
}
