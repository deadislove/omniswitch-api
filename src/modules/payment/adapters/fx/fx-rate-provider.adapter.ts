import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FXRateProviderPort, FXRate } from '../../ports/outbound/fx-rate-provider.port';

/**
 * FX Rate Provider Adapter
 * Calls an external rate source over HTTP — in this reference project,
 * scripts/mock-psp/server.js's `/fx/rates` endpoint (same "point at a
 * local mock in tests/dev" pattern as StripePSPAdapter/AdyenPSPAdapter's
 * configurable base URLs), not a real market-data provider.
 */
@Injectable()
export class FXRateProviderAdapter extends FXRateProviderPort {
  private readonly logger = new Logger(FXRateProviderAdapter.name);
  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    super();
    this.baseUrl = configService.get<string>('FX_RATE_PROVIDER_URL', 'http://localhost:4000/fx');
  }

  async getRate(fromCurrency: string, toCurrency: string): Promise<FXRate> {
    if (fromCurrency === toCurrency) {
      // Not just an optimization — asking the provider to quote a
      // currency against itself is a meaningless request some providers
      // would reject outright.
      return { rate: 1, provider: 'identity' };
    }

    const query = new URLSearchParams({ from: fromCurrency, to: toCurrency });
    const response = await fetch(`${this.baseUrl}/rates?${query.toString()}`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`FX rate provider request failed (${response.status}): ${body}`);
    }

    const body = await response.json();
    this.logger.debug(`FX rate ${fromCurrency}->${toCurrency}: ${body.rate} (${body.provider})`);
    return { rate: body.rate, provider: body.provider ?? 'mock-fx' };
  }
}
