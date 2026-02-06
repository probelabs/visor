# RFC: Bot Transports for Visor (Slack-first)

Status: Implemented

This RFC proposes a Slack integration built on the event-bus/state-machine engine. The first iteration focuses on:
- A Slack frontend that subscribes to engine events and posts an evolving message per group (e.g., overview, review).
- Simple configuration via `frontends` in the workflow config, e.g.

```yaml
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
- Inbound Slack handling is now implemented via Socket Mode (`src/slack/socket-runner.ts`) to trigger workflows and attach conversation context.

## Implementation

The Slack integration is implemented across these key files:
- `src/frontends/slack-frontend.ts` - Frontend that subscribes to engine events
- `src/frontends/host.ts` - Frontend host that manages lifecycle
- `src/slack/client.ts` - Lightweight Slack Web API wrapper
- `src/slack/socket-runner.ts` - Socket Mode for inbound Slack events
- `src/slack/adapter.ts` - Slack adapter for message handling
- `src/slack/markdown.ts` - Markdown to Slack mrkdwn conversion

