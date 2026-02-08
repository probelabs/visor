# Check execution gating policy (Visor Enterprise Edition)
# Controls which roles can run each check.
# Contact hello@probelabs.com for licensing.

package visor.check.execute

default allowed = false

# Admin can run anything
allowed {
  input.actor.roles[_] == "admin"
}

# Developers can run non-production checks
allowed {
  input.actor.roles[_] == "developer"
  not startswith(input.check.id, "deploy-production")
}

# Reviewers can run read-only checks (info/policy criticality)
allowed {
  input.actor.roles[_] == "reviewer"
  input.check.criticality == "info"
}

allowed {
  input.actor.roles[_] == "reviewer"
  input.check.criticality == "policy"
}

# Per-step role requirement (from YAML policy.require)
allowed {
  required := input.check.policy.require
  is_string(required)
  input.actor.roles[_] == required
}

allowed {
  required := input.check.policy.require
  is_array(required)
  required[_] == input.actor.roles[_]
}

# Local mode (CLI) gets broader access
allowed {
  input.actor.isLocalMode == true
}

reason = "insufficient role for this check" { not allowed }
