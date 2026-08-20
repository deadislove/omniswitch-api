import { createHash } from 'crypto';

/**
 * RFC 4122 v5 UUID (name-based, SHA-1), reimplemented locally so this
 * codebase doesn't need the `uuid` npm package (v14+ ships ESM-only,
 * which breaks this project's CommonJS Jest setup — see
 * subscription.service.ts's docblock for why v5 is used at all).
 * Byte-for-byte identical output to uuid@9's v5() for the same
 * (name, namespace) pair — deterministic IDs already computed with the
 * old package must keep resolving to the same value.
 */
export function uuidv5(name: string, namespace: string): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const nameBytes = Buffer.from(name, 'utf8');
  const hash = createHash('sha1').update(Buffer.concat([namespaceBytes, nameBytes])).digest();

  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
