# Bot Integrations

Visor supports five bot transports that let you run the same YAML workflows interactively through different messaging platforms. Each integration follows the same architecture: an inbound message triggers a workflow run, and results are posted back to the originating conversation.

## Quick Comparison

| | Slack | Telegram | Email | WhatsApp | Teams |
|---|---|---|---|---|---|
| **CLI flag** | `--slack` | `--telegram` | `--email` | `--whatsapp` | `--teams` |
| **Protocol** | WebSocket (Socket Mode) | Long polling | IMAP polling / webhooks | Webhook (Cloud API) | Webhook (Bot Framework) |
| **Auth** | Bot token + App token | Bot token | IMAP creds or Resend API key | Meta access token + verify token | Azure AD app ID + secret |
| **Threading** | Slack threads | Reply-to message | Email threads (In-Reply-To) | WhatsApp reply | Bot Framework reply |
| **Reactions** | :eyes: / :thumbsup: | N/A | N/A | N/A | N/A |
| **Markdown** | Slack mrkdwn (converted) | MarkdownV2 (escaped) | HTML (converted) | WhatsApp formatting (*bold*, _italic_) | Standard Markdown (passthrough) |
| **Message limit** | ~40KB (blocks) | 4096 chars | Unlimited | 4096 chars | ~28KB |
| **@mention required** | In channels | In groups | N/A | N/A | In channels/groups |
| **User allowlist** | Yes | Yes | Yes | Yes | Yes |
| **Hot reload** | Yes (`--watch`) | Yes (`--watch`) | Yes (`--watch`) | Yes (`--watch`) | Yes (`--watch`) |
| **Event trigger** | `slack_message` | `telegram_message` | `email_received` | `whatsapp_message` | `teams_message` |
| **Default port** | N/A (WebSocket) | N/A (polling) | N/A (polling) | 8443 | 3978 |

## Integration Guides

Each integration has a dedicated guide with setup instructions, configuration reference, example workflows, and troubleshooting:

- **[Slack Integration](./slack-integration.md)** — Bidirectional Slack integration via Socket Mode. Supports reactions, Mermaid diagram rendering, human-input prompts, and scheduled reminders.

- **[Telegram Integration](./telegram-integration.md)** — Telegram bot via long polling. Supports 1:1 chats, group chats, forum topics, and channels. Uses MarkdownV2 formatting.

- **[Email Integration](./email-integration.md)** — Bidirectional email via IMAP+SMTP or Resend API. Supports threaded conversations and HTML formatting.

- **[WhatsApp Integration](./whatsapp-integration.md)** — WhatsApp bot via Meta Cloud API webhooks. Supports webhook verification, WhatsApp-specific formatting, and 4096-char chunking.

- **[Microsoft Teams Integration](./teams-integration.md)** — Teams bot via Azure Bot Framework. Supports 1:1 chats, group chats, channels, @mention stripping, and Teams App Manifest setup with RSC permissions.

## Architecture

All bot integrations share the same architecture:

1. **Inbound handler** (polling runner or webhook runner) receives messages from the platform
2. **Adapter** normalizes the message into a common format with conversation context
3. **Engine** executes the workflow checks, with webhook data available in Liquid templates via `{{ webhook.event.* }}`
4. **Frontend** subscribes to engine events (CheckCompleted, CheckErrored) and posts results back via the platform client
5. **Client** handles outbound messaging, including markdown conversion and message chunking

```
Platform → Runner → Adapter → Engine → Frontend → Client → Platform
```

Each integration lives in its own directory (`src/slack/`, `src/telegram/`, `src/email/`, `src/whatsapp/`, `src/teams/`) with the same file structure: `client.ts`, `adapter.ts`, `markdown.ts`, and a runner (`socket-runner.ts`, `polling-runner.ts`, or `webhook-runner.ts`).

For the full technical design, see the [Bot Transports RFC](./bot-transports-rfc.md).

## Common Patterns

### User Allowlist

All integrations support restricting which users can trigger workflows:

```yaml
slack:
  user_allowlist: ["U12345"]
telegram:
  user_allowlist: ["123456789"]
email:
  user_allowlist: ["user@example.com"]
whatsapp:
  user_allowlist: ["15551234567"]
teams:
  user_allowlist: ["aad-object-id"]
```

When the allowlist is empty (default), all users are permitted.

### Event Triggers

Use `on:` to restrict checks to specific bot events:

```yaml
checks:
  respond:
    type: ai
    on:
      - slack_message
      - telegram_message
      - whatsapp_message
      - teams_message
      - email_received
      - manual
    prompt: |
      Respond to: {{ webhook.event.text }}
```

### Frontends

Enable the frontend to post results back to the originating conversation:

```yaml
frontends:
  - name: slack
  - name: telegram
  - name: email
  - name: whatsapp
  - name: teams
```

Each frontend only activates when its corresponding bot runner is active.

### Hot Reload

All bot modes support `--watch` for live config reload without restarting:

```bash
visor --slack --config workflow.yaml --watch
visor --telegram --config workflow.yaml --watch
visor --teams --config workflow.yaml --watch
```

## See Also

- [Assistant Workflows](./assistant-workflows.md) — How to build interactive AI assistants
- [Event Triggers](./event-triggers.md) — Full list of event types
- [Bot Transports RFC](./bot-transports-rfc.md) — Technical architecture design document
- [Liquid Templates](./liquid-templates.md) — Template syntax for accessing webhook data
