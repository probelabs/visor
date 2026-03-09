# WhatsApp Integration

Visor provides WhatsApp bot integration via the WhatsApp Cloud API (Meta Graph API), enabling interactive workflows, AI-powered chat assistants, and automated responses directly in WhatsApp conversations.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Configuration](#configuration)
- [Features](#features)
- [Example Workflows](#example-workflows)
- [Webhook Setup](#webhook-setup)
- [Troubleshooting](#troubleshooting)
- [Related Documentation](#related-documentation)

## Overview

The WhatsApp integration enables:

- **Direct Conversations**: Respond to incoming WhatsApp messages from users
- **Webhook-Based**: Receives messages via Meta webhook events (no polling)
- **WhatsApp Formatting**: Markdown AI output automatically converted to WhatsApp format (`*bold*`, `_italic_`, `~strike~`, `` ```code``` ``)
- **Message Chunking**: Long responses auto-split at 4096-character WhatsApp limit
- **Read Receipts**: Messages automatically marked as read after processing
- **Signature Verification**: HMAC-SHA256 webhook payload verification via `X-Hub-Signature-256`
- **Phone Allowlist**: Restrict which phone numbers can trigger workflows
- **Hot Reload**: Configuration changes picked up without restarting the bot

The integration uses `fetch` directly against the Meta Graph API — no additional npm dependencies required.

## Prerequisites

### Create a WhatsApp Business App

1. **Create a Meta Business Account** at [business.facebook.com](https://business.facebook.com)

2. **Create a Meta App** at [developers.facebook.com](https://developers.facebook.com):
   - Click "Create App" → choose "Business" type
   - Add the **WhatsApp** product to your app

3. **Get credentials** from the WhatsApp > Getting Started page:
   - **Phone Number ID**: The ID of your WhatsApp business phone number
   - **Access Token**: A permanent system user token (or temporary token for testing)

4. **Get App Secret** from App Settings > Basic:
   - Used for webhook signature verification (recommended)

5. **Choose a Verify Token**: Any string you create — used during webhook subscription

### Environment Variables

```bash
# Required
export WHATSAPP_ACCESS_TOKEN="EAAxxxxxxxx..."
export WHATSAPP_PHONE_NUMBER_ID="123456789012345"

# Recommended
export WHATSAPP_APP_SECRET="abcdef1234567890"
export WHATSAPP_VERIFY_TOKEN="my-custom-verify-token"

# Optional
export WHATSAPP_WEBHOOK_PORT="8443"
```

## Configuration

### CLI Flag

Enable the WhatsApp webhook runner with the `--whatsapp` flag:

```bash
visor --config workflow.yaml --whatsapp
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `WHATSAPP_ACCESS_TOKEN` | Yes | Cloud API access token from Meta Business Suite |
| `WHATSAPP_PHONE_NUMBER_ID` | Yes | Phone Number ID from WhatsApp > Getting Started |
| `WHATSAPP_APP_SECRET` | Recommended | Meta App Secret for webhook signature verification |
| `WHATSAPP_VERIFY_TOKEN` | Yes | User-chosen token for webhook subscription challenge |
| `WHATSAPP_WEBHOOK_PORT` | No | Webhook server port (default: 8443) |

### Configuration File

Add WhatsApp-specific configuration in your workflow YAML:

```yaml
version: "1"

whatsapp:
  phone_allowlist:           # Optional: limit to specific phone numbers
    - "15551234567"
    - "15559876543"

# Frontend configuration for posting to WhatsApp
frontends:
  - name: whatsapp

checks:
  # Your workflow checks...
```

### WhatsApp Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `access_token` | string | `$WHATSAPP_ACCESS_TOKEN` | Cloud API access token (config overrides env) |
| `phone_number_id` | string | `$WHATSAPP_PHONE_NUMBER_ID` | WhatsApp business phone number ID |
| `app_secret` | string | `$WHATSAPP_APP_SECRET` | App Secret for webhook signature verification |
| `verify_token` | string | `$WHATSAPP_VERIFY_TOKEN` | Token for webhook subscription challenge-response |
| `api_version` | string | `v21.0` | Meta Graph API version |
| `port` | number | `8443` | Webhook HTTP server port |
| `host` | string | `0.0.0.0` | Webhook HTTP server bind address |
| `phone_allowlist` | string[] | `[]` | Limit to specific phone numbers (empty = all) |
| `workflow` | string | — | Optional workflow name to dispatch |

## Features

### Message Posting and Threading

The WhatsApp frontend automatically posts AI responses back to the sender:

- AI check outputs with `text` fields are sent as replies
- Messages are formatted using WhatsApp text formatting
- Replies include `context.message_id` to quote the original message

```yaml
checks:
  reply:
    type: ai
    schema: text
    on:
      - whatsapp_message
      - manual
    prompt: |
      You are a helpful assistant.
      Respond concisely to the user's message.

      User message: {{ webhook.event.text }}
```

### Markdown to WhatsApp Conversion

AI output in Markdown is automatically converted to WhatsApp format:

| Markdown | WhatsApp |
|----------|----------|
| `# Header` | `*Header*` (bold) |
| `**bold**` | `*bold*` |
| `*italic*` | `_italic_` |
| `` `code` `` | `` ```code``` `` |
| ```` ```block``` ```` | ```` ```block``` ```` (preserved) |
| `[label](url)` | `label (url)` |
| `~~strike~~` | `~strike~` |
| `> quote` | `> quote` (preserved) |
| `- item` | `- item` (preserved) |

### Message Chunking

WhatsApp limits text messages to 4096 characters. Long AI responses are automatically split into multiple messages at newline boundaries. Very long single lines are force-split at the character limit.

### Read Receipts

Incoming messages are automatically marked as read (blue check marks) after processing. This provides visual feedback to the sender that their message was received.

### Webhook Signature Verification

When `app_secret` is configured, all incoming webhook payloads are verified against the `X-Hub-Signature-256` header using HMAC-SHA256. Invalid signatures are rejected with 403.

### Phone Allowlist

Restrict which phone numbers can trigger workflows:

```yaml
whatsapp:
  phone_allowlist:
    - "15551234567"
    - "15559876543"
```

When the allowlist is empty (default), messages from any phone number are processed. Phone numbers are normalized (stripped of `+` prefix and whitespace) for comparison.

### Webhook Context

When a WhatsApp message triggers a workflow, the full event context is available in templates:

```yaml
checks:
  reply:
    type: ai
    prompt: |
      From: {{ webhook.event.from }}
      Message: {{ webhook.event.text }}
```

Available webhook fields:

| Field | Description |
|-------|-------------|
| `webhook.event.type` | Always `whatsapp_message` |
| `webhook.event.from` | Sender phone number |
| `webhook.event.message_id` | WhatsApp message ID (`wamid.*`) |
| `webhook.event.text` | Message text content |
| `webhook.event.caption` | Media caption (for image/video/document messages) |
| `webhook.event.timestamp` | Message timestamp |
| `webhook.event.display_name` | Sender's display name (if available) |
| `webhook.whatsapp_conversation` | Normalized conversation context |

### Deduplication

Messages are deduplicated by WhatsApp message ID (`wamid.*`). Duplicate webhook deliveries from Meta are automatically filtered. Dedup entries expire after 1 hour.

## Example Workflows

### Simple Chat Assistant

```yaml
version: "1"

whatsapp:
  # No allowlist = accept messages from anyone

checks:
  respond:
    type: ai
    schema: text
    on:
      - whatsapp_message
      - manual
    prompt: |
      You are a helpful assistant running inside Visor.
      Respond concisely to the user's message.

      User message: {{ webhook.event.text }}
```

### Customer Support Bot with Allowlist

```yaml
version: "1"

whatsapp:
  phone_allowlist:
    - "15551234567"
    - "15559876543"

frontends:
  - name: whatsapp

checks:
  reply:
    type: ai
    schema: text
    on:
      - whatsapp_message
    prompt: |
      You are a customer support assistant.
      Answer the question briefly and professionally.

      Customer message: {{ webhook.event.text }}
```

### Running the WhatsApp Bot

```bash
# Set environment variables
export WHATSAPP_ACCESS_TOKEN="EAAxxxxxxxx..."
export WHATSAPP_PHONE_NUMBER_ID="123456789012345"
export WHATSAPP_APP_SECRET="abcdef1234567890"
export WHATSAPP_VERIFY_TOKEN="my-custom-verify-token"

# Start the bot
visor --config workflow.yaml --whatsapp

# With hot reload
visor --config workflow.yaml --whatsapp --watch

# With debug logging
VISOR_DEBUG=true visor --config workflow.yaml --whatsapp
```

The bot will:
1. Start an HTTP server on the configured port (default: 8443)
2. Handle GET requests for webhook subscription challenge-response
3. Handle POST requests for incoming messages with signature verification
4. Filter messages by phone allowlist and dedup by message ID
5. Process messages through your workflow
6. Send formatted responses back to the sender with quoted reply

## Webhook Setup

### Setting Up Meta Webhooks

After starting the Visor WhatsApp bot, you need to configure Meta to send webhooks to your server:

1. **Expose your server** to the internet:
   - Use a reverse proxy (nginx, Caddy) with HTTPS
   - Or use a tunnel service (ngrok, Cloudflare Tunnel) for development

2. **Configure webhooks** in Meta App Dashboard:
   - Go to WhatsApp > Configuration > Webhook
   - Set the Callback URL to: `https://your-domain.com/webhooks/whatsapp`
   - Set the Verify Token to the same value as `WHATSAPP_VERIFY_TOKEN`
   - Click "Verify and Save"
   - Subscribe to the `messages` field

3. **Test the webhook**:
   - Send a message to your WhatsApp Business number from a personal WhatsApp account
   - Check logs for incoming message processing

### HTTPS Requirement

Meta requires webhook URLs to use HTTPS. For local development:

```bash
# Using ngrok
ngrok http 8443

# Then use the ngrok URL as your webhook callback:
# https://abc123.ngrok.io/webhooks/whatsapp
```

### 24-Hour Messaging Window

WhatsApp Business API has a 24-hour messaging window rule:

- **Within 24 hours** of the last user message: You can send any message
- **After 24 hours**: You can only send pre-approved message templates

For conversational bots, this is generally not an issue since replies are sent immediately after receiving a user message.

## Troubleshooting

### Connection Issues

**"WHATSAPP_ACCESS_TOKEN is required"**
- Ensure the `WHATSAPP_ACCESS_TOKEN` environment variable is set
- Or set `whatsapp.access_token` in your config file

**"WHATSAPP_PHONE_NUMBER_ID is required"**
- Ensure the `WHATSAPP_PHONE_NUMBER_ID` environment variable is set
- Or set `whatsapp.phone_number_id` in your config file

**Webhook verification fails**
- Verify the `WHATSAPP_VERIFY_TOKEN` matches what you entered in Meta App Dashboard
- Ensure your server is reachable at the callback URL
- Check that the URL path is `/webhooks/whatsapp`

### Message Issues

**Bot not receiving messages**
- Verify webhook subscription is active in Meta App Dashboard
- Check that the `messages` field is subscribed
- Verify webhook signature — check `WHATSAPP_APP_SECRET` matches your App Secret
- Enable debug mode to see webhook activity

**Bot not sending replies**
- Verify `WHATSAPP_ACCESS_TOKEN` has the `whatsapp_business_messaging` permission
- Check the 24-hour messaging window hasn't expired
- Check logs for Graph API error responses

**Messages rejected by Meta API**
- Verify the `phone_number_id` matches your registered WhatsApp number
- Check that the recipient phone number is in E.164 format (e.g., `15551234567`)

**Duplicate messages**
- The deduplication system handles this automatically
- Meta may retry webhook deliveries — these are filtered by message ID

### Formatting Issues

**Messages look different than expected**
- WhatsApp has limited formatting: `*bold*`, `_italic_`, `~strike~`, `` ```code``` ``
- No support for headers, links, or nested formatting
- The converter makes best-effort approximations

**Messages truncated**
- Messages over 4096 characters are automatically chunked into multiple messages
- Very long single lines are force-split at the character limit

### Debug Mode

Enable verbose logging:

```bash
VISOR_DEBUG=true visor --config workflow.yaml --whatsapp
```

Log messages include:
- `[WhatsAppWebhook]` — Webhook events, message dispatch, and filtering
- `[whatsapp-frontend]` — Message posting and errors

## Related Documentation

- [Slack Integration](./slack-integration.md) — Bidirectional Slack integration via Socket Mode
- [Telegram Integration](./telegram-integration.md) — Telegram bot integration via long polling
- [Email Integration](./email-integration.md) — Bidirectional email integration via IMAP/SMTP or Resend
- [Event Triggers](./event-triggers.md) — GitHub events and how to trigger checks
- [Liquid Templates](./liquid-templates.md) — Template syntax for dynamic content in prompts
- [Configuration](./configuration.md) — Core configuration reference
- [Recipes](./recipes.md) — Common workflow patterns including chat loops
- [Bot Transports RFC](./bot-transports-rfc.md) — Technical design document for bot integrations

## See Also

- [examples/whatsapp-assistant.yaml](../examples/whatsapp-assistant.yaml) — Simple WhatsApp chat assistant example
