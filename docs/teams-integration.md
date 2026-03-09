# Microsoft Teams Integration

Visor provides Microsoft Teams bot integration via the Azure Bot Framework, enabling interactive workflows, AI-powered chat assistants, and automated responses directly in Teams 1:1 chats, group chats, and channels.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Teams App Manifest](#teams-app-manifest)
- [Configuration](#configuration)
- [Conversation Types](#conversation-types)
- [Features](#features)
- [Example Workflows](#example-workflows)
- [Webhook Setup](#webhook-setup)
- [Team and Channel IDs](#team-and-channel-ids)
- [Known Limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Related Documentation](#related-documentation)

## Overview

The Teams integration enables:

- **1:1 Conversations**: Respond to direct messages from users
- **Group Chat Support**: Respond in group chats when @mentioned
- **Channel Support**: Respond in Teams channels when @mentioned
- **Webhook-Based**: Receives messages via Azure Bot Framework webhooks
- **Markdown Formatting**: Teams renders standard Markdown natively — AI output passes through unchanged
- **Message Chunking**: Long responses auto-split at ~28KB Teams message limit
- **@Mention Stripping**: Bot @mentions are automatically removed from message text
- **User Allowlist**: Restrict which users can trigger workflows
- **Hot Reload**: Configuration changes picked up without restarting the bot

The integration uses the [`botbuilder`](https://www.npmjs.com/package/botbuilder) SDK for JWT token validation and Bot Framework protocol handling.

## Prerequisites

### Create an Azure Bot

1. **Create a Microsoft Entra ID (Azure AD) App Registration**:
   - Go to [Azure Portal](https://portal.azure.com) > Microsoft Entra ID > App registrations
   - Click "New registration"
   - Save the **Application (client) ID** — this is your `TEAMS_APP_ID`
   - Go to Certificates & secrets > New client secret
   - Save the **Client secret value** immediately — this is your `TEAMS_APP_PASSWORD`

2. **Create an Azure Bot resource**:
   - Go to Azure Portal > Create a resource > Azure Bot
   - Use the App ID from step 1
   - Set the messaging endpoint to: `https://your-domain.com/api/messages`

3. **Enable the Teams channel**:
   - In your Azure Bot resource > Channels
   - Add "Microsoft Teams" channel
   - Accept the Terms of Service and enable "Messaging"

4. **Install in Teams**:
   - Create an app manifest (see [Teams App Manifest](#teams-app-manifest) below)
   - Upload via Teams Admin Center or sideload in Teams
   - Or use the "Open in Teams" link from the Azure Bot resource

### Single-Tenant vs. Multi-Tenant

- **Single-tenant** (recommended): Restricts the bot to your organization's Azure AD directory. More secure for self-hosted Visor.
- **Multi-tenant**: Allows installation in any Teams organization. Use if you need cross-org access.

Set `TEAMS_TENANT_ID` for single-tenant bots. Omit it for multi-tenant.

### Environment Variables

```bash
# Required
export TEAMS_APP_ID="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
export TEAMS_APP_PASSWORD="your-client-secret"

# Optional
export TEAMS_TENANT_ID="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
export TEAMS_WEBHOOK_PORT="3978"
```

## Teams App Manifest

To install your bot in Teams, you need an app manifest package — a ZIP file containing `manifest.json`, `outline.png` (32x32), and `color.png` (192x192).

### Minimal Manifest

```json
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.23/MicrosoftTeams.schema.json",
  "manifestVersion": "1.23",
  "version": "1.0.0",
  "id": "YOUR-APP-ID-HERE",
  "name": { "short": "Visor Bot" },
  "developer": {
    "name": "Your Org",
    "websiteUrl": "https://example.com",
    "privacyUrl": "https://example.com/privacy",
    "termsOfUseUrl": "https://example.com/terms"
  },
  "description": {
    "short": "Visor AI assistant in Teams",
    "full": "Visor AI-powered assistant for code review and workflow automation in Microsoft Teams."
  },
  "icons": { "outline": "outline.png", "color": "color.png" },
  "accentColor": "#5B6DEF",
  "bots": [
    {
      "botId": "YOUR-APP-ID-HERE",
      "scopes": ["personal", "team", "groupChat"],
      "isNotificationOnly": false,
      "supportsFiles": false
    }
  ],
  "webApplicationInfo": {
    "id": "YOUR-APP-ID-HERE"
  }
}
```

Replace `YOUR-APP-ID-HERE` with your Azure Bot App ID (same as `TEAMS_APP_ID`).

### Scopes

| Scope | Description |
|-------|-------------|
| `personal` | 1:1 direct messages with the bot |
| `team` | Bot can be added to team channels |
| `groupChat` | Bot can be added to group chats |

Include only the scopes your workflow needs.

### Resource-Specific Consent (RSC) Permissions

To receive channel/group messages **without** requiring @mention, add RSC permissions to the manifest:

```json
{
  "authorization": {
    "permissions": {
      "resourceSpecific": [
        { "name": "ChannelMessage.Read.Group", "type": "Application" },
        { "name": "ChatMessage.Read.Chat", "type": "Application" }
      ]
    }
  }
}
```

| Permission | Scope | Description |
|-----------|-------|-------------|
| `ChannelMessage.Read.Group` | Team | Receive channel messages without @mention |
| `ChannelMessage.Send.Group` | Team | Send channel messages |
| `ChatMessage.Read.Chat` | Group chat | Receive group messages without @mention |
| `Member.Read.Group` | Team | Read team members |

Without RSC, the bot must be @mentioned in channels and group chats to receive messages.

### Uploading the Manifest

1. Create icon files: `outline.png` (32x32) and `color.png` (192x192)
2. ZIP all three files together: `manifest.json`, `outline.png`, `color.png`
3. Upload via one of:
   - **Teams Admin Center**: https://admin.teams.microsoft.com > Teams apps > Manage apps > Upload
   - **Sideload**: In Teams, go to Apps > Manage your apps > Upload a custom app
   - **Teams Developer Portal**: https://dev.teams.microsoft.com/apps

### Updating the Manifest

When updating your app:
1. Increment the `version` field (e.g., `1.0.0` → `1.1.0`)
2. Re-ZIP and re-upload
3. Reinstall the app in teams/chats for new permissions to take effect
4. Fully quit and relaunch Teams to refresh cached metadata

## Configuration

### CLI Flag

Enable the Teams webhook runner with the `--teams` flag:

```bash
visor --config workflow.yaml --teams
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TEAMS_APP_ID` | Yes | Azure AD App (client) ID |
| `TEAMS_APP_PASSWORD` | Yes | Azure AD App client secret |
| `TEAMS_TENANT_ID` | No | Tenant ID (for single-tenant apps) |
| `TEAMS_WEBHOOK_PORT` | No | Webhook server port (default: 3978) |

### Configuration File

Add Teams-specific configuration in your workflow YAML:

```yaml
version: "1"

teams:
  user_allowlist:              # Optional: limit to specific AAD user IDs
    - "user-aad-object-id-1"
    - "user-aad-object-id-2"

# Frontend configuration for posting to Teams
frontends:
  - name: teams

checks:
  # Your workflow checks...
```

### Teams Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `app_id` | string | `$TEAMS_APP_ID` | Azure AD App (client) ID |
| `app_password` | string | `$TEAMS_APP_PASSWORD` | Azure AD App client secret |
| `tenant_id` | string | `$TEAMS_TENANT_ID` | Tenant ID for single-tenant apps |
| `port` | number | `3978` | Webhook HTTP server port |
| `host` | string | `0.0.0.0` | Webhook HTTP server bind address |
| `user_allowlist` | string[] | `[]` | Limit to specific AAD user IDs (empty = all) |
| `workflow` | string | — | Optional workflow name to dispatch |

## Conversation Types

### 1:1 (Personal) Chats

- Messages are always processed (no mention requirement)
- Ideal for personal assistant workflows
- Each conversation gets its own workspace

### Group Chats

- Bot must be @mentioned to receive messages
- Teams automatically includes the @mention in the message text
- The adapter strips @mentions before passing text to workflows

### Channels

- Bot must be @mentioned to receive messages
- Works in any channel where the bot app is installed
- Channel and team IDs are available in webhook context

## Features

### Markdown Formatting

Teams renders standard Markdown natively. AI output passes through unchanged:

| Markdown | Teams Rendering |
|----------|----------------|
| `**bold**` | **bold** |
| `_italic_` | _italic_ |
| `~~strikethrough~~` | ~~strikethrough~~ |
| `` `code` `` | `code` |
| ```` ```block``` ```` | Code block |
| `[label](url)` | [label](url) |
| `> quote` | Blockquote |
| `# Header` | Header |
| `- item` | Bullet list |

### Message Chunking

Teams bot messages have a ~28KB size limit. Long AI responses are automatically split into multiple messages at newline boundaries.

### @Mention Stripping

In group chats and channels, Teams includes `<at>BotName</at>` in the message text when users @mention the bot. The adapter automatically strips these mentions so your workflow receives clean text.

### Webhook Context

When a Teams message triggers a workflow, the full event context is available in templates:

```yaml
checks:
  reply:
    type: ai
    prompt: |
      User: {{ webhook.event.from_name }}
      Message: {{ webhook.event.text }}
```

Available webhook fields:

| Field | Description |
|-------|-------------|
| `webhook.event.type` | Always `teams_message` |
| `webhook.event.text` | Message text (with @mentions stripped) |
| `webhook.event.from_id` | Sender's AAD user ID |
| `webhook.event.from_name` | Sender's display name |
| `webhook.event.conversation_id` | Conversation ID |
| `webhook.event.conversation_type` | `personal`, `groupChat`, or `channel` |
| `webhook.event.activity_id` | Bot Framework activity ID |
| `webhook.event.team_id` | Team ID (for channel conversations) |
| `webhook.event.channel_id` | Channel ID (for channel conversations) |
| `webhook.event.tenant_id` | Azure AD tenant ID |
| `webhook.teams_conversation` | Normalized conversation context |

### Deduplication

Messages are deduplicated by activity ID. Duplicate webhook deliveries are automatically filtered.

## Example Workflows

### Simple Chat Assistant

```yaml
version: "1"

checks:
  respond:
    type: ai
    schema: text
    on:
      - teams_message
      - manual
    prompt: |
      You are a helpful assistant running inside Visor.
      Respond concisely to the user's message.

      User message: {{ webhook.event.text }}
```

### Team Support Bot with Allowlist

```yaml
version: "1"

teams:
  user_allowlist:
    - "user-aad-id-1"
    - "user-aad-id-2"

frontends:
  - name: teams

checks:
  reply:
    type: ai
    schema: text
    on:
      - teams_message
    prompt: |
      You are a team support assistant.
      Answer the question briefly and professionally.

      User: {{ webhook.event.from_name }}
      Message: {{ webhook.event.text }}
```

### Running the Teams Bot

```bash
# Set environment variables
export TEAMS_APP_ID="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
export TEAMS_APP_PASSWORD="your-client-secret"

# Start the bot
visor --config workflow.yaml --teams

# With hot reload
visor --config workflow.yaml --teams --watch

# With debug logging
VISOR_DEBUG=true visor --config workflow.yaml --teams
```

The bot will:
1. Start an HTTP server on the configured port (default: 3978)
2. Handle POST requests at `/api/messages` with JWT token validation
3. Parse Bot Framework activities and extract message text
4. Filter by user allowlist and dedup by activity ID
5. Process messages through your workflow
6. Send formatted responses back to the originating conversation

## Webhook Setup

### Exposing Your Server

Azure Bot Framework requires a public HTTPS endpoint. Options:

**Development (ngrok):**
```bash
ngrok http 3978

# Then set the messaging endpoint in Azure Portal:
# https://abc123.ngrok.io/api/messages
```

**Development (Tailscale Funnel):**
```bash
tailscale funnel 3978

# Use the funnel URL as your messaging endpoint:
# https://your-machine.ts.net/api/messages
```

**Production:**
- Use a reverse proxy (nginx, Caddy) with HTTPS and a valid certificate
- Or deploy to Azure App Service, which provides HTTPS by default

### Azure Bot Configuration

1. Go to your Azure Bot resource > Configuration
2. Set **Messaging endpoint** to: `https://your-domain.com/api/messages`
3. Save the configuration

### Testing

1. Start the bot: `visor --config workflow.yaml --teams`
2. Open Teams and find your bot (search by name or use the "Open in Teams" link)
3. Send a message — the bot should respond

## Team and Channel IDs

When configuring per-team or per-channel settings, you may need the team or channel ID. These can be extracted from Teams URLs.

### Extracting from URLs

**Team URL:**
```
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations
                                  ^-- URL-decode this = team ID
```

**Channel URL:**
```
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName
                                      ^-- URL-decode this = channel ID
```

The `groupId` query parameter in Teams URLs is **not** the team ID — extract the ID from the URL path instead.

### From Webhook Context

Team and channel IDs are available in webhook event data:

```yaml
checks:
  log-ids:
    type: logger
    on: [teams_message]
    message: |
      Team ID: {{ webhook.event.team_id }}
      Channel ID: {{ webhook.event.channel_id }}
      Conversation ID: {{ webhook.event.conversation_id }}
```

## Teams Platform Notes

These are Microsoft Teams platform behaviors that affect all bots, not just Visor.

### Private Channels

Microsoft has limited bot support in private channels. Bots must be explicitly added to each private channel — team-level installation does not automatically apply. Webhook message delivery may not work in all tenants. As of early 2026, Microsoft is rolling out expanded app support for private channels but availability varies by tenant.

### Webhook Timeouts

The Bot Framework has a webhook timeout window. Slow LLM responses can exceed it, causing Azure to retry delivery. Visor handles this by accepting the webhook immediately and sending replies asynchronously via the stored conversation reference. The deduplication system filters out any retried deliveries.

### Markdown Rendering

Teams supports standard Markdown but some advanced formatting renders differently than other platforms:
- Complex nested tables may not render correctly
- Deeply nested lists may flatten
- HTML tags may be stripped or rendered unexpectedly

### Message Size Limit

Teams bot messages are limited to ~28KB. Visor automatically chunks longer responses at newline boundaries, sending them as multiple sequential messages.

### Voice Messages

Teams voice messages are not supported by the Bot Framework webhook API — bots only receive text-based activities.

### File/Media in Messages

The current Visor integration handles text messages only. File attachments and images in inbound messages are not processed. For outbound, messages are plain text/Markdown (no Adaptive Cards). This is a Visor limitation — the Bot Framework does support file handling via FileConsentCard (DMs) and SharePoint (channels), which may be added in a future release.

## Troubleshooting

### Connection Issues

**"TEAMS_APP_ID is required"**
- Set the `TEAMS_APP_ID` environment variable
- Or set `teams.app_id` in your config file

**"TEAMS_APP_PASSWORD is required"**
- Set the `TEAMS_APP_PASSWORD` environment variable
- Or set `teams.app_password` in your config file

**Bot starts but never receives messages**
- Verify the messaging endpoint URL in Azure Portal matches your server
- Ensure your server is reachable at the endpoint URL
- Check that the Teams channel is enabled in your Azure Bot resource
- Verify the App ID and App Password match your Azure AD registration

**401 Unauthorized errors in logs**
- The App ID or App Password is incorrect
- The bot registration in Azure may have expired credentials
- Regenerate the client secret in Azure AD

### Message Issues

**Bot not responding in group chats/channels**
- The bot must be @mentioned in group chats and channels
- Ensure the bot app is installed in the team/chat
- Check `user_allowlist` if configured — the user's AAD ID must be listed

**Bot responding to its own messages**
- This is handled automatically — the bot filters out messages from its own App ID

**Duplicate responses**
- The deduplication system handles this automatically
- If issues persist, check for multiple bot instances running

### Manifest Issues

**"Something went wrong" when uploading manifest**
- Ensure icon files are valid PNGs (not empty files): `outline.png` (32x32) and `color.png` (192x192)
- Try uploading via https://admin.teams.microsoft.com instead of sideloading
- Check DevTools Network tab for detailed error messages

**App ID conflict when uploading**
- Uninstall the existing app first, or wait 5-10 minutes for propagation
- Ensure the `id` field in manifest matches your Azure Bot App ID

**RSC permissions not working**
- Verify `webApplicationInfo.id` in manifest matches your App ID exactly
- Re-upload and reinstall the app in each team/chat
- Confirm your org admin hasn't blocked RSC permissions
- Check the correct scope: `ChannelMessage.Read.Group` for teams, `ChatMessage.Read.Chat` for group chats

**Old manifest still showing after update**
- Remove and re-add the app in Teams
- Fully quit Teams (not just close the window) and relaunch to refresh cached metadata

### Debug Mode

Enable verbose logging:

```bash
VISOR_DEBUG=true visor --config workflow.yaml --teams
```

Log messages include:
- `[TeamsWebhook]` — Webhook events, message dispatch, and filtering
- `[teams-frontend]` — Message posting and errors

## FAQ

**Does Teams integration require a Microsoft 365 paid plan?**

You need Azure Portal access (free-tier options available) and a Microsoft 365 tenant for Teams app installation. The Azure Bot resource itself is free for standard channels including Teams.

**Can the bot respond without @mention in channels?**

Yes, but it requires RSC permissions in the app manifest (`ChannelMessage.Read.Group` for channels, `ChatMessage.Read.Chat` for group chats). Without RSC, the bot only receives messages where it is @mentioned. In 1:1 (personal) chats, all messages are received regardless.

**Do I need a public URL?**

Yes. The Azure Bot Framework sends webhook events to your server's `/api/messages` endpoint, which must be publicly accessible via HTTPS. For local development, use ngrok or Tailscale Funnel to create a tunnel.

**What happens if my server is slow to respond?**

Visor accepts the webhook quickly and processes the message asynchronously. Responses are sent back proactively using the stored conversation reference. If Azure retries the webhook, the deduplication system prevents duplicate processing.

**Can I use the same bot in multiple workflows?**

Use the `teams.workflow` config option to route all Teams messages to a specific workflow, or use the `on: [teams_message]` event trigger on individual checks to handle messages in any workflow.

## Related Documentation

- [Slack Integration](./slack-integration.md) — Bidirectional Slack integration via Socket Mode
- [Telegram Integration](./telegram-integration.md) — Telegram bot integration via long polling
- [Email Integration](./email-integration.md) — Bidirectional email integration via IMAP/SMTP or Resend
- [WhatsApp Integration](./whatsapp-integration.md) — WhatsApp bot integration via Cloud API webhooks
- [Event Triggers](./event-triggers.md) — GitHub events and how to trigger checks
- [Liquid Templates](./liquid-templates.md) — Template syntax for dynamic content in prompts
- [Configuration](./configuration.md) — Core configuration reference
- [Bot Transports RFC](./bot-transports-rfc.md) — Technical design document for bot integrations

## See Also

- [examples/teams-assistant.yaml](../examples/teams-assistant.yaml) — Simple Teams chat assistant example
