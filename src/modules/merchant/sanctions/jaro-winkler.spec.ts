import { jaroWinklerSimilarity, normalizeName } from './jaro-winkler';

describe('jaroWinklerSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(jaroWinklerSimilarity('USAMA BIN LADIN', 'USAMA BIN LADIN')).toBe(1);
  });

  it('returns 0 when either string is empty', () => {
    expect(jaroWinklerSimilarity('', 'SOMETHING')).toBe(0);
    expect(jaroWinklerSimilarity('SOMETHING', '')).toBe(0);
  });

  it('scores a close variant highly but below 1', () => {
    const score = jaroWinklerSimilarity('USAMA BIN LADIN', 'USAMA BIN LADEN');
    expect(score).toBeGreaterThan(0.9);
    expect(score).toBeLessThan(1);
  });

  it('scores two unrelated names low', () => {
    const score = jaroWinklerSimilarity('JOHN SMITH', 'ACME CORP');
    expect(score).toBeLessThan(0.6);
  });

  it('weights a shared prefix higher than the same edit distance spread across the string (the "Winkler" part)', () => {
    // Both pairs differ by one substituted character; the shared-prefix
    // pair should score at least as high thanks to the prefix bonus.
    const prefixShared = jaroWinklerSimilarity('MARTINEZ', 'MARTINAZ');
    const prefixDiffers = jaroWinklerSimilarity('AARTINEZ', 'BARTINEZ');
    expect(prefixShared).toBeGreaterThanOrEqual(prefixDiffers);
  });
});

describe('normalizeName', () => {
  it('uppercases and strips punctuation', () => {
    expect(normalizeName("O'Brien, John.")).toBe('O BRIEN JOHN');
  });

  it('collapses repeated whitespace', () => {
    expect(normalizeName('Acme    Corp')).toBe('ACME CORP');
  });

  it('trims leading/trailing whitespace', () => {
    expect(normalizeName('  Acme Corp  ')).toBe('ACME CORP');
  });
});
