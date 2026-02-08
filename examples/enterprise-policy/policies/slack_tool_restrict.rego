package visor.tool.invoke

default allowed = true

# Block destructive tool methods for non-admins
is_admin { input.actor.roles[_] == "admin" }

allowed = false {
  endswith(input.tool.methodName, "_delete")
  not is_admin
}

reason = "destructive tool methods require the admin role" {
  endswith(input.tool.methodName, "_delete")
  not is_admin
}
