terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }
}

# NOTE on scope — same posture as ../../aws/modules/hsm: AWS-native
# alternative comment applies here too, s/AWS KMS/Cloud KMS/ — the target
# state for src/shared/vault/vault-transit.service.ts, not an automatic
# cutover. See that module's top-of-file note for the full reasoning.
#
# No AWS-style "always grant account root" policy statement here — that
# was needed because a custom AWS KMS key policy can omit root entirely
# and lock everyone out. Cloud KMS has no per-key policy document at all;
# access is governed by normal GCP project/resource IAM bindings (like
# every other GCP resource), which already can't produce that lockout
# failure mode — there's no equivalent footgun to defend against here.
#
# Real CloudHSM-equivalent (Cloud HSM, dedicated hardware-backed keys) is
# NOT built here, same "十、開放決策" item 4 reasoning as the AWS module.

locals {
  name = "${var.project}-${var.environment}"
}

resource "google_kms_key_ring" "this" {
  project  = var.gcp_project_id
  name     = "${local.name}-keyring"
  location = var.region

  # GCP provides no delete API for key rings — `terraform destroy` drops
  # this from state but the key ring itself persists in the project.
  # Documented here so a future `terraform destroy` against a real
  # environment isn't a surprise.
}

resource "google_kms_crypto_key" "hmac_secrets" {
  name            = "hmac-secrets"
  key_ring        = google_kms_key_ring.this.id
  rotation_period = var.rotation_period

  labels = var.labels

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_kms_crypto_key_iam_member" "allowed_members" {
  for_each = toset(var.allowed_member_emails)

  crypto_key_id = google_kms_crypto_key.hmac_secrets.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = each.value
}
