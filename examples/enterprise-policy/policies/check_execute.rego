# Check execution gating policy (Visor Enterprise Edition)
# Controls which roles can run each check.
# Contact hello@probelabs.com for licensing.

package visor.check.execute

default allowed = false

# Explicit deny list from YAML policy.deny — if any of the actor's roles
# appear in the deny list, the check is unconditionally blocked.
# This is WASM-safe: uses explicit iteration with `some` instead of
# `not collection[_] == value`.
denied {
  some i, j
  input.check.policy.deny[i] == input.actor.roles[j]
}

# Admin can run anything (unless explicitly denied)
allowed {
  not denied
  input.actor.roles[_] == "admin"
}

# Developers can run non-production checks (unless explicitly denied)
allowed {
  not denied
  input.actor.roles[_] == "developer"
  not startswith(input.check.id, "deploy-production")
}

# Reviewers can run read-only checks (info/policy criticality)
allowed {
  not denied
  input.actor.roles[_] == "reviewer"
  input.check.criticality == "info"
}

allowed {
  not denied
  input.actor.roles[_] == "reviewer"
  input.check.criticality == "policy"
}

# Per-step role requirement (from YAML policy.require)
allowed {
  not denied
  required := input.check.policy.require
  is_string(required)
  input.actor.roles[_] == required
}

allowed {
  not denied
  required := input.check.policy.require
  is_array(required)
  required[_] == input.actor.roles[_]
}

# Local mode bypasses policy for checks without explicit requirements.
# Checks that declare `policy.require` in YAML still enforce roles even when
# running locally, so sensitive steps (e.g. deploy-production) stay protected.
# Explicit deny lists are still enforced in local mode.
allowed {
  not denied
  input.actor.isLocalMode == true
  not input.check.policy
}

reason = "role is in the deny list for this check" { denied }
reason = "insufficient role for this check" { not denied; not allowed }
