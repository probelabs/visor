# Tests for check execution gating policy
# Run with: opa test examples/enterprise-policy/policies/

package visor.check.execute

# ---------------------------------------------------------------------------
# Admin bypass – admin can run anything regardless of check id or type
# ---------------------------------------------------------------------------

test_admin_allowed_for_production_deploy {
  allowed with input as {
    "scope": "check.execute",
    "check": {"id": "deploy-production", "type": "command"},
    "actor": {"roles": ["admin"], "isLocalMode": false}
  }
}

test_admin_allowed_for_arbitrary_check {
  allowed with input as {
    "scope": "check.execute",
    "check": {"id": "lint-code", "type": "ai", "criticality": "high"},
    "actor": {"roles": ["admin"], "isLocalMode": false}
  }
}

test_admin_allowed_even_with_require_other_role {
  allowed with input as {
    "scope": "check.execute",
    "check": {"id": "deploy-production", "type": "command", "policy": {"require": "superadmin"}},
    "actor": {"roles": ["admin"], "isLocalMode": false}
  }
}

# ---------------------------------------------------------------------------
# Developer restrictions – allowed for non-production, denied for production
# ---------------------------------------------------------------------------

test_developer_allowed_for_non_production_check {
  allowed with input as {
    "scope": "check.execute",
    "check": {"id": "lint-code", "type": "ai"},
    "actor": {"roles": ["developer"], "isLocalMode": false}
  }
}

test_developer_allowed_for_test_suite {
  allowed with input as {
    "scope": "check.execute",
    "check": {"id": "run-tests", "type": "command"},
    "actor": {"roles": ["developer"], "isLocalMode": false}
  }
}

test_developer_denied_for_deploy_production {
  not allowed with input as {
    "scope": "check.execute",
    "check": {"id": "deploy-production", "type": "command"},
    "actor": {"roles": ["developer"], "isLocalMode": false}
  }
}

test_developer_denied_for_deploy_production_with_suffix {
  not allowed with input as {
    "scope": "check.execute",
    "check": {"id": "deploy-production-canary", "type": "command"},
    "actor": {"roles": ["developer"], "isLocalMode": false}
  }
}

# ---------------------------------------------------------------------------
# Reviewer – allowed only for info and policy criticality
# ---------------------------------------------------------------------------

test_reviewer_allowed_for_info_criticality {
  allowed with input as {
    "scope": "check.execute",
    "check": {"id": "info-check", "type": "ai", "criticality": "info"},
    "actor": {"roles": ["reviewer"], "isLocalMode": false}
  }
}

test_reviewer_allowed_for_policy_criticality {
  allowed with input as {
    "scope": "check.execute",
    "check": {"id": "policy-check", "type": "ai", "criticality": "policy"},
    "actor": {"roles": ["reviewer"], "isLocalMode": false}
  }
}

test_reviewer_denied_for_high_criticality {
  not allowed with input as {
    "scope": "check.execute",
    "check": {"id": "high-check", "type": "ai", "criticality": "high"},
    "actor": {"roles": ["reviewer"], "isLocalMode": false}
  }
}

test_reviewer_denied_when_no_criticality {
  not allowed with input as {
    "scope": "check.execute",
    "check": {"id": "some-check", "type": "command"},
    "actor": {"roles": ["reviewer"], "isLocalMode": false}
  }
}

test_reviewer_denied_for_critical_criticality {
  not allowed with input as {
    "scope": "check.execute",
    "check": {"id": "critical-check", "type": "command", "criticality": "critical"},
    "actor": {"roles": ["reviewer"], "isLocalMode": false}
  }
}

# ---------------------------------------------------------------------------
# Per-step policy.require – string match
# ---------------------------------------------------------------------------

test_require_string_match {
  allowed with input as {
    "scope": "check.execute",
    "check": {"id": "custom-step", "type": "command", "policy": {"require": "developer"}},
    "actor": {"roles": ["developer"], "isLocalMode": false}
  }
}

test_require_string_no_match {
  not allowed with input as {
    "scope": "check.execute",
    "check": {"id": "custom-step", "type": "command", "policy": {"require": "admin"}},
    "actor": {"roles": ["external"], "isLocalMode": false}
  }
}

test_require_string_exact_role {
  allowed with input as {
    "scope": "check.execute",
    "check": {"id": "ops-step", "type": "command", "policy": {"require": "ops"}},
    "actor": {"roles": ["ops"], "isLocalMode": false}
  }
}

# ---------------------------------------------------------------------------
# Per-step policy.require – array match
# ---------------------------------------------------------------------------

test_require_array_match_first_element {
  allowed with input as {
    "scope": "check.execute",
    "check": {"id": "multi-role-step", "type": "command", "policy": {"require": ["admin", "developer"]}},
    "actor": {"roles": ["admin"], "isLocalMode": false}
  }
}

test_require_array_match_second_element {
  allowed with input as {
    "scope": "check.execute",
    "check": {"id": "multi-role-step", "type": "command", "policy": {"require": ["admin", "developer"]}},
    "actor": {"roles": ["developer"], "isLocalMode": false}
  }
}

