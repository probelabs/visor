package visor.deploy.production

test_admin_allowed_with_main_branch {
  allowed with input as {
    "actor": {"roles": ["admin"], "isLocalMode": false},
    "repository": {"baseBranch": "main"}
  }
}

test_admin_denied_without_main_branch {
  not allowed with input as {
    "actor": {"roles": ["admin"], "isLocalMode": false},
    "repository": {"baseBranch": "develop"}
  }
}

test_non_admin_denied {
  not allowed with input as {
    "actor": {"roles": ["developer"], "isLocalMode": false},
    "repository": {"baseBranch": "main"}
  }
}

test_reason_when_denied {
  reason == "only admins can deploy to production" with input as {
    "actor": {"roles": ["developer"], "isLocalMode": false},
    "repository": {"baseBranch": "main"}
  }
}
