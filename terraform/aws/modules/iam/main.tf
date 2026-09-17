terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

# NOTE on scope — read before adding to this module:
#
# This module intentionally creates ONLY the two roles a CI-driven Terraform
# workflow needs before any cluster exists:
#   1. A GitHub Actions OIDC federation setup (no long-lived AWS access keys
#      in CI — the well-known, cluster-independent pattern).
#   2. A least-privilege Terraform execution policy scoped to the AWS
#      services this project's modules actually touch, not
#      AdministratorAccess.
#
# It deliberately does NOT create an IRSA (IAM Roles for Service Accounts)
# OIDC provider. IRSA's OIDC provider is bound to a specific EKS cluster's
# own OIDC issuer URL (`aws_eks_cluster.this.identity[0].oidc[0].issuer`),
# which only exists after the cluster in ../container-service is created —
# building it here would either be a dangling resource with no real issuer
# to point at, or force an artificial dependency on the cluster module that
# breaks the network/iam → container-service ordering. Real IRSA role
# wiring belongs in ../container-service, once the EKS module's OIDC
# issuer output actually exists.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  name = "${var.project}-${var.environment}"

  common_tags = merge(var.tags, {
    Project     = var.project
    Environment = var.environment
    ManagedBy   = "terraform"
    Component   = "iam"
  })
}

# --- GitHub Actions OIDC federation — lets CI assume an AWS role without a
#     long-lived access key. This provider is GitHub's own, fixed endpoint;
#     it is not related to and does not require an EKS cluster to exist. ---

resource "aws_iam_openid_connect_provider" "github_actions" {
  url = "https://token.actions.githubusercontent.com"

  client_id_list = ["sts.amazonaws.com"]

  # GitHub's OIDC token-signing certificate thumbprints. AWS IAM actually
  # ignores this value for well-known providers like GitHub's (it validates
  # the TLS chain itself against its own trusted CA list) — the field is
  # still required by the resource schema, so these are the two thumbprints
  # publicly documented for GitHub's current and previous intermediate CA.
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
  ]

  tags = merge(local.common_tags, {
    Name = "${local.name}-github-actions-oidc"
  })
}

# --- Role GitHub Actions assumes to run terraform plan/apply. Scoped to a
#     single repo and a single ref — a workflow on a feature branch or a
#     PR from a fork cannot assume this, only pushes/merges to the ref in
#     var.github_deploy_ref (main, by default). ---

data "aws_iam_policy_document" "github_actions_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github_actions.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_org}/${var.github_repo}:ref:${var.github_deploy_ref}"]
    }
  }
}

resource "aws_iam_role" "github_actions_deploy" {
  name               = "${local.name}-github-actions-deploy"
  description        = "Assumed by GitHub Actions (via OIDC, no access keys) to run terraform plan/apply for ${var.github_org}/${var.github_repo}@${var.github_deploy_ref}."
  assume_role_policy = data.aws_iam_policy_document.github_actions_trust.json

  tags = merge(local.common_tags, {
    Name = "${local.name}-github-actions-deploy"
  })
}

# --- Terraform execution policy — scoped to the services this project's
#     modules actually manage (network, iam, container-service, cloud-saas,
#     hsm), not AdministratorAccess.
#
#     Two honest caveats, not oversights:
#     - EC2/VPC actions (ec2:CreateVpc, ec2:CreateSubnet, ...) mostly don't
#       support resource-level ARN restrictions in IAM at all — AWS's own
#       API limitation, not a choice made here. Those stay scoped to "*"
#       within the ec2 service only.
#     - iam:* actions are resource-scoped to ARNs prefixed with this
#       project's name (role/policy names always start with "omniswitch-
#       api-" — see local.name everywhere in this module and ../network),
#       so this role can manage IAM resources belonging to this project but
#       not arbitrary roles/policies elsewhere in the account. ---

data "aws_iam_policy_document" "terraform_execution" {
  statement {
    sid    = "NetworkFullWithinService"
    effect = "Allow"
    actions = [
      "ec2:*",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "IamScopedToProjectPrefix"
    effect = "Allow"
    actions = [
      "iam:GetRole",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:GetOpenIDConnectProvider",
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:UpdateRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:CreatePolicy",
      "iam:DeletePolicy",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicyVersion",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:TagPolicy",
      "iam:UntagPolicy",
      "iam:CreateOpenIDConnectProvider",
      "iam:DeleteOpenIDConnectProvider",
      "iam:TagOpenIDConnectProvider",
      "iam:PassRole",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${var.project}-*",
      "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:policy/${var.project}-*",
      "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/*",
    ]
  }

  statement {
    sid    = "ListOnlyIamActionsNotResourceScopable"
    effect = "Allow"
    actions = [
      "iam:ListRoles",
      "iam:ListPolicies",
      "iam:ListOpenIDConnectProviders",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "ContainerServiceEks"
    effect = "Allow"
    actions = [
      "eks:*",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "CloudSaas"
    effect = "Allow"
    actions = [
      "rds:*",
      "elasticache:*",
      "s3:*",
      "secretsmanager:*",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "Hsm"
    effect = "Allow"
    actions = [
      "kms:*",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "terraform_execution" {
  name        = "${local.name}-terraform-execution"
  description = "Least-privilege (scoped-to-service, not AdministratorAccess) policy for the role that runs terraform plan/apply for this project."
  policy      = data.aws_iam_policy_document.terraform_execution.json

  tags = merge(local.common_tags, {
    Name = "${local.name}-terraform-execution"
  })
}

resource "aws_iam_role_policy_attachment" "github_actions_deploy" {
  role       = aws_iam_role.github_actions_deploy.name
  policy_arn = aws_iam_policy.terraform_execution.arn
}
