# Minimal example: a node-pnpm repository maintained by the framework.
#
# This example is the integration-test target for the framework: Dependabot
# opens PRs against it, `maintenance-ci` runs the reusable CI plus the policy
# check, and `maintenance-auto-merge` enables GitHub's native auto-merge.
#
# Before pushing this example anywhere:
# 1. Replace YOUR_ORG and FRAMEWORK_SHA_OR_TAG in .github/workflows/*.
# 2. Run `pnpm install` to generate pnpm-lock.yaml.
# 3. Enable Dependabot version updates + security alerts on the repository.
# 4. Require the `dependency-ci` and `maintenance-policy` checks on main.
# 5. Enable "Allow auto-merge" in repository settings.

See docs/onboarding.md in the framework repository for the full checklist.
