# Slack Integration

Visor provides bidirectional Slack integration through Socket Mode, enabling interactive workflows, human input collection, real-time notifications, and AI-powered chat assistants directly in Slack threads.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Configuration](#configuration)
- [Features](#features)
- [Example Workflows](#example-workflows)
- [Troubleshooting](#troubleshooting)
- [Related Documentation](#related-documentation)

## Overview

The Slack integration enables:

- **Bidirectional Communication**: Receive messages from Slack threads and post AI-generated responses back
- **Human Input Collection**: Pause workflows to wait for user input via Slack messages
- **Conversation Context**: Access full thread history for context-aware AI responses
- **Mermaid Diagram Rendering**: Automatically render mermaid diagrams to PNG and upload to Slack
- **Reaction Management**: Visual acknowledgement (eyes) and completion (thumbsup) reactions
- **Rate Limiting**: Protect against abuse with configurable rate limits per user, channel, or globally
- **Thread Caching**: Efficient conversation history retrieval with TTL-based caching

## Prerequisites

### Slack App Setup

1. **Create a Slack App** at https://api.slack.com/apps

2. **Enable Socket Mode**:
   - Navigate to "Socket Mode" in the sidebar
   - Toggle "Enable Socket Mode" to On
   - Generate an App-Level Token with `connections:write` scope
   - Save the token (starts with `xapp-`)

3. **Configure Bot Token Scopes** under "OAuth & Permissions":
   ```
   app_mentions:read      - Receive @mentions
   channels:history       - Read messages in public channels
   channels:read          - View basic channel info
   chat:write             - Send messages
   files:write            - Upload diagram images
   groups:history         - Read messages in private channels
   groups:read            - View basic private channel info
   im:history             - Read DM messages
   im:read                - View basic DM info
   mpim:history           - Read group DM messages
   mpim:read              - View basic group DM info
   reactions:read         - View reactions
   reactions:write        - Add/remove reactions
   users:read             - View user info
   ```

4. **Enable Event Subscriptions**:
   - Navigate to "Event Subscriptions"
   - Toggle "Enable Events" to On
   - Subscribe to bot events:
     - `app_mention` - When someone mentions your bot
     - `message.channels` - Messages in public channels (optional)
     - `message.groups` - Messages in private channels (optional)
     - `message.im` - Direct messages (optional)
     - `message.mpim` - Group DMs (optional)

5. **Install to Workspace**:
   - Navigate to "Install App"
   - Click "Install to Workspace"
   - Save the Bot User OAuth Token (starts with `xoxb-`)

### Environment Variables

```bash
# Required for Socket Mode
export SLACK_APP_TOKEN="xapp-..."   # App-level token for Socket Mode
export SLACK_BOT_TOKEN="xoxb-..."   # Bot user OAuth token
```

## Configuration

### CLI Flag

Enable Slack Socket Mode runner with the `--slack` flag:

```bash
visor --config workflow.yaml --slack
```

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `SLACK_APP_TOKEN` | App-level token for Socket Mode (xapp-...) | Yes |
| `SLACK_BOT_TOKEN` | Bot user OAuth token (xoxb-...) | Yes |

### Configuration File

Add Slack-specific configuration in your workflow YAML:

```yaml
version: "1.0"

# Slack runtime configuration
slack:
  version: "v1"
  mentions: all           # 'direct' (only @mentions) or 'all' (DMs too)
  threads: required       # 'required' or 'any'
  channel_allowlist:      # Optional: limit to specific channels
    - C12345678
    - CENG*               # Wildcard prefix matching
  show_raw_output: false  # Set true to post raw JSON (debugging)

  # Optional: customize reaction names
  reactions:
    enabled: true
    ack: eyes             # Acknowledgement reaction
    done: thumbsup        # Completion reaction

  # Optional: allow bot_message events (default: false)
  # When true, messages posted by other bots can trigger runs (still subject
  # to mention/threads/channel allowlist gating).
  allow_bot_messages: false

  # Optional: allow guest users (default: false)
  # When false, single-channel and multi-channel guests are ignored.
  # Set to true to allow guest users to interact with the bot.
  allow_guests: false

  # Optional: rate limiting
  rate_limiting:
    enabled: true
    user:
      requests_per_minute: 10
      requests_per_hour: 100
    channel:
      requests_per_minute: 30
    global:
      concurrent_requests: 5

  # Optional: conversation fetching
  fetch:
    scope: thread
    max_messages: 40
    cache:
      max_threads: 200
      ttl_seconds: 600

# Frontend configuration for posting to Slack
frontends:
  - name: slack
    config:
      defaultChannel: C12345678
      groupChannels:
        overview: C87654321
        review: C11111111

checks:
  # Your workflow checks...
```

### Slack Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `version` | string | `"v1"` | API version identifier |
| `mentions` | string | `"direct"` | `"direct"` for @mentions only, `"all"` for DMs too |
| `threads` | string | `"any"` | `"required"` to only respond in threads |
| `channel_allowlist` | string[] | `[]` | Limit to specific channels (supports `*` wildcard) |
| `allow_bot_messages` | boolean | `false` | Allow `bot_message` events to trigger runs |
| `allow_guests` | boolean | `false` | Allow guest users (single/multi-channel) to trigger runs |
| `show_raw_output` | boolean | `false` | Post raw JSON output (for debugging) |
| `reactions.enabled` | boolean | `true` | Enable reaction management |
| `reactions.ack` | string | `"eyes"` | Reaction name for acknowledgement |
| `reactions.done` | string | `"thumbsup"` | Reaction name for completion |

### Rate Limiting Options

```yaml
slack:
  rate_limiting:
    enabled: true
    bot:                          # Per-bot limits
      requests_per_minute: 60
      requests_per_hour: 1000
      concurrent_requests: 10
    user:                         # Per-user limits
      requests_per_minute: 10
      requests_per_hour: 100
    channel:                      # Per-channel limits
      requests_per_minute: 30
    global:                       # Global limits
      concurrent_requests: 5
    actions:
      send_ephemeral_message: true
      ephemeral_message: "Rate limit reached. Please wait."
      queue_when_near_limit: false
      queue_threshold: 0.8
```

## Features

### Message Posting and Threading

The Slack frontend automatically posts AI responses to the originating thread:

- AI check outputs with `text` fields are posted as thread replies
- Messages are formatted using Slack's mrkdwn syntax
- Markdown links, bold, italic, and headers are converted appropriately

```yaml
checks:
  reply:
    type: ai
    group: chat
    schema:
      type: object
      properties:
        text:
          type: string
      required: [text]
    prompt: |
      Reply to the user's question.
```

### Reaction Management

The frontend manages reactions for visual feedback:

1. **Acknowledgement** (eyes emoji): Added when a check is scheduled
2. **Completion** (thumbsup emoji): Replaces acknowledgement when workflow completes

Configure custom reactions:

```yaml
slack:
  reactions:
    enabled: true
    ack: hourglass_flowing_sand
    done: white_check_mark
```

### Mermaid Diagram Rendering

Mermaid diagrams in AI responses are automatically:

1. Detected from ```mermaid code blocks
2. Rendered to PNG using @mermaid-js/mermaid-cli
3. Uploaded to the Slack thread as images
4. Replaced with "_(See diagram above)_" placeholder in text

Requirements for diagram rendering:
- Node.js and npx in PATH
- Puppeteer/Chromium dependencies
- On Linux: `apt-get install chromium-browser libatk-bridge2.0-0 libgtk-3-0`

Example AI response that includes a diagram:

```yaml
checks:
  explain-architecture:
    type: ai
    prompt: |
      Explain the system architecture with a diagram.

      Include a mermaid flowchart showing the data flow.
```

### Human Input Prompts

The `human-input` check type integrates with Slack for interactive workflows:

```yaml
checks:
  ask:
    type: human-input
    group: chat
    prompt: |
      What would you like to know?
```

Behavior in Slack:
- First message in a thread is consumed as the initial input
- Subsequent messages resume the workflow from its saved snapshot
- The prompt text is registered internally but not posted (to avoid spam)

### Conversation Context

Access full thread history in your prompts:

```yaml
checks:
  context-aware-reply:
    type: ai
    prompt: |
      Thread context:
      {% if slack.conversation %}
      {% for m in slack.conversation.messages %}
      - [{{ m.user }}] {{ m.text }}
      {% endfor %}
      {% endif %}

      Respond based on the conversation above.
```

Or use the `chat_history` filter for merged history:

```yaml
checks:
  reply:
    type: ai
    prompt: |
      Conversation so far:
      {% assign history = '' | chat_history: 'ask', 'reply' %}
      {% for m in history %}
      {{ m.role | capitalize }}: {{ m.text }}
      {% endfor %}

      Latest message: {{ outputs['ask'].text }}
```

### Markdown to Slack Conversion

The integration automatically converts Markdown to Slack mrkdwn:

| Markdown | Slack mrkdwn |
|----------|--------------|
| `# Header` | `*Header*` |
| `**bold**` | `*bold*` |
| `[label](url)` | `<url\|label>` |
| `![alt](url)` | `<url\|alt>` |
| `- item` | `bullet item` |
| ` ```code``` ` | Preserved as-is |

## Example Workflows

### Simple Chat Assistant

See [examples/slack-simple-chat.yaml](../examples/slack-simple-chat.yaml) for a complete example with:

- Intent routing (chat, FAQ, project help, thread summary)
- Nested sub-flows with inner loops
- Conversation history management
- External integration mocks

Basic chat loop:

```yaml
version: "1.0"

slack:
  mentions: all
  threads: required

frontends:
  - name: slack

checks:
  ask:
    type: human-input
    group: chat
    prompt: |
      Hi! What can I help you with?

  reply:
    type: ai
    group: chat
    depends_on: ask
    schema:
      type: object
      properties:
        text:
          type: string
      required: [text]
    ai:
      disableTools: true
      system_prompt: "You are a helpful assistant."
    prompt: |
      Conversation:
      {% assign history = '' | chat_history: 'ask', 'reply' %}
      {% for m in history %}
      {{ m.role | capitalize }}: {{ m.text }}
      {% endfor %}

      Latest: {{ outputs['ask'].text }}

      Reply briefly.
    on_success:
      goto: ask
```

### Running the Slack Bot

```bash
# Set environment variables
export SLACK_APP_TOKEN="xapp-..."
export SLACK_BOT_TOKEN="xoxb-..."

# Optional: enable debug logging
export VISOR_DEBUG=true

# Start the bot
visor --config examples/slack-simple-chat.yaml --slack
```

The bot will:
1. Connect via Socket Mode
2. Listen for @mentions and DMs (depending on `mentions` setting)
3. Process messages through your workflow
4. Post responses back to the thread

## Troubleshooting

### Connection Issues

**"SLACK_APP_TOKEN (xapp-...) is required for Socket Mode"**
- Ensure `SLACK_APP_TOKEN` environment variable is set
- Verify the token starts with `xapp-`

**"apps.connections.open failed"**
- Check that Socket Mode is enabled in your Slack app settings
- Verify the App-Level Token has `connections:write` scope
- Ensure the token has not been revoked

### Message Handling Issues

**Bot not responding to messages**
- Verify the bot is invited to the channel
- Check `channel_allowlist` if configured
- Ensure `mentions` setting matches your use case:
  - Use `mentions: direct` for @mentions only
  - Use `mentions: all` to respond to DMs

**Bot responding multiple times**
- The deduplication system handles this automatically
- If issues persist, check for multiple bot instances running

**Messages not appearing in thread**
- Verify `SLACK_BOT_TOKEN` has `chat:write` scope
- Check that the bot is a member of the channel
- Review logs for API errors

### Diagram Rendering Issues

**"Mermaid rendering failed"**
- Install mermaid-cli: `npm install -g @mermaid-js/mermaid-cli`
- On Linux, install Chromium dependencies:
  ```bash
  apt-get install chromium-browser libatk-bridge2.0-0 libgtk-3-0
  ```
- Check that `npx` is available in PATH

### Rate Limiting

**"Rate limited" messages in logs**
- Review and adjust rate limit configuration
- Consider increasing limits for legitimate high-volume usage
- Check which dimension is triggering (`bot`, `user`, `channel`, `global`)

### Debug Mode

Enable verbose logging for troubleshooting:

```bash
# Via environment variable
VISOR_DEBUG=true visor --config workflow.yaml --slack

# Or via CLI flag
visor --config workflow.yaml --slack --debug
```

Log messages include:
- `[SlackSocket]` - WebSocket connection and event handling
- `[slack-frontend]` - Message posting and reactions
- `[prompt-state]` - Human input state management

## Related Documentation

- [Human Input Provider](./human-input-provider.md) - Detailed documentation on the `human-input` check type
- [Bot Transports RFC](./bot-transports-rfc.md) - Technical design document for Slack integration
- [Recipes](./recipes.md) - Common workflow patterns including chat loops
- [Liquid Templates](./liquid-templates.md) - Template syntax for prompts including `chat_history`
- [Output History](./output-history.md) - Working with workflow output history

## See Also

- [examples/slack-simple-chat.yaml](../examples/slack-simple-chat.yaml) - Complete Slack chat assistant example
