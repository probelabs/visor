# MCP tool access control policy (Visor Enterprise Edition)
# Controls which MCP methods each role can invoke.
# Contact hello@probelabs.com for licensing.

package visor.tool.invoke

default allowed = true

# Helper: actor has admin role
is_admin { input.actor.roles[_] == "admin" }

# Block destructive methods for non-admins
allowed = false {
  endswith(input.tool.methodName, "_delete")
  not is_admin
}

# Block bash execution tool for externals
allowed = false {
  input.tool.methodName == "bash"
  input.actor.roles[_] == "external"
}

reason = "tool access denied by policy" { not allowed }
