import { Currency } from './currency.vo';

/**
 * FX Rate Snapshot - captures exchange rate at a point in time
 */
export interface FXRateSnapshot {
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  capturedAt: Date;
  provider: string;
}

/**
 * Money Value Object
 * Immutable, multi-currency monetary amount using integer minor-unit arithmetic
 * to avoid floating-point precision errors.
 *
 * All amounts are stored as integers in the smallest currency unit
 * (e.g., cents for USD, yen for JPY).
 */
export class Money {
  private readonly _amountMinorUnits: bigint;
  private readonly _currency: Currency;
  private readonly _fxSnapshot?: FXRateSnapshot;

  private constructor(
    amountMinorUnits: bigint,
    currency: Currency,
    fxSnapshot?: FXRateSnapshot,
  ) {
    if (amountMinorUnits < 0n) {
      throw new Error(`Money amount cannot be negative: ${amountMinorUnits}`);
    }
    this._amountMinorUnits = amountMinorUnits;
    this._currency = currency;
    this._fxSnapshot = fxSnapshot;
  }

  /**
   * Create Money from a decimal string or number (e.g., 10.99 USD)
   */
  static of(amount: number | string, currencyCode: string, fxSnapshot?: FXRateSnapshot): Money {
    const currency = Currency.of(currencyCode);
    const factor = currency.decimalFactor;
    const numericAmount = typeof amount === 'string' ? parseFloat(amount) : amount;

    if (isNaN(numericAmount)) {
      throw new Error(`Invalid amount: ${amount}`);
    }

    // Round to avoid floating-point issues before converting to minor units
    const minorUnits = BigInt(Math.round(numericAmount * factor));
    return new Money(minorUnits, currency, fxSnapshot);
  }

  /**
   * Create Money directly from minor units (e.g., 1099 for $10.99)
   */
  static fromMinorUnits(minorUnits: bigint | number, currencyCode: string, fxSnapshot?: FXRateSnapshot): Money {
    const currency = Currency.of(currencyCode);
    return new Money(BigInt(minorUnits), currency, fxSnapshot);
  }

  /**
   * Zero amount for a given currency
   */
  static zero(currencyCode: string): Money {
    return Money.fromMinorUnits(0n, currencyCode);
  }

  get amountMinorUnits(): bigint {
    return this._amountMinorUnits;
  }

  get currency(): Currency {
    return this._currency;
  }

  get fxSnapshot(): FXRateSnapshot | undefined {
    return this._fxSnapshot;
  }

  /**
   * Returns the decimal representation (e.g., 10.99 for USD)
   */
  get amount(): number {
    return Number(this._amountMinorUnits) / this._currency.decimalFactor;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this._amountMinorUnits + other._amountMinorUnits, this._currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    const result = this._amountMinorUnits - other._amountMinorUnits;
    if (result < 0n) {
      throw new Error(`Subtraction would result in negative money: ${this.toString()} - ${other.toString()}`);
    }
    return new Money(result, this._currency);
  }

  multiply(factor: number): Money {
    const result = BigInt(Math.round(Number(this._amountMinorUnits) * factor));
    return new Money(result, this._currency);
  }

  /**
   * Convert to another currency using an FX rate snapshot
   */
  convertTo(targetCurrencyCode: string, rate: number, provider = 'internal'): Money {
    const targetCurrency = Currency.of(targetCurrencyCode);
    const convertedAmount = this.amount * rate;
    const snapshot: FXRateSnapshot = {
      fromCurrency: this._currency.code,
      toCurrency: targetCurrency.code,
      rate,
      capturedAt: new Date(),
      provider,
    };
    return Money.of(convertedAmount, targetCurrencyCode, snapshot);
  }

  isZero(): boolean {
    return this._amountMinorUnits === 0n;
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this._amountMinorUnits > other._amountMinorUnits;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this._amountMinorUnits < other._amountMinorUnits;
  }

  equals(other: Money): boolean {
    return (
      this._currency.equals(other._currency) &&
      this._amountMinorUnits === other._amountMinorUnits
    );
  }

  private assertSameCurrency(other: Money): void {
    if (!this._currency.equals(other._currency)) {
      throw new Error(
        `Currency mismatch: ${this._currency.code} vs ${other._currency.code}. Use convertTo() first.`,
      );
    }
  }

  toString(): string {
    return `${this.amount.toFixed(this._currency.minorUnits)} ${this._currency.code}`;
  }

  toJSON(): object {
    return {
      amount: this.amount,
      amountMinorUnits: this._amountMinorUnits.toString(),
      currency: this._currency.code,
      minorUnits: this._currency.minorUnits,
      ...(this._fxSnapshot && { fxSnapshot: this._fxSnapshot }),
    };
  }
}
