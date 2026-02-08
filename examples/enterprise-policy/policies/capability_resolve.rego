# AI capability restriction policy (Visor Enterprise Edition)
# Controls which AI capabilities (bash, file editing) are available per role.
# Contact hello@probelabs.com for licensing.

package visor.capability.resolve

# Helper: actor has developer role
is_developer { input.actor.roles[_] == "developer" }

# Helper: actor has admin role
is_admin { input.actor.roles[_] == "admin" }

# Disable file editing for non-developers
capabilities["allowEdit"] = false {
  not is_developer
  not is_admin
}

# Disable bash for external contributors
capabilities["allowBash"] = false {
  input.actor.roles[_] == "external"
}
