# Email Integration

Visor provides bidirectional email integration, enabling interactive workflows, AI-powered assistants, and automated responses via email threads. Supports IMAP+SMTP (universal) and Resend (managed) backends.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Configuration](#configuration)
- [Backends](#backends)
- [Email Threading](#email-threading)
- [Features](#features)
- [Example Workflows](#example-workflows)
- [Troubleshooting](#troubleshooting)
- [Related Documentation](#related-documentation)

## Overview

The email integration enables:

- **Full Conversation Support**: Thread-aware replies using Message-ID / In-Reply-To / References headers
- **IMAP Receive**: Universal inbound via IMAP polling (works with Gmail, Outlook, Fastmail, any provider)
- **Resend Receive**: Managed inbound via webhooks with full content retrieval
- **SMTP Send**: Universal outbound via any SMTP server
- **Resend Send**: Managed outbound via Resend API with threading headers
- **HTML Formatting**: Markdown AI output converted to email HTML with inline CSS
- **Sender Allowlist**: Restrict which senders can trigger workflows
- **Hot Reload**: Configuration changes picked up without restarting

## Prerequisites

### IMAP + SMTP (Universal)

Works with any email provider that supports IMAP and SMTP:

```bash
# Required
export EMAIL_IMAP_HOST="imap.gmail.com"
export EMAIL_SMTP_HOST="smtp.gmail.com"
export EMAIL_USER="your-email@gmail.com"
export EMAIL_PASSWORD="your-app-password"
export EMAIL_FROM="Visor Bot <your-email@gmail.com>"
```

> **Gmail users**: You need an [App Password](https://support.google.com/accounts/answer/185833) (not your regular password). Enable 2FA first, then generate an App Password.

### Resend (Managed)

```bash
# Required
export RESEND_API_KEY="re_..."

# For inbound webhooks (optional)
export RESEND_WEBHOOK_SECRET="whsec_..."
```

Set up a custom domain in [Resend](https://resend.com/domains) to receive inbound emails.

## Configuration

### CLI Flag

Enable the email runner with the `--email` flag:

```bash
visor --config workflow.yaml --email
```

### Configuration File

Add email-specific configuration in your workflow YAML:

```yaml
version: "1"

email:
  receive:
    type: imap           # or 'resend'
    host: imap.gmail.com
    port: 993
    secure: true
    auth:
      user: ${EMAIL_USER}
      pass: ${EMAIL_PASSWORD}
    poll_interval: 30     # seconds
    folder: INBOX
    mark_read: true
  send:
    type: smtp           # or 'resend'
    host: smtp.gmail.com
    port: 587
    secure: true
    auth:
      user: ${EMAIL_USER}
      pass: ${EMAIL_PASSWORD}
    from: "Visor Bot <${EMAIL_FROM}>"
  allowlist:              # Optional: only process from these senders
    - trusted@example.com

checks:
  respond:
    type: ai
    schema: text
    on:
      - email_message
      - manual
    prompt: |
      Reply to this email.
      From: {{ webhook.event.from }}
      Subject: {{ webhook.event.subject }}
      Message: {{ webhook.event.text }}
```

### Configuration Options

#### Receive Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `type` | string | `imap` | Receive backend: `imap` or `resend` |
| `host` | string | `$EMAIL_IMAP_HOST` | IMAP server hostname |
| `port` | number | `993` | IMAP server port |
| `auth.user` | string | `$EMAIL_USER` | IMAP auth username |
| `auth.pass` | string | `$EMAIL_PASSWORD` | IMAP auth password |
| `secure` | boolean | `true` | Use TLS for IMAP |
| `poll_interval` | number | `30` | Polling interval in seconds |
| `folder` | string | `INBOX` | IMAP folder to monitor |
| `mark_read` | boolean | `true` | Mark processed messages as read |
| `api_key` | string | `$RESEND_API_KEY` | Resend API key (for `type: resend`) |
| `webhook_secret` | string | `$RESEND_WEBHOOK_SECRET` | Resend webhook secret |

#### Send Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `type` | string | `smtp` | Send backend: `smtp` or `resend` |
| `host` | string | `$EMAIL_SMTP_HOST` | SMTP server hostname |
| `port` | number | `587` | SMTP server port |
| `auth.user` | string | `$EMAIL_USER` | SMTP auth username |
| `auth.pass` | string | `$EMAIL_PASSWORD` | SMTP auth password |
| `secure` | boolean | `true` | Use TLS for SMTP |
| `from` | string | `$EMAIL_FROM` | Default sender address |
| `api_key` | string | `$RESEND_API_KEY` | Resend API key (for `type: resend`) |

#### General Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `allowlist` | string[] | `[]` | Only process emails from these senders (empty = all) |
| `workflow` | string | — | Optional workflow name to dispatch |

## Backends

### IMAP + SMTP (Universal)

The default configuration. Works with any email provider:

- **Gmail**: `imap.gmail.com:993` / `smtp.gmail.com:587` (requires App Password)
- **Outlook**: `outlook.office365.com:993` / `smtp.office365.com:587`
- **Fastmail**: `imap.fastmail.com:993` / `smtp.fastmail.com:465`
- **Self-hosted**: Any IMAP/SMTP server

The IMAP client polls for unseen messages at the configured interval.

### Resend (Managed)

Resend provides a fully managed email solution with two inbound modes:

- **Polling mode** (default): Visor polls `GET /emails/receiving` for new inbound emails — no webhook setup required
- **Webhook mode**: Resend sends an `email.received` webhook, Visor fetches full content via API — lower latency but requires a publicly reachable HTTP endpoint
- **Outbound**: API-based — simple `resend.emails.send()` call with threading headers
- **Threading**: Full support via Message-ID, In-Reply-To, and References headers

**Polling mode** (no webhook setup needed):
```yaml
email:
  receive:
    type: resend
    api_key: ${RESEND_API_KEY}
    # No webhook_secret = polling mode (polls every 30s by default)
    poll_interval: 30
  send:
    type: resend
    api_key: ${RESEND_API_KEY}
    from: "Visor Bot <bot@yourdomain.com>"
```

**Webhook mode** (lower latency):
```yaml
email:
  receive:
    type: resend
    api_key: ${RESEND_API_KEY}
    webhook_secret: ${RESEND_WEBHOOK_SECRET}
  send:
    type: resend
    api_key: ${RESEND_API_KEY}
    from: "Visor Bot <bot@yourdomain.com>"
```

Set up inbound email in Resend:
1. Add and verify a domain in [Resend Domains](https://resend.com/domains)
2. Configure MX records as shown in Resend dashboard
3. For webhook mode: set up a webhook endpoint for `email.received` events

### Hybrid Configuration

Mix and match backends:

```yaml
email:
  receive:
    type: imap
    host: imap.fastmail.com
    port: 993
    secure: true
    auth: { user: ${EMAIL_USER}, pass: ${EMAIL_PASSWORD} }
  send:
    type: resend
    api_key: ${RESEND_API_KEY}
    from: "Visor Bot <bot@yourdomain.com>"
```

## Email Threading

All replies include proper threading headers so conversations stay grouped in email clients:

- **Message-ID**: Unique identifier generated for each outbound email
- **In-Reply-To**: References the message being replied to
- **References**: Full chain of Message-IDs in the conversation thread
- **Subject**: Automatically prefixed with `Re:` (idempotent)

Thread tracking is maintained in memory using a SHA-256 hash of the root Message-ID. Each thread maintains:
- Full message history for conversation context
- Participant tracking
- Subject line

## Features

### Markdown to Email HTML

AI output in Markdown is automatically converted to email-compatible HTML with inline CSS:

| Markdown | Email HTML |
|----------|-----------|
| `# Header` | `<h1>Header</h1>` |
| `**bold**` | `<strong>bold</strong>` |
| `*italic*` | `<em>italic</em>` |
| `` `code` `` | `<code>code</code>` |
| ```` ```block``` ```` | `<pre><code>block</code></pre>` |
| `[label](url)` | `<a href="url">label</a>` |
| `~~strike~~` | `<del>strike</del>` |
| `> quote` | `<blockquote>quote</blockquote>` |
| `- item` | `<ul><li>item</li></ul>` |

All emails are sent as multipart/alternative with both text/plain and text/html parts.

### Webhook Context

When an email triggers a workflow, the full event context is available in templates:

```yaml
checks:
  reply:
    type: ai
    prompt: |
      From: {{ webhook.event.from }}
      Subject: {{ webhook.event.subject }}
      Message: {{ webhook.event.text }}
```

Available webhook fields:

| Field | Description |
|-------|-------------|
| `webhook.event.type` | Always `email_message` |
| `webhook.event.from` | Sender address |
| `webhook.event.to` | Recipient addresses |
| `webhook.event.cc` | CC addresses |
| `webhook.event.subject` | Email subject |
| `webhook.event.text` | Plain text body |
| `webhook.event.html` | HTML body (if available) |
| `webhook.event.messageId` | Message-ID header |
| `webhook.event.inReplyTo` | In-Reply-To header |
| `webhook.event.references` | References header chain |
| `webhook.event.date` | Email date |
| `webhook.email_conversation` | Normalized conversation context |

### Deduplication

Messages are deduplicated by Message-ID header. IMAP also marks processed messages as `\Seen`. Dedup entries expire after 1 hour.

### Sender Allowlist

Restrict which senders can trigger workflows:

```yaml
email:
  allowlist:
    - alice@company.com
    - bob@company.com
```

When the allowlist is empty (default), emails from any sender are processed.

## Example Workflows

### Simple Email Assistant (IMAP + SMTP)

```yaml
version: "1"

email:
  receive:
    type: imap
    host: ${EMAIL_IMAP_HOST}
    port: 993
    secure: true
    auth: { user: ${EMAIL_USER}, pass: ${EMAIL_PASSWORD} }
    poll_interval: 30
  send:
    type: smtp
    host: ${EMAIL_SMTP_HOST}
    port: 587
    secure: true
    auth: { user: ${EMAIL_USER}, pass: ${EMAIL_PASSWORD} }
    from: "Visor Bot <${EMAIL_FROM}>"

checks:
  respond:
    type: ai
    schema: text
    on:
      - email_message
      - manual
    prompt: |
      You are a helpful email assistant.
      Reply concisely to the email thread.

      From: {{ webhook.event.from }}
      Subject: {{ webhook.event.subject }}
      Message: {{ webhook.event.text }}
```

### Resend Bidirectional

```yaml
version: "1"

email:
  receive:
    type: resend
    api_key: ${RESEND_API_KEY}
    webhook_secret: ${RESEND_WEBHOOK_SECRET}
  send:
    type: resend
    api_key: ${RESEND_API_KEY}
    from: "Visor Bot <bot@yourdomain.com>"

checks:
  respond:
    type: ai
    schema: text
    on:
      - email_message
      - manual
    prompt: |
      You are a helpful email assistant.
      Reply concisely to the email thread.

      From: {{ webhook.event.from }}
      Subject: {{ webhook.event.subject }}
      Message: {{ webhook.event.text }}
```

### Running the Email Bot

```bash
# Set environment variables
export EMAIL_IMAP_HOST="imap.gmail.com"
export EMAIL_SMTP_HOST="smtp.gmail.com"
export EMAIL_USER="your-email@gmail.com"
export EMAIL_PASSWORD="your-app-password"
export EMAIL_FROM="your-email@gmail.com"

# Start the email bot
visor --config workflow.yaml --email

# With hot reload
visor --config workflow.yaml --email --watch

# With debug logging
VISOR_DEBUG=true visor --config workflow.yaml --email
```

The bot will:
1. Connect to the IMAP server, or start Resend polling / webhook listener
2. Poll for unseen messages at the configured interval
3. Filter by sender allowlist and dedup by Message-ID
4. Process messages through your workflow
5. Send threaded replies back to the sender

## Troubleshooting

### Connection Issues

**"IMAP host is required"**
- Set `EMAIL_IMAP_HOST` environment variable or `receive.host` in config

**"SMTP host is required"**
- Set `EMAIL_SMTP_HOST` environment variable or `send.host` in config

**"Resend API key is required"**
- Set `RESEND_API_KEY` environment variable or `api_key` in config

**IMAP connection times out**
- Verify host and port are correct
- Check firewall/network allows outbound connections to port 993
- For Gmail: ensure IMAP is enabled in Gmail settings

**SMTP authentication fails**
- For Gmail: use an [App Password](https://support.google.com/accounts/answer/185833), not your regular password
- Check that `auth.user` and `auth.pass` are correct
- Verify the SMTP port matches your TLS setting (587 for STARTTLS, 465 for SSL)

### Message Issues

**Bot not receiving emails**
- Check IMAP credentials are correct
- Verify the monitored folder (default: `INBOX`)
- Check `allowlist` if configured — sender must be listed
- Enable debug mode to see polling activity

**Bot not sending replies**
- Check SMTP/Resend credentials
- Verify `from` address is configured
- Check logs for send errors

**Replies not threading correctly**
- Ensure the email client supports standard threading headers (Message-ID, In-Reply-To, References)
- Some email clients use different threading algorithms (e.g., Gmail uses subject-based threading)

### Debug Mode

Enable verbose logging:

```bash
VISOR_DEBUG=true visor --config workflow.yaml --email
```

Log messages include:
- `[EmailPolling]` — Polling, message dispatch, and filtering
- `[email-frontend]` — Email sending, threading, and errors

## Related Documentation

- [Slack Integration](./slack-integration.md) — Bidirectional Slack integration via Socket Mode
- [Telegram Integration](./telegram-integration.md) — Telegram bot integration via long polling
- [Event Triggers](./event-triggers.md) — GitHub events and how to trigger checks
- [Liquid Templates](./liquid-templates.md) — Template syntax for dynamic content in prompts
- [Configuration](./configuration.md) — Core configuration reference
- [Recipes](./recipes.md) — Common workflow patterns including chat loops
- [Bot Transports RFC](./bot-transports-rfc.md) — Technical design document for bot integrations

## See Also

- [examples/email-assistant.yaml](../examples/email-assistant.yaml) — IMAP+SMTP email assistant example
- [examples/email-resend.yaml](../examples/email-resend.yaml) — Resend bidirectional email example
