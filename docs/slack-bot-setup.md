# Slack Bot Setup Guide

This guide walks you through setting up Visor as a Slack bot, from creating your Slack app to running your first bot-powered workflow.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Step 1: Create a Slack App](#step-1-create-a-slack-app)
- [Step 2: Configure OAuth Scopes](#step-2-configure-oauth-scopes)
- [Step 3: Install App to Workspace](#step-3-install-app-to-workspace)
- [Step 4: Get Credentials](#step-4-get-credentials)
- [Step 5: Configure Visor](#step-5-configure-visor)
- [Step 6: Validate Configuration](#step-6-validate-configuration)
- [Step 7: Start Visor Server](#step-7-start-visor-server)
- [Step 8: Configure Event Subscriptions](#step-8-configure-event-subscriptions)
- [Step 9: Test Your Bot](#step-9-test-your-bot)
- [Troubleshooting](#troubleshooting)
- [Advanced Configuration](#advanced-configuration)
- [Security Best Practices](#security-best-practices)

## Overview

Visor can run as a Slack bot that:
- Responds to direct mentions (@bot) in channels and threads
- Maintains conversation context across messages
- Executes workflows in response to user requests
- Posts results back to the thread
- Handles interactive human-input prompts via Slack

## Prerequisites

- A Slack workspace where you have admin permissions to install apps
- Node.js and npm installed
- Visor installed and configured
- A server or hosting environment to run Visor (with public URL for webhooks)

## Step 1: Create a Slack App

1. Go to [https://api.slack.com/apps](https://api.slack.com/apps)
2. Click **"Create New App"**
3. Choose **"From scratch"**
4. Enter your app name (e.g., "Visor Bot")
5. Select your workspace
6. Click **"Create App"**

## Step 2: Configure OAuth Scopes

Your bot needs specific permissions to function properly.

1. In your app settings, go to **"OAuth & Permissions"** (left sidebar)
2. Scroll down to **"Bot Token Scopes"**
3. Add the following scopes:

### Required Scopes

| Scope | Description | Why Needed |
|-------|-------------|------------|
| `app_mentions:read` | View messages that directly mention @your_bot | To detect when users mention the bot |
| `chat:write` | Send messages as the bot | To post workflow results to threads |
| `reactions:write` | Add emoji reactions | To show processing status (👀, ✅, ❌) |
| `channels:history` | View messages in public channels | To fetch conversation context |
| `groups:history` | View messages in private channels | To fetch conversation context in private channels |
| `im:history` | View messages in direct messages | To support DM conversations (optional) |

### How to Add Scopes

1. Click **"Add an OAuth Scope"** under Bot Token Scopes
2. Search for and select each scope listed above
3. Repeat until all required scopes are added

## Step 3: Install App to Workspace

1. In your app settings, go to **"Install App"** (left sidebar)
2. Click **"Install to Workspace"**
3. Review the permissions
4. Click **"Allow"**

The app is now installed, and you'll see bot tokens generated.

## Step 4: Get Credentials

You need two pieces of information:

### Bot Token (starts with `xoxb-`)

1. Go to **"OAuth & Permissions"**
2. Find **"Bot User OAuth Token"** (starts with `xoxb-`)
3. Click **"Copy"** or note it down
4. **Keep this secret!** Never commit it to source control

### Signing Secret

1. Go to **"Basic Information"** (left sidebar)
2. Scroll down to **"App Credentials"**
3. Find **"Signing Secret"**
4. Click **"Show"** then copy the value
5. **Keep this secret!** Never commit it to source control

## Step 5: Configure Visor

### 5.1 Set Environment Variables

Create a `.env` file in your project root or set environment variables:

```bash
# Required Slack credentials
export SLACK_BOT_TOKEN="xoxb-your-bot-token-here"
export SLACK_SIGNING_SECRET="your-signing-secret-here"
```

**Security Note:** Never commit `.env` files or credentials to source control. Add `.env` to your `.gitignore`.

### 5.2 Update Visor Configuration

Edit your `.visor.yaml` file to add Slack configuration:

```yaml
version: '1.0'

# Enable HTTP server for webhook handling
http_server:
  enabled: true
  port: 8080

# Slack bot configuration
slack:
  # Webhook endpoint (where Slack will send events)
  endpoint: "/slack/events"

  # Credentials (use environment variables)
  signing_secret: "${SLACK_SIGNING_SECRET}"
  bot_token: "${SLACK_BOT_TOKEN}"

  # Fetch configuration (conversation history)
  fetch:
    scope: thread              # Only supported value
    max_messages: 40           # Maximum messages to fetch per thread
    cache:
      ttl_seconds: 600         # Cache thread history for 10 minutes
      max_threads: 200         # Maximum threads to cache

  # Channel restrictions (optional but recommended)
  channel_allowlist:
    - "C123*"                  # Allow channels starting with C123
    - "CSUPPORT"               # Allow specific channel

  # Response configuration
  response:
    fallback: "Sorry, I encountered an error. Please try again."

# Define your workflow
checks:
  my-slack-workflow:
    type: workflow
    steps:
      - name: greet
        type: logger
        message: |
          Hello! You said: {{ bot.currentMessage.text }}
          Thread: {{ bot.thread.id }}
          History: {{ bot.history | size }} messages
```

### 5.3 Minimal Configuration Example

The simplest configuration only requires credentials:

```yaml
version: '1.0'

http_server:
  enabled: true
  port: 8080

slack:
  signing_secret: "${SLACK_SIGNING_SECRET}"
  bot_token: "${SLACK_BOT_TOKEN}"

checks:
  support-bot:
    type: workflow
    steps:
      - name: respond
        type: logger
        message: "I'm here to help! You said: {{ bot.currentMessage.text }}"
```

## Step 6: Validate Configuration

Before starting Visor, validate your configuration:

```bash
# Basic validation
visor validate

# Validate specific config file
visor validate --config ./.visor.yaml

# Validate and test Slack API connectivity
visor validate --check-api
```

### What Gets Validated

The validator checks:
- ✅ Required fields present (signing_secret, bot_token)
- ✅ Environment variables exist and are set
- ✅ Endpoint path format is valid
- ✅ Cache settings are reasonable
- ✅ Fetch configuration is valid
- ✅ Channel allowlist patterns are valid
- ✅ Bot token format (starts with `xoxb-`)
- ✅ (Optional) Slack API connectivity

### Example Output

```
🤖 Visor Bot Configuration Validator

📂 Loading configuration: .visor.yaml
🔍 Validating Slack configuration...

Slack Bot Configuration Validation
═══════════════════════════════════════════════════════════

✓ Configuration is valid

Environment Variables:
  ✓ SLACK_SIGNING_SECRET (set)
  ✓ SLACK_BOT_TOKEN (set)

Configuration Summary:
  Endpoint: /slack/events
  Signing Secret: (configured)
  Bot Token: (configured)
  Max Messages: 40
  Cache TTL: 600 seconds
  Cache Size: 200 threads
  Channel Allowlist: C123*, CSUPPORT

Next Steps:
  1. Set up your Slack app (see docs/slack-bot-setup.md)
  2. Configure event subscriptions in Slack app settings
  3. Start Visor with: visor --http
  4. Point Slack webhook to: http://your-server:8080/slack/events

✅ Validation passed! Your Slack bot is ready to use.
```

## Step 7: Start Visor Server

Start Visor with the HTTP server enabled:

```bash
# Start with default config
visor --http

# Start with specific config
visor --config ./.visor.yaml --http

# Start with debug output
visor --http --debug
```

The server will start and listen on the configured port (default: 8080).

### Verify Server is Running

```bash
# Check health endpoint
curl http://localhost:8080/

# Should return:
# {"status":"ok","message":"Visor webhook server is running"}
```

## Step 8: Configure Event Subscriptions

Now connect Slack to your Visor server.

### 8.1 Expose Your Server

Your server needs a public URL that Slack can reach. Options:

**For Development:**
- Use [ngrok](https://ngrok.com/): `ngrok http 8080`
- Use [localtunnel](https://localtunnel.github.io/www/): `lt --port 8080`
- Use [Cloudflare Tunnel](https://www.cloudflare.com/products/tunnel/)

**For Production:**
- Deploy to a cloud provider (AWS, GCP, Azure, etc.)
- Use a reverse proxy (nginx, Caddy)
- Ensure HTTPS is enabled (Slack requires HTTPS)

### 8.2 Configure Event Subscriptions in Slack

1. Go to your app settings at [https://api.slack.com/apps](https://api.slack.com/apps)
2. Select your app
3. Go to **"Event Subscriptions"** (left sidebar)
4. Toggle **"Enable Events"** to ON

### 8.3 Set Request URL

1. In the **"Request URL"** field, enter your public URL + endpoint
   - Example: `https://your-domain.com/slack/events`
   - Or with ngrok: `https://abc123.ngrok.io/slack/events`

2. Slack will send a verification challenge
   - If your Visor server is running, it will automatically respond
   - You should see a green checkmark: **"Verified"**

3. If verification fails:
   - Check that Visor is running (`visor --http`)
   - Check that the URL is correct and publicly accessible
   - Check Visor logs for errors
   - Ensure endpoint matches your config (default: `/slack/events`)

### 8.4 Subscribe to Bot Events

1. Scroll down to **"Subscribe to bot events"**
2. Click **"Add Bot User Event"**
3. Add the following events:

| Event | Description |
|-------|-------------|
| `app_mention` | When someone mentions @your_bot |
| `message.channels` | Messages in channels (for thread context) |
| `message.groups` | Messages in private channels (for thread context) |
| `message.im` | Direct messages (optional) |

4. Click **"Save Changes"**

### 8.5 Reinstall App

After changing event subscriptions, you need to reinstall:

1. Slack will show a banner: **"Reinstall your app for changes to take effect"**
2. Click **"reinstall your app"** or go to **"Install App"**
3. Click **"Reinstall to Workspace"**
4. Click **"Allow"**

## Step 9: Test Your Bot

### 9.1 Invite Bot to Channel

1. Open a Slack channel
2. Type: `/invite @YourBotName`
3. The bot will join the channel

### 9.2 Mention the Bot

Send a message mentioning your bot:

```
@YourBotName Hello! Can you help me?
```

### 9.3 Check Bot Response

You should see:
1. **👀 (eyes) reaction** - Bot received and is processing
2. **Bot reply in thread** - Workflow result posted
3. **✅ (checkmark) reaction** - Processing completed successfully

If something goes wrong:
- **❌ (X) reaction** - Processing failed (check Visor logs)
- **No reaction** - Bot didn't receive event (check Event Subscriptions)

### 9.4 Monitor Logs

Watch Visor logs to see what's happening:

```bash
# In your terminal running Visor
# You should see:
[info] Slack webhook: Received event: app_mention
[info] Slack webhook: Adding 👀 reaction
[info] Slack adapter: Fetching conversation for thread C123:1234567890.123456
[info] Worker pool: Work item submitted
[info] Workflow executor: Executing workflow: my-slack-workflow
[info] Workflow executor: Workflow completed successfully
[info] Slack webhook: Posting result to thread
```

## Troubleshooting

### Bot Doesn't Respond

**Check 1: Is Visor running?**
```bash
curl http://localhost:8080/
# Should return: {"status":"ok",...}
```

**Check 2: Are events reaching Visor?**
- Check Visor logs for "Received event" messages
- Go to Slack app settings > Event Subscriptions > View Events
- Look for recent events and their delivery status

**Check 3: Is the bot in the channel?**
```
/invite @YourBotName
```

**Check 4: Are you mentioning the bot?**
- Must use `@BotName` (not just the name)
- Bot only responds to direct mentions

**Check 5: Channel allowlist**
- Check if the channel is in your `channel_allowlist`
- Remove allowlist temporarily to test all channels

### "Invalid Signing Secret" Error

**Problem:** Slack signature verification failed

**Solutions:**
1. Verify `SLACK_SIGNING_SECRET` environment variable is set correctly
2. Check for extra spaces or quotes in the secret
3. Regenerate signing secret in Slack app settings if needed
4. Restart Visor after changing environment variables

### "Invalid Token" Error

**Problem:** Slack API authentication failed

**Solutions:**
1. Verify `SLACK_BOT_TOKEN` environment variable is set correctly
2. Ensure token starts with `xoxb-`
3. Check that the app is installed to the workspace
4. Regenerate token if necessary (requires reinstall)

### Bot Responds Twice

**Problem:** Duplicate event handling

**Solutions:**
1. Check that you don't have multiple Visor instances running
2. Ensure event subscriptions aren't duplicated in Slack
3. Check Visor logs for duplicate event IDs

### Cache Issues

**Problem:** Bot sees stale conversation history

**Solutions:**
1. Reduce `cache.ttl_seconds` in config
2. Restart Visor to clear cache
3. Check logs for cache hit/miss statistics

### Validation Errors

Run validation to diagnose issues:

```bash
visor validate --check-api
```

Common validation errors:

| Error | Solution |
|-------|----------|
| Missing environment variable | Set in .env or export |
| Invalid endpoint format | Start with `/` |
| Bot token format incorrect | Must start with `xoxb-` |
| API connectivity failed | Check token and network |

## Advanced Configuration

### Multiple Channel Patterns

Restrict bot to specific channels:

```yaml
slack:
  channel_allowlist:
    - "C01*"           # All channels starting with C01
    - "CSUPPORT*"      # Support channels
    - "C123ABC"        # Specific channel ID
```

### Custom Endpoint

Use a custom webhook path:

```yaml
slack:
  endpoint: "/bots/slack/my-custom-bot"
```

Then configure Slack to use: `https://your-domain.com/bots/slack/my-custom-bot`

### Worker Pool Configuration

Control concurrency and queue size:

```yaml
slack:
  worker_pool:
    queue_capacity: 100      # Max pending work items
    task_timeout: 300000     # 5 minutes per task
```

### Accessing Bot Context in Workflows

Use Liquid templates to access conversation data:

```yaml
checks:
  my-workflow:
    type: workflow
    steps:
      - name: analyze
        type: logger
        message: |
          Current message: {{ bot.currentMessage.text }}
          User: {{ bot.attributes.user }}
          Channel: {{ bot.attributes.channel }}
          Thread: {{ bot.thread.id }}

          History ({{ bot.history | size }} messages):
          {% for msg in bot.history %}
            - [{{ msg.role }}] {{ msg.text }}
          {% endfor %}
```

### Human Input in Slack

The `human-input` provider automatically uses Slack when bot context is present:

```yaml
checks:
  interactive-workflow:
    type: workflow
    steps:
      - name: ask-question
        type: human-input
        prompt: "What would you like to analyze?"
        store: user_input

      - name: process
        type: logger
        message: "You asked about: {{ outputs['ask-question'] }}"
```

**Flow:**
1. User mentions bot
2. Bot posts prompt in thread
3. User replies with answer
4. Bot continues workflow with answer

## Security Best Practices

### 1. Never Commit Secrets

```bash
# Add to .gitignore
.env
*.secret
```

### 2. Use Environment Variables

```yaml
# Good ✅
slack:
  bot_token: "${SLACK_BOT_TOKEN}"

# Bad ❌
slack:
  bot_token: "xoxb-hardcoded-token"
```

### 3. Restrict Channels

```yaml
# Limit bot to specific channels
slack:
  channel_allowlist:
    - "CSUPPORT"
    - "CENGINEERING"
```

### 4. Use HTTPS

Always use HTTPS in production:
- Slack requires HTTPS for event subscriptions
- Protects credentials in transit
- Use Let's Encrypt for free certificates

### 5. Rotate Credentials Regularly

- Regenerate tokens periodically
- Monitor for unauthorized access
- Revoke compromised credentials immediately

### 6. Limit Scopes

Only request OAuth scopes you actually need. Don't add extra permissions.

### 7. Monitor Logs

- Enable logging to track bot activity
- Set up alerts for errors
- Review logs regularly

### 8. Rate Limiting

Be aware of Slack API rate limits:
- Tier 1: 1 request per minute
- Tier 2: 20 requests per minute
- Tier 3: 50 requests per minute
- Tier 4: 100+ requests per minute

Visor's caching helps avoid rate limits by reducing API calls.

## Next Steps

- **Create workflows**: Build custom workflows for your use cases
- **Add checks**: Integrate AI, tools, and custom scripts
- **Monitor usage**: Track bot interactions and performance
- **Deploy to production**: Move from development to production environment
- **Scale up**: Use load balancers and multiple instances for high traffic

## Getting Help

- **Documentation**: See other docs in this directory
- **GitHub Issues**: Report bugs or request features
- **Examples**: Check `examples/slack-bot-example.yaml`
- **RFC**: Read the full design in `docs/bot-transports-rfc.md`

## Useful Links

- [Slack API Documentation](https://api.slack.com/)
- [Slack App Management](https://api.slack.com/apps)
- [Slack OAuth Scopes](https://api.slack.com/scopes)
- [Slack Event Types](https://api.slack.com/events)
- [ngrok for Development](https://ngrok.com/)
