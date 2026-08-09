/**
 * BIN (Bank Identification Number) Value Object
 * Represents the first 6-8 digits of a card number used for routing decisions.
 */
export class BinInfo {
  private readonly _bin: string;
  private readonly _country: string;
  private readonly _cardBrand: CardBrand;
  private readonly _cardType: CardType;
  private readonly _issuingBank?: string;

  constructor(params: {
    bin: string;
    country: string;
    cardBrand: CardBrand;
    cardType: CardType;
    issuingBank?: string;
  }) {
    if (!/^\d{6,8}$/.test(params.bin)) {
      throw new Error(`Invalid BIN: ${params.bin}. Must be 6-8 digits.`);
    }
    this._bin = params.bin;
    this._country = params.country.toUpperCase();
    this._cardBrand = params.cardBrand;
    this._cardType = params.cardType;
    this._issuingBank = params.issuingBank;
  }

  get bin(): string { return this._bin; }
  get country(): string { return this._country; }
  get cardBrand(): CardBrand { return this._cardBrand; }
  get cardType(): CardType { return this._cardType; }
  get issuingBank(): string | undefined { return this._issuingBank; }

  isEuropean(): boolean {
    const euCountries = new Set([
      'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI',
      'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT',
      'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'GB',
    ]);
    return euCountries.has(this._country);
  }

  requiresSCA(): boolean {
    // SCA required for European cards under PSD2
    return this.isEuropean();
  }

  toString(): string {
    return `BIN:${this._bin}(${this._country}/${this._cardBrand})`;
  }
}

export enum CardBrand {
  VISA = 'VISA',
  MASTERCARD = 'MASTERCARD',
  AMEX = 'AMEX',
  DISCOVER = 'DISCOVER',
  JCB = 'JCB',
  UNIONPAY = 'UNIONPAY',
  DINERS = 'DINERS',
  UNKNOWN = 'UNKNOWN',
}

export enum CardType {
  CREDIT = 'CREDIT',
  DEBIT = 'DEBIT',
  PREPAID = 'PREPAID',
  UNKNOWN = 'UNKNOWN',
}
