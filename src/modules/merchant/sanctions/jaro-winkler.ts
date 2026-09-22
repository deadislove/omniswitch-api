/**
 * Jaro-Winkler string similarity, 0 (no similarity) to 1 (identical) —
 * the standard fuzzy-matching algorithm real sanctions-screening tools
 * use for name matching (it weights matching prefixes more heavily than
 * plain edit distance, which suits names well: "Jon Smith" vs "John
 * Smith" should score higher than the same edit distance applied to an
 * arbitrary string would suggest). Implemented locally rather than
 * pulling in a dependency — this is a well-defined, ~30-line algorithm,
 * and keeping it in-repo means `OfacSdnSanctionsAdapter`'s matching
 * logic is fully auditable without trusting a third-party package's
 * implementation for a compliance-relevant decision.
 */
export function jaroSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const matchDistance = Math.max(Math.floor(Math.max(a.length, b.length) / 2) - 1, 0);
  const aMatches = new Array(a.length).fill(false);
  const bMatches = new Array(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }

  return (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
}

/**
 * Jaro-Winkler: boosts the plain Jaro score for a shared prefix (up to 4
 * chars), scaled by `prefixScale` (0.1, the standard value). Names that
 * agree at the start (a shared surname, a transliteration that only
 * diverges partway through) score meaningfully higher than the same
 * total edit distance spread evenly across the string would suggest.
 */
export function jaroWinklerSimilarity(a: string, b: string): number {
  const jaro = jaroSimilarity(a, b);
  const prefixScale = 0.1;
  let prefixLength = 0;
  const maxPrefix = 4;
  for (let i = 0; i < Math.min(maxPrefix, a.length, b.length); i++) {
    if (a[i] !== b[i]) break;
    prefixLength++;
  }
  return jaro + prefixLength * prefixScale * (1 - jaro);
}

/** Uppercase + collapse to single spaces + strip everything but letters/digits/spaces — so "O'Brien, John." and "OBRIEN JOHN" compare as the names they are, not as punctuation-sensitive strings. */
export function normalizeName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
