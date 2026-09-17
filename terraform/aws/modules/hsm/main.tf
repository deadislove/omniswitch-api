terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

# NOTE on scope — read before applying this module:
#
# This is the AWS-native, KMS-baseline alternative to what
# `src/shared/vault/vault-transit.service.ts` (HashiCorp Vault's Transit
# secrets engine) currently does for envelope-encrypting
# `merchants.hmac_secret_ciphertext` — see that file's own docblock and
# docs/technical/secret-management.md for what Vault Transit covers today.
# Creating this key does NOT repoint the application at it; that's an
# application-layer change (a KmsEncryptionService implementing the same
# interface VaultTransitService does, behind the same fail-closed posture)
# with its own migration/rollout, not a side effect of `terraform apply`.
# Same "target state, not automatic cutover" posture as ../cloud-saas.
#
# Real CloudHSM (dedicated, single-tenant hardware) is explicitly NOT
# built here. KMS's shared-tenancy HSM backing is judged sufficient for
# this project's actual compliance requirements, and CloudHSM's
# operational cost (cluster management, own backup/HA story) isn't
# justified without a real HSM mandate driving it.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  name = "${var.project}-${var.environment}"

  common_tags = merge(var.tags, {
    Project     = var.project
    Environment = var.environment
    ManagedBy   = "terraform"
    Component   = "hsm"
  })
}

data "aws_iam_policy_document" "hmac_secrets_key" {
  # Always grant the account root full access. Omitting this is a
  # well-known KMS footgun: a custom key policy that only lists specific
  # roles can permanently lock EVERYONE out (including account admins) if
  # those roles are ever deleted or misconfigured — AWS's own
  # recommendation is to always keep this statement.
  statement {
    sid    = "EnableRootAccountFullAccess"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
    actions   = ["kms:*"]
    resources = ["*"]
  }

  dynamic "statement" {
    for_each = length(var.key_admin_arns) > 0 ? [1] : []
    content {
      sid    = "KeyAdministration"
      effect = "Allow"
      principals {
        type        = "AWS"
        identifiers = var.key_admin_arns
      }
      actions = [
        "kms:Create*",
        "kms:Describe*",
        "kms:Enable*",
        "kms:List*",
        "kms:Put*",
        "kms:Update*",
        "kms:Revoke*",
        "kms:Disable*",
        "kms:Get*",
        "kms:Delete*",
        "kms:TagResource",
        "kms:UntagResource",
        "kms:ScheduleKeyDeletion",
        "kms:CancelKeyDeletion",
      ]
      resources = ["*"]
    }
  }

  dynamic "statement" {
    for_each = length(var.allowed_principal_arns) > 0 ? [1] : []
    content {
      sid    = "AllowEnvelopeEncryptionUsage"
      effect = "Allow"
      principals {
        type        = "AWS"
        identifiers = var.allowed_principal_arns
      }
      actions = [
        "kms:Encrypt",
        "kms:Decrypt",
        "kms:ReEncrypt*",
        "kms:GenerateDataKey*",
        "kms:DescribeKey",
      ]
      resources = ["*"]
    }
  }
}

resource "aws_kms_key" "hmac_secrets" {
  description             = "Envelope encryption key for hmac_secret/mfa_secret — AWS-native alternative to Vault Transit (see this module's own top-of-file note)."
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.hmac_secrets_key.json

  tags = merge(local.common_tags, { Name = "${local.name}-hmac-secrets" })
}

resource "aws_kms_alias" "hmac_secrets" {
  name          = "alias/${local.name}-hmac-secrets"
  target_key_id = aws_kms_key.hmac_secrets.key_id
}
