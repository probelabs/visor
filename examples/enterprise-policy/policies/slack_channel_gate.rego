package visor.check.execute

# Block deploy checks when triggered from Slack DMs.
# Deploy checks should only run from designated channels.
is_from_dm {
  input.actor.slack.channelType == "dm"
}

allowed = false {
  startswith(input.check.id, "deploy-")
  is_from_dm
}

reason = "deploy checks cannot be triggered from Slack DMs" {
  startswith(input.check.id, "deploy-")
  is_from_dm
}
