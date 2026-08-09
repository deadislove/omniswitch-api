/**
 * Currency Value Object (ISO-4217)
 * Immutable representation of a currency with minor unit precision.
 */
export class Currency {
  private static readonly CURRENCY_MAP: Record<string, number> = {
    // Zero-decimal currencies
    BIF: 0, CLP: 0, DJF: 0, GNF: 0, JPY: 0, KMF: 0, KRW: 0, MGA: 0,
    PYG: 0, RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
    // Three-decimal currencies
    BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
    // Standard two-decimal currencies (default)
    USD: 2, EUR: 2, GBP: 2, AUD: 2, CAD: 2, CHF: 2, CNY: 2, HKD: 2,
    SGD: 2, SEK: 2, NOK: 2, DKK: 2, NZD: 2, MXN: 2, BRL: 2, INR: 2,
    TWD: 2, THB: 2, MYR: 2, IDR: 2, PHP: 2, ZAR: 2, AED: 2, SAR: 2,
  };

  private readonly _code: string;
  private readonly _minorUnits: number;

  private constructor(code: string, minorUnits: number) {
    this._code = code;
    this._minorUnits = minorUnits;
  }

  static of(code: string): Currency {
    const normalized = code.toUpperCase().trim();
    if (normalized.length !== 3) {
      throw new Error(`Invalid currency code: ${code}. Must be 3 characters (ISO-4217).`);
    }
    const minorUnits = Currency.CURRENCY_MAP[normalized] ?? 2;
    return new Currency(normalized, minorUnits);
  }

  get code(): string {
    return this._code;
  }

  get minorUnits(): number {
    return this._minorUnits;
  }

  get decimalFactor(): number {
    return Math.pow(10, this._minorUnits);
  }

  equals(other: Currency): boolean {
    return this._code === other._code;
  }

  toString(): string {
    return this._code;
  }
}