test_require_array_no_match {
  not allowed with input as {
    "scope": "check.execute",
    "check": {"id": "multi-role-step", "type": "command", "policy": {"require": ["admin", "developer"]}},
    "actor": {"roles": ["external"], "isLocalMode": false}
  }
}

# ---------------------------------------------------------------------------
# Local mode – CLI gets broader access regardless of roles
# ---------------------------------------------------------------------------

test_local_mode_allows_everything {
  allowed with input as {
    "scope": "check.execute",
    "check": {"id": "deploy-production", "type": "command"},
    "actor": {"roles": [], "isLocalMode": true}
  }
}

test_local_mode_allows_with_no_roles {
  allowed with input as {
    "scope": "check.execute",
    "check": {"id": "any-check", "type": "ai"},
    "actor": {"roles": [], "isLocalMode": true}
  }
}

test_local_mode_false_does_not_grant_access {
  not allowed with input as {
    "scope": "check.execute",
    "check": {"id": "deploy-production", "type": "command"},
    "actor": {"roles": [], "isLocalMode": false}
  }
}

# ---------------------------------------------------------------------------
# Deny cases – no matching role and not local mode
# ---------------------------------------------------------------------------

test_external_denied_for_production {
  not allowed with input as {
    "scope": "check.execute",
    "check": {"id": "deploy-production", "type": "command"},
    "actor": {"roles": ["external"], "isLocalMode": false}
  }
}

test_empty_roles_denied {
  not allowed with input as {
    "scope": "check.execute",
    "check": {"id": "lint-code", "type": "ai"},
    "actor": {"roles": [], "isLocalMode": false}
  }
}

test_unknown_role_denied {
  not allowed with input as {
    "scope": "check.execute",
    "check": {"id": "lint-code", "type": "ai"},
    "actor": {"roles": ["guest"], "isLocalMode": false}
  }
}

# ---------------------------------------------------------------------------
# Reason message
# ---------------------------------------------------------------------------

test_reason_present_when_denied {
  reason == "insufficient role for this check" with input as {
    "scope": "check.execute",
    "check": {"id": "deploy-production", "type": "command"},
    "actor": {"roles": ["external"], "isLocalMode": false}
  }
}

test_reason_not_defined_when_allowed {
  not reason with input as {
    "scope": "check.execute",
    "check": {"id": "deploy-production", "type": "command"},
    "actor": {"roles": ["admin"], "isLocalMode": false}
  }
}

# ---------------------------------------------------------------------------
# Multi-role actor – at least one matching role grants access
# ---------------------------------------------------------------------------

test_multi_role_actor_allowed_via_admin {
  allowed with input as {
    "scope": "check.execute",
    "check": {"id": "deploy-production", "type": "command"},
    "actor": {"roles": ["reviewer", "admin"], "isLocalMode": false}
  }
}

test_multi_role_actor_developer_plus_reviewer_non_production {
  allowed with input as {
    "scope": "check.execute",
    "check": {"id": "lint-code", "type": "ai"},
    "actor": {"roles": ["developer", "reviewer"], "isLocalMode": false}
  }
}

# ---------------------------------------------------------------------------
# Deny list tests
# ---------------------------------------------------------------------------

test_denied_blocks_admin_when_in_deny_list {
  not allowed with input as {
    "actor": {"roles": ["admin"], "isLocalMode": false},
    "check": {"id": "sensitive-check", "type": "ai", "policy": {"deny": ["admin"]}}
  }
}

test_denied_blocks_developer_when_in_deny_list {
  not allowed with input as {
    "actor": {"roles": ["developer"], "isLocalMode": false},
    "check": {"id": "some-check", "type": "ai", "policy": {"deny": ["developer"]}}
  }
}

test_denied_does_not_block_when_role_not_in_deny_list {
  allowed with input as {
    "actor": {"roles": ["admin"], "isLocalMode": false},
    "check": {"id": "some-check", "type": "ai", "policy": {"deny": ["external"]}}
  }
}

test_denied_with_empty_deny_list {
  allowed with input as {
    "actor": {"roles": ["admin"], "isLocalMode": false},
    "check": {"id": "some-check", "type": "ai", "policy": {"deny": []}}
  }
}

test_denied_reason_message {
  reason == "role is in the deny list for this check" with input as {
    "actor": {"roles": ["developer"], "isLocalMode": false},
    "check": {"id": "some-check", "type": "ai", "policy": {"deny": ["developer"]}}
  }
}

# ---------------------------------------------------------------------------
# Local mode + policy.require
# ---------------------------------------------------------------------------

test_local_mode_with_policy_require_enforces_roles {
  not allowed with input as {
    "actor": {"roles": [], "isLocalMode": true},
    "check": {"id": "secure-deploy", "type": "command", "policy": {"require": "admin"}}
  }
}

test_local_mode_with_policy_require_admin_allowed {
  allowed with input as {
    "actor": {"roles": ["admin"], "isLocalMode": true},
    "check": {"id": "secure-deploy", "type": "command", "policy": {"require": "admin"}}
  }
}
