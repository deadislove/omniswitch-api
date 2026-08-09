import { registerDecorator, ValidationOptions } from 'class-validator';

/**
 * Rejects values that look like a raw PAN (Primary Account Number).
 *
 * This API is designed to be out of PCI DSS scope (SAQ A / A-EP model):
 * cardToken/paymentMethodId are expected to be opaque references from
 * client-side tokenization (Stripe.js, Adyen Web Components), never a raw
 * card number. Nothing upstream of this DTO enforces that — a naive
 * integration could accidentally submit the actual PAN. This is a
 * defense-in-depth check, not what makes the flow PCI-compliant (that's the
 * client-side tokenization itself); it just fails loudly instead of quietly
 * accepting and forwarding/logging/persisting cardholder data.
 *
 * Uses the Luhn checksum (not just "13-19 digits") to avoid false-positiving
 * on legitimate tokens that happen to contain a long digit run.
 */
function isLuhnValid(digits: string): boolean {
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits[i], 10);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

export function looksLikeRawCardNumber(value: string): boolean {
  const digitsOnly = value.replace(/[\s-]/g, '');
  if (!/^\d{12,19}$/.test(digitsOnly)) return false;
  return isLuhnValid(digitsOnly);
}

export function IsNotRawCardNumber(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isNotRawCardNumber',
      target: object.constructor,
      propertyName,
      options: {
        message: `${propertyName} looks like a raw card number — send a tokenized reference from client-side tokenization instead`,
        ...validationOptions,
      },
      validator: {
        validate(value: unknown): boolean {
          return typeof value !== 'string' || !looksLikeRawCardNumber(value);
        },
      },
    });
  };
}
