# RFC: Bot Transports for Visor (Slack-first)

Status: Draft

This RFC proposes a Slack integration built on the event-bus/state-machine engine. The first iteration focuses on:
- A Slack frontend that subscribes to engine events and posts an evolving message per group (e.g., overview, review).
- Simple configuration via `frontends` in the workflow config, e.g.

```
frontends:
  - name: slack
    config:
      defaultChannel: C12345678
      groupChannels:
        overview: C87654321
```

Design notes:
- No placeholder/queued messages are posted; only content-producing events produce/modify messages.
- Messages are updated in-place (using `chat.update`) keyed by group. We do not rely on hidden markers in message text.
- Debounce/coalescing reduces API churn during bursts; terminal state forces an immediate flush.
- Future work will add inbound Slack handling (webhooks) to trigger workflows and attach conversation context.

