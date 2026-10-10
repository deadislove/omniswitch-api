output "github_actions_oidc_provider_arn" {
  value       = aws_iam_openid_connect_provider.github_actions.arn
  description = "ARN of the GitHub Actions OIDC provider — reused if any other repo/role ever needs to federate the same way (only one provider per URL is allowed per account)."
}

output "github_actions_deploy_role_arn" {
  value       = aws_iam_role.github_actions_deploy.arn
  description = "Role GitHub Actions assumes via OIDC to run terraform plan/apply. Configure this as the `role-to-assume` input to aws-actions/configure-aws-credentials in the deploy workflow."
}

output "terraform_execution_policy_arn" {
  value       = aws_iam_policy.terraform_execution.arn
  description = "The least-privilege policy attached to the deploy role — exposed in case a human operator's own role (for local terraform plan) needs the same policy attached rather than duplicating it."
}
