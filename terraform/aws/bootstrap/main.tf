terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Deliberately no `backend` block — this root module creates the remote
  # state backend itself, so it can't also depend on it (the classic
  # chicken-and-egg problem). Its own state stays local, on whichever
  # machine/CI runner applies it, and is applied rarely (once per AWS
  # account, essentially never again after that).
}

provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}

locals {
  # Account ID suffix makes the bucket name globally unique (S3 bucket
  # names are unique across ALL AWS accounts, not just this one) without
  # a human having to invent and remember an arbitrary suffix.
  state_bucket_name = "${var.project}-terraform-state-${data.aws_caller_identity.current.account_id}"
  lock_table_name   = "${var.project}-terraform-locks"
}

resource "aws_s3_bucket" "terraform_state" {
  bucket = local.state_bucket_name
  tags   = merge(var.tags, { Name = local.state_bucket_name })
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  versioning_configuration {
    # Every state write becomes a recoverable object version — the
    # practical undo button if a bad apply corrupts state.
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "terraform_state_require_tls" {
  bucket = aws_s3_bucket.terraform_state.id
  policy = data.aws_iam_policy_document.terraform_state_require_tls.json
}

data "aws_iam_policy_document" "terraform_state_require_tls" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.terraform_state.arn, "${aws_s3_bucket.terraform_state.arn}/*"]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

# State locking — one row per state key while a plan/apply holds the lock,
# preventing two concurrent applies from racing on the same state file.
resource "aws_dynamodb_table" "terraform_locks" {
  name         = local.lock_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  tags = merge(var.tags, { Name = local.lock_table_name })
}
