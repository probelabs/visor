# AI capability restriction policy (Visor Enterprise Edition)
# Controls which AI capabilities (bash, file editing) are available per role.
# Contact hello@probelabs.com for licensing.

package visor.capability.resolve

# Disable file editing for non-developers
capabilities["allowEdit"] = false {
  not input.actor.roles[_] == "developer"
  not input.actor.roles[_] == "admin"
}

# Disable bash for external contributors
capabilities["allowBash"] = false {
  input.actor.roles[_] == "external"
}
