# Tests for AI capability restriction policy
# Run with: opa test examples/enterprise-policy/policies/

package visor.capability.resolve

# ---------------------------------------------------------------------------
# External contributors – allowBash=false and allowEdit=false
# ---------------------------------------------------------------------------

test_external_gets_allowBash_false {
  capabilities["allowBash"] == false with input as {
    "scope": "capability.resolve",
    "check": {"id": "ai-review", "type": "ai"},
    "capability": {"allowEdit": true, "allowBash": true},
    "actor": {"roles": ["external"], "isLocalMode": false}
  }
}

test_external_gets_allowEdit_false {
  capabilities["allowEdit"] == false with input as {
    "scope": "capability.resolve",
    "check": {"id": "ai-review", "type": "ai"},
    "capability": {"allowEdit": true, "allowBash": true},
    "actor": {"roles": ["external"], "isLocalMode": false}
  }
}

test_external_both_restricted {
  caps := capabilities with input as {
    "scope": "capability.resolve",
    "check": {"id": "ai-review", "type": "ai"},
    "capability": {"allowEdit": true, "allowBash": true},
    "actor": {"roles": ["external"], "isLocalMode": false}
  }
  caps["allowBash"] == false
  caps["allowEdit"] == false
}

# ---------------------------------------------------------------------------
# Reviewer – not developer/admin so allowEdit=false, not external so no bash restriction
# ---------------------------------------------------------------------------

test_reviewer_gets_allowEdit_false {
  capabilities["allowEdit"] == false with input as {
    "scope": "capability.resolve",
    "check": {"id": "ai-review", "type": "ai"},
    "capability": {"allowEdit": true, "allowBash": true},
    "actor": {"roles": ["reviewer"], "isLocalMode": false}
  }
}

test_reviewer_no_allowBash_restriction {
  not capabilities["allowBash"] with input as {
    "scope": "capability.resolve",
    "check": {"id": "ai-review", "type": "ai"},
    "capability": {"allowEdit": true, "allowBash": true},
    "actor": {"roles": ["reviewer"], "isLocalMode": false}
  }
}

# ---------------------------------------------------------------------------
# Developer – keeps allowEdit (is_developer), no bash restriction
# ---------------------------------------------------------------------------

test_developer_no_allowEdit_restriction {
  not capabilities["allowEdit"] with input as {
    "scope": "capability.resolve",
    "check": {"id": "ai-review", "type": "ai"},
    "capability": {"allowEdit": true, "allowBash": true},
    "actor": {"roles": ["developer"], "isLocalMode": false}
  }
}

test_developer_no_allowBash_restriction {
  not capabilities["allowBash"] with input as {
    "scope": "capability.resolve",
    "check": {"id": "ai-review", "type": "ai"},
    "capability": {"allowEdit": true, "allowBash": true},
    "actor": {"roles": ["developer"], "isLocalMode": false}
  }
}

test_developer_capabilities_empty {
  # Developer should produce no capability restrictions at all
  count(capabilities) == 0 with input as {
    "scope": "capability.resolve",
    "check": {"id": "ai-review", "type": "ai"},
    "capability": {"allowEdit": true, "allowBash": true},
    "actor": {"roles": ["developer"], "isLocalMode": false}
  }
}

# ---------------------------------------------------------------------------
# Admin – keeps everything (is_admin bypasses allowEdit restriction)
# ---------------------------------------------------------------------------

test_admin_no_allowEdit_restriction {
  not capabilities["allowEdit"] with input as {
    "scope": "capability.resolve",
    "check": {"id": "ai-review", "type": "ai"},
    "capability": {"allowEdit": true, "allowBash": true},
    "actor": {"roles": ["admin"], "isLocalMode": false}
  }
}

test_admin_no_allowBash_restriction {
  not capabilities["allowBash"] with input as {
    "scope": "capability.resolve",
    "check": {"id": "ai-review", "type": "ai"},
    "capability": {"allowEdit": true, "allowBash": true},
    "actor": {"roles": ["admin"], "isLocalMode": false}
  }
}

