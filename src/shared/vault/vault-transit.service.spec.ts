import { ConfigService } from '@nestjs/config';
import { VaultTransitService } from './vault-transit.service';

function configWith(values: Record<string, string>): ConfigService {
  return { get: (key: string, def?: string) => values[key] ?? def } as unknown as ConfigService;
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('VaultTransitService', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  describe('static-token mode (default — must stay unchanged)', () => {
    it('defaults to static-token when VAULT_AUTH_METHOD is unset, and does not throw in the constructor', () => {
      expect(() => new VaultTransitService(configWith({ VAULT_TOKEN: 'root-token' }))).not.toThrow();
    });

    it('self-bootstraps the transit engine and key on module init, authenticated with the configured static token', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ data: {} })) // GET /v1/sys/mounts — transit/ absent
        .mockResolvedValueOnce(jsonResponse({})) // POST /v1/sys/mounts/transit
        .mockResolvedValueOnce(jsonResponse({}, 404)) // GET /v1/transit/keys/hmac-secrets — absent
        .mockResolvedValueOnce(jsonResponse({})); // POST /v1/transit/keys/hmac-secrets

      const svc = new VaultTransitService(configWith({ VAULT_TOKEN: 'root-token' }));
      await svc.onModuleInit();

      expect(fetchMock).toHaveBeenCalledTimes(4);
      for (const call of fetchMock.mock.calls) {
        const headers = call[1].headers as Record<string, string>;
        expect(headers['X-Vault-Token']).toBe('root-token');
      }
      expect(fetchMock.mock.calls[1][0]).toContain('/v1/sys/mounts/transit');
      expect(fetchMock.mock.calls[3][0]).toContain('/v1/transit/keys/hmac-secrets');
    });

    it('encrypt()/decrypt() round-trip using the static token, unaffected by the AppRole addition', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ data: { 'transit/': {} } })) // mounts already there
        .mockResolvedValueOnce(jsonResponse({})) // key already there
        .mockResolvedValueOnce(jsonResponse({ data: { ciphertext: 'vault:v1:abc' } })) // encrypt
        .mockResolvedValueOnce(jsonResponse({ data: { plaintext: Buffer.from('hello').toString('base64') } })); // decrypt

      const svc = new VaultTransitService(configWith({ VAULT_TOKEN: 'root-token' }));
      await svc.onModuleInit();

      const ciphertext = await svc.encrypt('hello');
      expect(ciphertext).toBe('vault:v1:abc');
      const plaintext = await svc.decrypt(ciphertext);
      expect(plaintext).toBe('hello');
    });

    it('onModuleInit does not throw when Vault is unreachable — fails soft on boot, fails closed on first real use', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      const svc = new VaultTransitService(configWith({ VAULT_TOKEN: 'root-token' }));

      await expect(svc.onModuleInit()).resolves.toBeUndefined();
      await expect(svc.encrypt('x')).rejects.toThrow('ECONNREFUSED');
    });

    it('encrypt() throws (fails closed) on a non-2xx Vault response', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: 'sealed' }, 503));
      const svc = new VaultTransitService(configWith({ VAULT_TOKEN: 'root-token' }));
      await expect(svc.encrypt('x')).rejects.toThrow(/Vault request failed/);
    });
  });

  describe('approle mode — constructor validation', () => {
    it('throws immediately if VAULT_AUTH_METHOD=approle but role_id/secret_id are missing', () => {
      expect(() => new VaultTransitService(configWith({ VAULT_AUTH_METHOD: 'approle' }))).toThrow(
        /VAULT_APPROLE_ROLE_ID and VAULT_APPROLE_SECRET_ID/,
      );
    });

    it('throws on an unrecognized VAULT_AUTH_METHOD value', () => {
      expect(() => new VaultTransitService(configWith({ VAULT_AUTH_METHOD: 'bogus' }))).toThrow(
        /Unknown VAULT_AUTH_METHOD/,
      );
    });
  });

  describe('approle mode — login and renewal', () => {
    function approleConfig() {
      return configWith({
        VAULT_AUTH_METHOD: 'approle',
        VAULT_APPROLE_ROLE_ID: 'role-1',
        VAULT_APPROLE_SECRET_ID: 'secret-1',
      });
    }

    it('logs in via role_id/secret_id, unauthenticated, and never attempts to self-bootstrap the engine/key', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ auth: { client_token: 'scoped-token-1', lease_duration: 3600, renewable: true } }),
      );

      const svc = new VaultTransitService(approleConfig());
      await svc.onModuleInit();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain('/v1/auth/approle/login');
      expect(JSON.parse(init.body)).toEqual({ role_id: 'role-1', secret_id: 'secret-1' });
      // Login itself carries no token — that's the whole point of it.
      expect(init.headers['X-Vault-Token']).toBeUndefined();

      // Never called sys/mounts or transit/keys — a scoped token can't and
      // shouldn't need to; see the class docblock.
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/v1/sys/mounts'))).toBe(false);
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/v1/transit/keys/'))).toBe(false);
      svc.onModuleDestroy(); // clears the real (unref'd, but destroyed for hygiene) renewal timer login scheduled
    });

    it('encrypt()/decrypt() after login use the token returned by the AppRole login, not VAULT_TOKEN', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({ auth: { client_token: 'scoped-token-1', lease_duration: 3600, renewable: true } }),
        )
        .mockResolvedValueOnce(jsonResponse({ data: { ciphertext: 'vault:v1:xyz' } }));

      const svc = new VaultTransitService(approleConfig());
      await svc.onModuleInit();
      await svc.encrypt('hello');

      const encryptCall = fetchMock.mock.calls[1];
      expect(encryptCall[1].headers['X-Vault-Token']).toBe('scoped-token-1');
      svc.onModuleDestroy();
    });

    it('schedules renewal at 2/3 of the lease and calls renew-self with the current token', async () => {
      jest.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({ auth: { client_token: 'scoped-token-1', lease_duration: 3000, renewable: true } }),
        )
        .mockResolvedValueOnce(jsonResponse({ auth: { lease_duration: 3000, renewable: true } })); // renew-self response

      const svc = new VaultTransitService(approleConfig());
      await svc.onModuleInit();
      expect(fetchMock).toHaveBeenCalledTimes(1); // just the login so far

      // 2/3 of 3000s = 2000s — advance just short of it, then past it.
      jest.advanceTimersByTime(1999_000);
      expect(fetchMock).toHaveBeenCalledTimes(1); // not yet
      jest.advanceTimersByTime(2_000);
      await Promise.resolve(); // let the fired timer's async renewSelf() start
      await Promise.resolve();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const renewCall = fetchMock.mock.calls[1];
      expect(renewCall[0]).toContain('/v1/auth/token/renew-self');
      expect(renewCall[1].headers['X-Vault-Token']).toBe('scoped-token-1');

      svc.onModuleDestroy();
    });

    it('a failed renewal does not throw, logs, and reschedules a retry — the still-valid token keeps working meanwhile', async () => {
      jest.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({ auth: { client_token: 'scoped-token-1', lease_duration: 3000, renewable: true } }),
        )
        .mockRejectedValueOnce(new Error('Vault temporarily unreachable')) // first renew-self attempt fails
        .mockResolvedValueOnce(jsonResponse({ data: { ciphertext: 'vault:v1:still-works' } })); // encrypt still works meanwhile

      const svc = new VaultTransitService(approleConfig());
      await svc.onModuleInit();

      jest.advanceTimersByTime(2000_000); // past the 2/3-of-lease mark
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(2); // login + failed renewal attempt

      // The token acquired at login is still used and still works — a
      // failed renewal isn't an outage on its own.
      const ciphertext = await svc.encrypt('still fine');
      expect(ciphertext).toBe('vault:v1:still-works');
      const encryptCall = fetchMock.mock.calls[2];
      expect(encryptCall[1].headers['X-Vault-Token']).toBe('scoped-token-1');

      svc.onModuleDestroy();
    });

    it('onModuleDestroy clears the pending renewal timer — no renewal call happens after destroy', async () => {
      jest.useFakeTimers();
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ auth: { client_token: 'scoped-token-1', lease_duration: 3000, renewable: true } }),
      );

      const svc = new VaultTransitService(approleConfig());
      await svc.onModuleInit();
      svc.onModuleDestroy();

      jest.advanceTimersByTime(10_000_000);
      await Promise.resolve();

      expect(fetchMock).toHaveBeenCalledTimes(1); // only the original login — no renewal fired
    });
  });
});
