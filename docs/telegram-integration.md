# Telegram Integration

Visor provides Telegram bot integration via long polling, enabling interactive workflows, AI-powered chat assistants, and automated responses directly in Telegram DMs, groups, supergroups (including forum topics), and channels.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Configuration](#configuration)
- [Chat Types](#chat-types)
- [Features](#features)
- [Example Workflows](#example-workflows)
- [Telegram Side Settings](#telegram-side-settings)
- [Troubleshooting](#troubleshooting)
- [Related Documentation](#related-documentation)

## Overview

The Telegram integration enables:

- **DM Conversations**: Respond to direct messages without any mention requirements
- **Group Chat Support**: Respond in groups and supergroups when @mentioned or replied to
- **Forum Topic Support**: Thread-aware sessions in supergroup forum topics
- **Channel Processing**: Process channel posts (bot must be admin)
- **Reaction Management**: Visual acknowledgement (👀) and completion (👍) emoji reactions
- **HTML Formatting**: Markdown AI output automatically converted to Telegram HTML
- **Message Chunking**: Long responses auto-split at 4096-character Telegram limit
- **Hot Reload**: Configuration changes picked up without restarting the bot

The integration uses [grammY](https://grammy.dev/) with [@grammyjs/runner](https://grammy.dev/plugins/runner) for concurrent update processing with automatic backoff and stall detection.

## Prerequisites

### Create a Telegram Bot

1. **Open Telegram** and start a chat with [@BotFather](https://t.me/BotFather)

2. **Create a new bot**:
   - Send `/newbot`
   - Follow the prompts to choose a name and username
   - Save the bot token (format: `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)

3. **Configure privacy mode** (for group usage):
   - Send `/setprivacy` to @BotFather
   - Select your bot
   - Choose **Disable** to let the bot see all group messages
   - Alternatively, make the bot a group admin (admins always see all messages)

### Environment Variables

```bash
# Required
export TELEGRAM_BOT_TOKEN="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
```

## Configuration

### CLI Flag

Enable Telegram long-polling runner with the `--telegram` flag:

```bash
visor --config workflow.yaml --telegram
```

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather | Yes |

### Configuration File

Add Telegram-specific configuration in your workflow YAML:

```yaml
version: "1"

# Telegram runtime configuration
telegram:
  require_mention: true       # Require @mention in groups (default: true)
  chat_allowlist:              # Optional: limit to specific chat IDs
    - -1001234567890
    - 98765432

# Frontend configuration for posting to Telegram
frontends:
  - name: telegram

checks:
  # Your workflow checks...
```

### Telegram Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `bot_token` | string | `$TELEGRAM_BOT_TOKEN` | Bot token (config overrides env) |
| `require_mention` | boolean | `true` | Require @mention or reply-to-bot in groups/supergroups |
| `chat_allowlist` | (string\|number)[] | `[]` | Limit to specific chat IDs (empty = all chats) |
| `polling_timeout` | number | `30` | Long polling timeout in seconds |
| `workflow` | string | — | Optional workflow name to dispatch |

## Chat Types

Visor's Telegram integration handles all four Telegram chat types:

### Direct Messages (DMs)

- **Always accepted** — no mention required regardless of `require_mention` setting
- Ideal for personal assistant workflows
- Each DM conversation gets its own workspace

### Groups and Supergroups

- **With `require_mention: true`** (default): Bot only responds when:
  - The message contains `@bot_username`, or
  - The message is a reply to one of the bot's messages
- **With `require_mention: false`**: Bot responds to all messages
- Supergroups with forum topics use thread-aware sessions (`chat_id:topic_id`)

### Forum Topics (Supergroup Threads)

- Each topic gets an isolated workspace (keyed by `chat_id:message_thread_id`)
- Replies include `message_thread_id` to stay within the correct topic
- Mention and reply-to-bot gating applies per-topic

### Channels

- **Always accepted** — channels don't have mention semantics
- Bot must be added as a channel admin to receive and post in channels
- Channel posts arrive as `channel_post` updates (not `message`)

## Features

### Message Posting and Threading

The Telegram frontend automatically posts AI responses to the originating chat:

- AI check outputs with `text` fields are posted as replies
- Messages are formatted using Telegram HTML (`<b>`, `<i>`, `<code>`, `<pre>`, etc.)
- Replies include `reply_to_message_id` to thread in groups
- Forum topic replies include `message_thread_id` to stay in the correct topic

```yaml
checks:
  reply:
    type: ai
    schema: text
    on:
      - telegram_message
      - manual
    prompt: |
      You are a helpful assistant.
      Respond concisely to the user's message.

      User message: {{ webhook.event.text }}
```

### Reaction Management

The frontend manages emoji reactions for visual feedback:

1. **Acknowledgement** (👀): Added when a check is scheduled
2. **Completion** (👍): Replaces acknowledgement when workflow completes

> Note: Emoji reactions require the bot to be an admin in groups. Reaction failures are non-fatal and silently ignored.

### Markdown to Telegram HTML Conversion

AI output in Markdown is automatically converted to Telegram HTML:

| Markdown | Telegram HTML |
|----------|---------------|
| `# Header` | `<b>Header</b>` |
| `**bold**` | `<b>bold</b>` |
| `*italic*` | `<i>italic</i>` |
| `` `code` `` | `<code>code</code>` |
| ```` ```block``` ```` | `<pre>block</pre>` |
| `[label](url)` | `<a href="url">label</a>` |
| `~~strike~~` | `<s>strike</s>` |
| `> quote` | `<blockquote>quote</blockquote>` |
| `- item` | `• item` |

Code blocks with language hints are rendered with `<pre><code class="language-X">`.

If Telegram rejects the HTML (malformed tags), the message is automatically retried as plain text.

### Message Chunking

Telegram limits messages to 4096 characters. Long AI responses are automatically split into multiple messages at newline boundaries, preserving code block integrity where possible.

### Webhook Context

When a Telegram message triggers a workflow, the full event context is available in templates:

```yaml
checks:
  reply:
    type: ai
    prompt: |
      Chat type: {{ webhook.event.chat.type }}
      User: {{ webhook.event.from.first_name }}
      Message: {{ webhook.event.text }}
```

Available webhook fields:

| Field | Description |
|-------|-------------|
| `webhook.event.type` | `message` or `channel_post` |
| `webhook.event.chat_id` | Numeric chat ID |
| `webhook.event.message_id` | Message ID |
| `webhook.event.text` | Message text content |
| `webhook.event.from` | Sender info (`id`, `first_name`, `username`) |
| `webhook.event.chat` | Chat info (`id`, `type`, `title`, `username`) |
| `webhook.event.reply_to_message` | Replied-to message (if any) |
| `webhook.event.message_thread_id` | Forum topic ID (if applicable) |
| `webhook.telegram_conversation` | Normalized conversation context |

## Example Workflows

### Simple Chat Assistant

```yaml
version: "1"

telegram:
  require_mention: false

checks:
  respond:
    type: ai
    schema: text
    on:
      - telegram_message
      - manual
    prompt: |
      You are a helpful assistant running inside Visor.
      Respond concisely to the user's message.

      User message: {{ webhook.event.text }}
```

### Group Bot with Mention Gating

```yaml
version: "1"

telegram:
  require_mention: true
  chat_allowlist:
    - -1001234567890

frontends:
  - name: telegram

checks:
  reply:
    type: ai
    schema: text
    on:
      - telegram_message
    prompt: |
      You are a team assistant in a Telegram group.
      Answer the question briefly.

      Question: {{ webhook.event.text }}
```

### Running the Telegram Bot

```bash
# Set environment variable
export TELEGRAM_BOT_TOKEN="123456:ABC-..."

# Optional: enable debug logging
export VISOR_DEBUG=true

# Start the bot
visor --config workflow.yaml --telegram
```

The bot will:
1. Initialize via `getMe` API call
2. Start long polling with concurrent update processing
3. Filter messages based on chat type, allowlist, and mention settings
4. Process messages through your workflow
5. Post formatted responses back to the originating chat

### With Config Hot Reload

```bash
visor --config workflow.yaml --telegram --watch
```

The `--watch` flag enables hot reload — YAML changes are picked up automatically without restarting the bot.

## Telegram Side Settings

### Privacy Mode

Telegram bots default to **Privacy Mode**, which limits what group messages they receive. If the bot must see all group messages:

- **Option A**: Disable privacy mode via `/setprivacy` in @BotFather
- **Option B**: Make the bot a group admin (admins always see all messages)

When toggling privacy mode, remove and re-add the bot in each group so Telegram applies the change.

### BotFather Commands

Useful @BotFather commands for configuration:

| Command | Description |
|---------|-------------|
| `/setprivacy` | Toggle privacy mode (group message visibility) |
| `/setjoingroups` | Allow or deny the bot being added to groups |
| `/setcommands` | Set the bot's command menu |
| `/setdescription` | Set the bot's description (shown on profile) |
| `/setabouttext` | Set the "About" text |

### Finding Chat IDs

To find a chat ID for the `chat_allowlist`:

1. **DMs**: Start the bot, send a message, check logs for `chat_id=...`
2. **Groups**: Add the bot to the group, send a message, check logs
3. **API method**:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
   ```
   Look for `chat.id` in the response.

Group IDs are negative numbers (e.g., `-1001234567890`).

## Troubleshooting

### Connection Issues

**"TELEGRAM_BOT_TOKEN is required"**
- Ensure the `TELEGRAM_BOT_TOKEN` environment variable is set
- Or set `telegram.bot_token` in your config file

**Bot starts but never receives messages**
- Verify the token is correct (test with `curl https://api.telegram.org/bot<TOKEN>/getMe`)
- Ensure no other bot instance is polling with the same token (only one poller per token)
- Check network connectivity to `api.telegram.org`

### Message Handling Issues

**Bot not responding in groups**
- Check that Privacy Mode is disabled (via `/setprivacy` in @BotFather), or make the bot an admin
- If `require_mention: true`, ensure you @mention the bot or reply to its message
- Check `chat_allowlist` if configured — the group's chat ID must be listed
- After toggling privacy mode, remove and re-add the bot to the group

**Bot not responding in channels**
- The bot must be added as a channel admin
- Channel support uses `channel_post` events, not `message`

**Bot responding to its own messages**
- This is handled automatically — the bot filters out messages from its own user ID

**Duplicate responses**
- The deduplication system handles this automatically
- If issues persist, check for multiple bot instances running with the same token

### Formatting Issues

**"can't parse entities" errors in logs**
- The bot automatically retries with plain text when HTML parsing fails
- This is non-fatal and handled gracefully

**Messages truncated**
- Messages over 4096 characters are automatically chunked
- Very long single lines are force-split at the character limit

### Reaction Issues

**Reactions not appearing**
- The bot needs admin permissions in groups to set reactions
- Reaction failures are non-fatal and silently ignored
- DMs may not support reactions depending on Telegram client version

### Debug Mode

Enable verbose logging for troubleshooting:

```bash
# Via environment variable
VISOR_DEBUG=true visor --config workflow.yaml --telegram

# Or via CLI flag
visor --config workflow.yaml --telegram --debug
```

Log messages include:
- `[TelegramPolling]` — Polling, message dispatch, and filtering
- `[telegram-frontend]` — Message posting, reactions, and errors

## Related Documentation

- [Slack Integration](./slack-integration.md) — Bidirectional Slack integration via Socket Mode
- [Event Triggers](./event-triggers.md) — GitHub events and how to trigger checks
- [Liquid Templates](./liquid-templates.md) — Template syntax for dynamic content in prompts
- [Configuration](./configuration.md) — Core configuration reference
- [Recipes](./recipes.md) — Common workflow patterns including chat loops
- [Bot Transports RFC](./bot-transports-rfc.md) — Technical design document for bot integrations

## See Also

- [examples/telegram-simple-chat.yaml](../examples/telegram-simple-chat.yaml) — Simple Telegram chat assistant example
