# Tests for MCP tool access control policy
# Run with: opa test examples/enterprise-policy/policies/

package visor.tool.invoke

# ---------------------------------------------------------------------------
# Default allow – most tools are permitted by default
# ---------------------------------------------------------------------------

test_default_allowed_for_developer {
  allowed with input as {
    "scope": "tool.invoke",
    "tool": {"serverName": "github", "methodName": "search_issues"},
    "actor": {"roles": ["developer"], "isLocalMode": false}
  }
}

test_default_allowed_for_reviewer {
  allowed with input as {
    "scope": "tool.invoke",
    "tool": {"serverName": "github", "methodName": "list_repos"},
    "actor": {"roles": ["reviewer"], "isLocalMode": false}
  }
}

test_default_allowed_for_external_non_destructive {
  allowed with input as {
    "scope": "tool.invoke",
    "tool": {"serverName": "github", "methodName": "get_pull_request"},
    "actor": {"roles": ["external"], "isLocalMode": false}
  }
}

test_default_allowed_for_empty_roles {
  allowed with input as {
    "scope": "tool.invoke",
    "tool": {"serverName": "github", "methodName": "search_issues"},
    "actor": {"roles": [], "isLocalMode": false}
  }
}

# ---------------------------------------------------------------------------
# _delete methods blocked for non-admins
# ---------------------------------------------------------------------------

test_delete_blocked_for_developer {
  not allowed with input as {
    "scope": "tool.invoke",
    "tool": {"serverName": "github", "methodName": "repo_delete"},
    "actor": {"roles": ["developer"], "isLocalMode": false}
  }
}

test_delete_blocked_for_external {
  not allowed with input as {
    "scope": "tool.invoke",
    "tool": {"serverName": "github", "methodName": "branch_delete"},
    "actor": {"roles": ["external"], "isLocalMode": false}
  }
}

test_delete_blocked_for_reviewer {
  not allowed with input as {
    "scope": "tool.invoke",
    "tool": {"serverName": "github", "methodName": "comment_delete"},
    "actor": {"roles": ["reviewer"], "isLocalMode": false}
  }
}

test_delete_blocked_for_empty_roles {
  not allowed with input as {
    "scope": "tool.invoke",
    "tool": {"serverName": "github", "methodName": "resource_delete"},
    "actor": {"roles": [], "isLocalMode": false}
  }
}

# ---------------------------------------------------------------------------
# Admin can call _delete methods
# ---------------------------------------------------------------------------

test_admin_allowed_delete {
  allowed with input as {
    "scope": "tool.invoke",
    "tool": {"serverName": "github", "methodName": "repo_delete"},
    "actor": {"roles": ["admin"], "isLocalMode": false}
  }
}

test_admin_allowed_branch_delete {
  allowed with input as {
    "scope": "tool.invoke",
    "tool": {"serverName": "github", "methodName": "branch_delete"},
    "actor": {"roles": ["admin"], "isLocalMode": false}
  }
}

test_admin_allowed_any_tool {
  allowed with input as {
    "scope": "tool.invoke",
    "tool": {"serverName": "shell", "methodName": "bash"},
    "actor": {"roles": ["admin"], "isLocalMode": false}
  }
}

# ---------------------------------------------------------------------------
# Bash blocked for external contributors
# ---------------------------------------------------------------------------

test_bash_blocked_for_external {
  not allowed with input as {
    "scope": "tool.invoke",
    "tool": {"serverName": "shell", "methodName": "bash"},
    "actor": {"roles": ["external"], "isLocalMode": false}
  }
}

test_bash_allowed_for_developer {
  allowed with input as {
    "scope": "tool.invoke",
    "tool": {"serverName": "shell", "methodName": "bash"},
    "actor": {"roles": ["developer"], "isLocalMode": false}
  }
}

test_bash_allowed_for_reviewer {
  allowed with input as {
    "scope": "tool.invoke",
    "tool": {"serverName": "shell", "methodName": "bash"},
    "actor": {"roles": ["reviewer"], "isLocalMode": false}
  }
}

# ---------------------------------------------------------------------------
# External with _delete – blocked by both rules
# ---------------------------------------------------------------------------

test_external_with_delete_denied {
  not allowed with input as {
    "scope": "tool.invoke",
    "tool": {"serverName": "github", "methodName": "repo_delete"},
    "actor": {"roles": ["external"], "isLocalMode": false}
  }
}

# ---------------------------------------------------------------------------
# Method name edge cases
# ---------------------------------------------------------------------------

test_method_containing_delete_in_middle_not_blocked {
  allowed with input as {
    "scope": "tool.invoke",
    "tool": {"serverName": "github", "methodName": "delete_branch"},
    "actor": {"roles": ["developer"], "isLocalMode": false}
  }
}

test_method_exactly_delete_suffix {
  not allowed with input as {
    "scope": "tool.invoke",
    "tool": {"serverName": "github", "methodName": "file_delete"},
    "actor": {"roles": ["developer"], "isLocalMode": false}
  }
}

# ---------------------------------------------------------------------------
# Reason message
# ---------------------------------------------------------------------------

test_reason_present_when_denied {
  reason == "tool access denied by policy" with input as {
    "scope": "tool.invoke",
    "tool": {"serverName": "github", "methodName": "repo_delete"},
    "actor": {"roles": ["external"], "isLocalMode": false}
  }
}

test_reason_not_defined_when_allowed {
  not reason with input as {
    "scope": "tool.invoke",
    "tool": {"serverName": "github", "methodName": "search_issues"},
    "actor": {"roles": ["developer"], "isLocalMode": false}
  }
}

# ---------------------------------------------------------------------------
# Multi-role actor – admin role in list overrides restrictions
# ---------------------------------------------------------------------------

test_multi_role_with_admin_allows_delete {
  allowed with input as {
    "scope": "tool.invoke",
    "tool": {"serverName": "github", "methodName": "repo_delete"},
    "actor": {"roles": ["developer", "admin"], "isLocalMode": false}
  }
}

test_multi_role_external_and_developer_bash_blocked {
  # external role triggers bash block even if other roles are present
  not allowed with input as {
    "scope": "tool.invoke",
    "tool": {"serverName": "shell", "methodName": "bash"},
    "actor": {"roles": ["external", "developer"], "isLocalMode": false}
  }
}

# ---------------------------------------------------------------------------
# is_admin helper rule
# ---------------------------------------------------------------------------

test_is_admin_true_for_admin_role {
  is_admin with input as {
    "actor": {"roles": ["admin"], "isLocalMode": false}
  }
}

test_is_admin_false_for_developer_role {
  not is_admin with input as {
    "actor": {"roles": ["developer"], "isLocalMode": false}
  }
}

test_is_admin_false_for_empty_roles {
  not is_admin with input as {
    "actor": {"roles": [], "isLocalMode": false}
  }
}
