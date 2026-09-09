import { KYCVerificationStatus } from './kyc-provider.port';

/**
 * Persona's real Inquiry status vocabulary — confirmed against Persona's
 * own published docs (docs.withpersona.com/model-lifecycle,
 * docs.withpersona.com/inquiries), not guessed: `created | started |
 * pending | completed | approved | declined | needs_review | expired |
 * failed`. Notably richer than this codebase's own 3-value
 * `KYCVerificationStatus`, and `completed` is **not** a decision —
 * Persona's own integration guidance is that `completed` only means the
 * end-user finished the verification flow; the actual accept/reject
 * decision (`approved`/`declined`) can still be pending a workflow or
 * manual review afterward. Treating `completed` as a final answer would
 * be wrong even though the name sounds terminal.
 *
 * `PersonaKycProviderAdapter.verify()`'s synchronous response and
 * `KycWebhookController`'s async decision callback both see this same
 * vocabulary (a real Inquiry's `status` attribute, whether read from the
 * initial creation response or from a later webhook), so both map
 * through this one function rather than each guessing independently.
 */
export function mapPersonaInquiryStatus(status: string | undefined): KYCVerificationStatus {
  switch (status) {
    case 'approved':
      return 'APPROVED';
    case 'declined':
    case 'expired':
    case 'failed':
      return 'REJECTED';
    // created/started/pending/completed/needs_review, and anything this
    // list doesn't recognize yet — treat as still in progress rather
    // than guessing a decision, same "unrecognized defaults to the safe
    // side" posture decline-code-classifier.ts uses for an unknown PSP
    // decline code.
    default:
      return 'PENDING';
  }
}
