# Production deployment policy (Visor Enterprise Edition)
# Custom rule path example: routes `deploy-production` check to this
# dedicated package instead of the default `visor.check.execute`.
#
# Usage in .visor.yaml:
#   steps:
#     deploy-production:
#       type: command
#       exec: ./deploy.sh production
#       policy:
#         require: admin
#         rule: visor/deploy/production
#
# The YAML `rule` field uses slashes; the Rego package uses dots.
# visor/deploy/production  -->  package visor.deploy.production
#
# Contact hello@probelabs.com for licensing.

package visor.deploy.production

default allowed = false

# Helper: check if actor is an admin (WASM-safe pattern —
# avoids `not input.actor.roles[_] == "admin"` which is unsafe for WASM)
is_admin { input.actor.roles[_] == "admin" }

# Only admins can deploy to production
allowed {
  is_admin
}

# Additionally require the PR to target the main branch
allowed {
  is_admin
  input.repository.baseBranch == "main"
}

reason = "only admins can deploy to production" { not allowed }
