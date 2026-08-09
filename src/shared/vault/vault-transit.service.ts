import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const TRANSIT_KEY_NAME = 'hmac-secrets';
const REQUEST_TIMEOUT_MS = 5000;

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
 */
@Injectable()
export class VaultTransitService implements OnModuleInit {
  private readonly logger = new Logger(VaultTransitService.name);
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(private readonly configService: ConfigService) {
    this.baseUrl = this.configService.get<string>('VAULT_ADDR', 'http://localhost:8200');
    this.token = this.configService.get<string>('VAULT_TOKEN', '');
  }

  /**
   * Idempotent bootstrap: ensures the transit engine is mounted and the key
   * this service uses exists. Safe to run on every boot — mounting an
   * already-mounted engine or creating an already-existing key are both
   * no-ops here (checked first, not just "POST and ignore the error"), so
   * multiple replicas starting concurrently don't race destructively.
   */
  async onModuleInit(): Promise<void> {
    try {
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
    const res = await this.request<{ data: { plaintext: string } }>(
      'POST',
      `/v1/transit/decrypt/${TRANSIT_KEY_NAME}`,
      { ciphertext },
    );
    return Buffer.from(res.data.plaintext, 'base64').toString('utf8');
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

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'X-Vault-Token': this.token,
        'Content-Type': 'application/json',
      },
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