test_admin_capabilities_empty {
  count(capabilities) == 0 with input as {
    "scope": "capability.resolve",
    "check": {"id": "ai-review", "type": "ai"},
    "capability": {"allowEdit": true, "allowBash": true},
    "actor": {"roles": ["admin"], "isLocalMode": false}
  }
}

# ---------------------------------------------------------------------------
# Empty roles – not developer, not admin => allowEdit=false; not external => no bash
# ---------------------------------------------------------------------------

test_empty_roles_gets_allowEdit_false {
  capabilities["allowEdit"] == false with input as {
    "scope": "capability.resolve",
    "check": {"id": "ai-review", "type": "ai"},
    "capability": {"allowEdit": true, "allowBash": true},
    "actor": {"roles": [], "isLocalMode": false}
  }
}

test_empty_roles_no_allowBash_restriction {
  not capabilities["allowBash"] with input as {
    "scope": "capability.resolve",
    "check": {"id": "ai-review", "type": "ai"},
    "capability": {"allowEdit": true, "allowBash": true},
    "actor": {"roles": [], "isLocalMode": false}
  }
}

# ---------------------------------------------------------------------------
# Helper rules
# ---------------------------------------------------------------------------

test_is_developer_true {
  is_developer with input as {
    "actor": {"roles": ["developer"], "isLocalMode": false}
  }
}

test_is_developer_false_for_reviewer {
  not is_developer with input as {
    "actor": {"roles": ["reviewer"], "isLocalMode": false}
  }
}

test_is_admin_true {
  is_admin with input as {
    "actor": {"roles": ["admin"], "isLocalMode": false}
  }
}

test_is_admin_false_for_developer {
  not is_admin with input as {
    "actor": {"roles": ["developer"], "isLocalMode": false}
  }
}

test_is_admin_false_for_empty_roles {
  not is_admin with input as {
    "actor": {"roles": [], "isLocalMode": false}
  }
}

# ---------------------------------------------------------------------------
# Multi-role actors
# ---------------------------------------------------------------------------

test_developer_and_external_keeps_edit_but_loses_bash {
  # developer satisfies is_developer so allowEdit is not restricted
  # external triggers allowBash=false
  caps := capabilities with input as {
    "scope": "capability.resolve",
    "check": {"id": "ai-review", "type": "ai"},
    "capability": {"allowEdit": true, "allowBash": true},
    "actor": {"roles": ["developer", "external"], "isLocalMode": false}
  }
  not caps["allowEdit"]
  caps["allowBash"] == false
}

test_admin_and_external_keeps_edit_but_loses_bash {
  # admin satisfies is_admin so allowEdit is not restricted
  # external role still triggers allowBash=false
  caps := capabilities with input as {
    "scope": "capability.resolve",
    "check": {"id": "ai-review", "type": "ai"},
    "capability": {"allowEdit": true, "allowBash": true},
    "actor": {"roles": ["admin", "external"], "isLocalMode": false}
  }
  not caps["allowEdit"]
  caps["allowBash"] == false
}

# ---------------------------------------------------------------------------
# Unknown role – not developer/admin => allowEdit=false, not external => no bash
# ---------------------------------------------------------------------------

test_unknown_role_gets_allowEdit_false {
  capabilities["allowEdit"] == false with input as {
    "scope": "capability.resolve",
    "check": {"id": "ai-review", "type": "ai"},
    "capability": {"allowEdit": true, "allowBash": true},
    "actor": {"roles": ["guest"], "isLocalMode": false}
  }
}

test_unknown_role_no_allowBash_restriction {
  not capabilities["allowBash"] with input as {
    "scope": "capability.resolve",
    "check": {"id": "ai-review", "type": "ai"},
    "capability": {"allowEdit": true, "allowBash": true},
    "actor": {"roles": ["guest"], "isLocalMode": false}
  }
}
