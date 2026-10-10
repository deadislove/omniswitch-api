import { ConfigService } from '@nestjs/config';
import { OfacSdnSanctionsAdapter } from './ofac-sdn-sanctions.adapter';
import { SanctionsListStore } from './sanctions/sanctions-list.store';

function buildAdapter(matchThreshold?: number): OfacSdnSanctionsAdapter {
  const configService = {
    get: (_key: string, def: unknown) => (matchThreshold !== undefined ? matchThreshold : def),
  } as unknown as ConfigService;
  return new OfacSdnSanctionsAdapter(new SanctionsListStore(), configService);
}

describe('OfacSdnSanctionsAdapter', () => {
  it('returns HIT for an exact match (case/punctuation-insensitive) against the bundled snapshot', async () => {
    const adapter = buildAdapter();
    const result = await adapter.screen({ name: 'usama bin ladin' });
    expect(result.status).toBe('HIT');
    expect(result.score).toBe(1);
    expect(result.matchedListEntry).toBe('USAMA BIN LADIN');
  });

  it('returns POTENTIAL_MATCH for a close fuzzy match above the threshold but not exact', async () => {
    const adapter = buildAdapter();
    const result = await adapter.screen({ name: 'Usama Bin Laden' });
    expect(result.status).toBe('POTENTIAL_MATCH');
    expect(result.score).toBeGreaterThanOrEqual(0.92);
    expect(result.score).toBeLessThan(1);
  });

  it('returns CLEAR for an unrelated name', async () => {
    const adapter = buildAdapter();
    const result = await adapter.screen({ name: 'Acme Corporation Inc.' });
    expect(result.status).toBe('CLEAR');
    expect(result.matchedListEntry).toBeUndefined();
  });

  it('respects a configured SANCTIONS_MATCH_THRESHOLD', async () => {
    // An unrealistically low threshold should turn an otherwise-CLEAR
    // name into at least a POTENTIAL_MATCH against something in the list.
    const lenientAdapter = buildAdapter(0.01);
    const result = await lenientAdapter.screen({ name: 'Acme Corporation Inc.' });
    expect(result.status).not.toBe('CLEAR');
  });
});
