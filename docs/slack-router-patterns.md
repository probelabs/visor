# Slack Router Workflow Patterns

This guide explains how to build intelligent routing workflows for Slack bots using Visor. Router workflows allow you to direct incoming messages to different handlers based on content, channel, user, or other contextual information.

## Table of Contents

1. [Overview](#overview)
2. [Basic Router Pattern](#basic-router-pattern)
3. [Routing Dimensions](#routing-dimensions)
4. [Bot Context API](#bot-context-api)
5. [Common Routing Patterns](#common-routing-patterns)
6. [Advanced Techniques](#advanced-techniques)
7. [Best Practices](#best-practices)
8. [Anti-Patterns](#anti-patterns)
9. [Examples](#examples)

## Overview

### What is a Router Workflow?

A router workflow is a Visor workflow that:
1. Receives a Slack bot message event
2. Analyzes the message context (content, channel, user, etc.)
3. Routes to the appropriate specialized workflow
4. Returns the result to the Slack thread

### Why Use Routers?

- **Single Entry Point:** One Slack bot configuration handles multiple use cases
- **Clean Separation:** Each workflow focuses on one responsibility
- **Flexible Routing:** Route based on any combination of context
- **Easy Maintenance:** Add new workflows without changing existing ones
- **Conditional Execution:** Only run expensive operations when needed

### Architecture

```
Slack Message → Bot Transport → Router Workflow → Specialized Workflow(s) → Response
                                       ↓
                              Routing Decision
                       (content/channel/user/etc.)
```

## Basic Router Pattern

The simplest router uses `noop` checks with conditional `if` statements and `on_success` handlers:

```yaml
version: '1.0'

slack:
  endpoint: "/slack/events"
  signing_secret: "${SLACK_SIGNING_SECRET}"
  bot_token: "${SLACK_BOT_TOKEN}"

checks:
  # Main router entry point
  router:
    type: noop
    description: "Route to appropriate workflow"
    always_run: true
    on_success:
      run: [route-help, route-deploy, route-default]

  # Route 1: Help requests
  route-help:
    type: noop
    if: 'bot && contains(bot.currentMessage.text, "help")'
    on_success:
      run: [handle-help]

  handle-help:
    type: logger
    message: "Here's how to use this bot..."

  # Route 2: Deploy requests
  route-deploy:
    type: noop
    if: 'bot && contains(bot.currentMessage.text, "deploy")'
    on_success:
      run: [handle-deploy]

  handle-deploy:
    type: logger
    message: "Starting deployment..."

  # Default: Unrecognized
  route-default:
    type: noop
    if: |
      bot && !(
        contains(bot.currentMessage.text, "help") ||
        contains(bot.currentMessage.text, "deploy")
      )
    on_success:
      run: [handle-default]

  handle-default:
    type: logger
    message: "I don't understand. Try 'help' for assistance."
```

## Routing Dimensions

### 1. Content-Based Routing

Route based on message text, keywords, or patterns:

```yaml
# Simple keyword matching
route-deploy:
  type: noop
  if: 'bot && contains(bot.currentMessage.text, "deploy")'
  on_success:
    run: [handle-deployment]

# Multiple keywords (OR)
route-incident:
  type: noop
  if: |
    bot && (
      contains(bot.currentMessage.text, "incident") ||
      contains(bot.currentMessage.text, "outage") ||
      contains(bot.currentMessage.text, "down")
    )
  on_success:
    run: [handle-incident]

# Multiple keywords (AND)
route-prod-deploy:
  type: noop
  if: |
    bot &&
    contains(bot.currentMessage.text, "deploy") &&
    contains(bot.currentMessage.text, "production")
  on_success:
    run: [handle-production-deployment]

# Regex pattern matching
route-pr-url:
  type: noop
  if: 'bot && /https:\/\/github\.com\/.*\/pull\/\d+/.test(bot.currentMessage.text)'
  on_success:
    run: [handle-pr-review]

# Case-insensitive matching
route-deploy-case-insensitive:
  type: noop
  if: 'bot && contains(bot.currentMessage.text.toLowerCase(), "deploy")'
  on_success:
    run: [handle-deployment]
```

### 2. Channel-Based Routing

Route based on the Slack channel where the message was posted:

```yaml
# Exact channel match
route-production:
  type: noop
  if: 'bot && bot.attributes.channel == "C123PROD"'
  on_success:
    run: [handle-production]

# Multiple channels
route-engineering:
  type: noop
  if: |
    bot && (
      bot.attributes.channel == "C111ENG" ||
      bot.attributes.channel == "C222DEV"
    )
  on_success:
    run: [handle-engineering]

# Channel prefix matching
route-prod-channels:
  type: noop
  if: 'bot && startsWith(bot.attributes.channel, "C123")'
  on_success:
    run: [handle-production-family]

# Channel type detection
route-direct-message:
  type: noop
  if: 'bot && startsWith(bot.attributes.channel, "D")'
  on_success:
    run: [handle-dm]

route-public-channel:
  type: noop
  if: 'bot && startsWith(bot.attributes.channel, "C")'
  on_success:
    run: [handle-public]

route-private-channel:
  type: noop
  if: 'bot && startsWith(bot.attributes.channel, "G")'
  on_success:
    run: [handle-private]
```

**Channel ID Prefixes:**
- `C` - Public channels
- `G` - Private channels (groups)
- `D` - Direct messages (DMs)

### 3. User-Based Routing

Route based on the user who sent the message:

```yaml
# Admin users
route-admin:
  type: noop
  if: |
    bot && (
      bot.attributes.user == "U001ADMIN" ||
      bot.attributes.user == "U002ADMIN"
    )
  on_success:
    run: [handle-admin]

# User prefix matching (team-based)
route-engineering-team:
  type: noop
  if: 'bot && startsWith(bot.attributes.user, "U10")'
  on_success:
    run: [handle-engineering]

# User denylist
route-blocked-users:
  type: noop
  if: |
    bot && (
      bot.attributes.user == "U999BLOCKED"
    )
  on_success:
    run: [reject-request]

reject-request:
  type: logger
  message: "Your access has been restricted. Contact an admin."
  fail_if: 'true'
```

### 4. Multi-Dimensional Routing

Combine multiple routing dimensions for fine-grained control:

```yaml
# User + Channel + Content
route-prod-deploy:
  type: noop
  if: |
    bot &&
    (bot.attributes.user == "U001ADMIN" || bot.attributes.user == "U002ADMIN") &&
    bot.attributes.channel == "C123PROD" &&
    contains(bot.currentMessage.text, "deploy")
  on_success:
    run: [handle-production-deployment]

# Channel + Time-based
route-business-hours-deploy:
  type: noop
  if: |
    bot &&
    bot.attributes.channel == "C123PROD" &&
    new Date().getHours() >= 9 &&
    new Date().getHours() < 17 &&
    new Date().getDay() >= 1 &&
    new Date().getDay() <= 5
  on_success:
    run: [handle-deployment]
```

### 5. History-Aware Routing

Route based on conversation history:

```yaml
# Check if this is a follow-up message
route-followup:
  type: noop
  if: 'bot && bot.history.length > 1'
  on_success:
    run: [handle-followup]

# Check previous bot message
route-deployment-followup:
  type: noop
  if: |
    bot &&
    bot.history.length > 1 &&
    bot.history[bot.history.length - 2].role == "bot" &&
    contains(bot.history[bot.history.length - 2].text, "deployment")
  on_success:
    run: [handle-deployment-followup]

# Count user messages
route-frequent-user:
  type: noop
  if: |
    bot &&
    bot.history.filter(m => m.role == "user").length > 5
  on_success:
    run: [handle-frequent-user]
```

## Bot Context API

The `bot` object provides context about the current Slack message and conversation:

### Structure

```typescript
bot: {
  id: string;                    // Unique session ID
  transport: 'slack';            // Transport type
  currentMessage: {
    role: 'user' | 'bot';       // Message sender role
    text: string;                // Message text
    timestamp: string;           // Message timestamp
    origin?: string;             // 'visor' for bot messages
  };
  history: Array<{
    role: 'user' | 'bot';
    text: string;
    timestamp: string;
    origin?: string;
  }>;
  thread: {
    id: string;                  // Thread ID (channel:timestamp)
    url?: string;                // Optional thread URL
  };
  attributes: {
    channel: string;             // Slack channel ID
    user: string;                // Slack user ID
    event_id?: string;           // Event ID
    team_id?: string;            // Workspace ID
    // ... other Slack metadata
  };
  state?: Record<string, any>;   // Transport state (cache hints, etc.)
}
```

### Accessing Bot Context

**In Liquid Templates:**
```liquid
{{ bot.currentMessage.text }}
{{ bot.attributes.channel }}
{{ bot.attributes.user }}
{{ bot.thread.id }}
{{ bot.history | size }}

{% for msg in bot.history %}
  - [{{ msg.role }}] {{ msg.text }}
{% endfor %}
```

**In JavaScript Expressions:**
```javascript
// In if, fail_if, goto_js, etc.
bot.currentMessage.text
bot.attributes.channel
bot.history.length
bot.history.filter(m => m.role === 'user')

// Check if bot context exists
if (context.bot) {
  log("Bot session:", context.bot.id);
}
```

### Guarding for CLI Compatibility

Workflows that use bot context should handle cases where `bot` is undefined (e.g., when run from CLI):

```yaml
# In Liquid templates
{% if bot %}
  User: {{ bot.attributes.user }}
{% else %}
  Running in CLI mode
{% endif %}

# In JavaScript
if: 'bot && contains(bot.currentMessage.text, "deploy")'
```

## Common Routing Patterns

### 1. Command Router

Parse commands from message text:

```yaml
command-router:
  type: noop
  on_success:
    run:
      - route-deploy-command
      - route-status-command
      - route-help-command

route-deploy-command:
  type: noop
  if: 'bot && startsWith(bot.currentMessage.text, "deploy ")'
  on_success:
    run: [parse-deploy-args, execute-deploy]

parse-deploy-args:
  type: noop
  # Extract service name after "deploy "
  value_js: |
    const text = context.bot.currentMessage.text;
    const parts = text.split(' ');
    return parts[1] || 'default-service';

execute-deploy:
  type: logger
  message: "Deploying {{ outputs.parse-deploy-args }}..."
```

### 2. Environment Router

Route to different environments:

```yaml
environment-router:
  type: noop
  on_success:
    run:
      - route-production
      - route-staging
      - route-development

route-production:
  type: noop
  if: |
    bot &&
    (bot.attributes.channel == "C123PROD" ||
     contains(bot.currentMessage.text, "production"))
  on_success:
    run: [handle-production-deployment]

route-staging:
  type: noop
  if: |
    bot &&
    (bot.attributes.channel == "C456STAGE" ||
     contains(bot.currentMessage.text, "staging"))
  on_success:
    run: [handle-staging-deployment]
```

### 3. Permission Router

Check permissions before executing:

```yaml
permission-router:
  type: noop
  on_success:
    run:
      - check-admin
      - check-engineer
      - check-viewer

check-admin:
  type: noop
  if: 'bot && ["U001", "U002"].includes(bot.attributes.user)'
  on_success:
    run: [grant-admin-access]

check-engineer:
  type: noop
  if: 'bot && startsWith(bot.attributes.user, "U10")'
  on_success:
    run: [grant-engineer-access]

check-viewer:
  type: noop
  # Everyone else gets viewer access
  on_success:
    run: [grant-viewer-access]
```

### 4. Intent-Based Router (AI)

Use AI to classify user intent:

```yaml
classify-intent:
  type: ai
  provider: claude
  prompt: |
    Classify the following message intent as one of:
    - deployment
    - code_review
    - incident
    - help
    - other

    Message: {{ bot.currentMessage.text }}

    Return only the intent name, nothing else.

route-by-intent:
  type: noop
  depends_on: [classify-intent]
  on_success:
    run:
      - route-deployment-intent
      - route-review-intent
      - route-incident-intent

route-deployment-intent:
  type: noop
  if: 'outputs["classify-intent"] == "deployment"'
  on_success:
    run: [handle-deployment]

route-review-intent:
  type: noop
  if: 'outputs["classify-intent"] == "code_review"'
  on_success:
    run: [handle-review]
```

### 5. Approval Workflow Router

Route based on approval state:

```yaml
check-approval-needed:
  type: noop
  if: |
    bot &&
    contains(bot.currentMessage.text, "deploy") &&
    bot.attributes.channel == "C123PROD" &&
    !["U001ADMIN", "U002ADMIN"].includes(bot.attributes.user)
  on_success:
    run: [request-approval]
  on_failure:
    run: [execute-directly]

request-approval:
  type: human-input
  prompt: |
    User {{ bot.attributes.user }} requests deployment.
    Admin approval required. Reply "approve" or "deny"
  validation: 'input == "approve" || input == "deny"'

handle-approval:
  type: noop
  depends_on: [request-approval]
  if: 'outputs["request-approval"] == "approve"'
  on_success:
    run: [execute-deployment]
  on_failure:
    run: [deny-deployment]
```

## Advanced Techniques

### 1. Priority Routing

Ensure routes are checked in specific order:

```yaml
priority-router:
  type: noop
  on_success:
    run: [route-urgent]

route-urgent:
  type: noop
  if: 'bot && contains(bot.currentMessage.text, "urgent")'
  on_success:
    run: [handle-urgent]
  on_failure:
    run: [route-normal]

route-normal:
  type: noop
  on_success:
    run: [handle-normal]
```

### 2. Fallback Chain

Try multiple routes with fallback:

```yaml
try-primary-handler:
  type: http
  url: "https://primary.api/handle"
  body:
    message: "{{ bot.currentMessage.text }}"
  on_failure:
    run: [try-secondary-handler]

try-secondary-handler:
  type: http
  url: "https://secondary.api/handle"
  body:
    message: "{{ bot.currentMessage.text }}"
  on_failure:
    run: [use-default-handler]
```

### 3. External Routing Service

Delegate routing decision to external API:

```yaml
get-routing-decision:
  type: http
  url: "https://api.example.com/route"
  method: POST
  body:
    user: "{{ bot.attributes.user }}"
    channel: "{{ bot.attributes.channel }}"
    message: "{{ bot.currentMessage.text }}"

route-by-api:
  type: noop
  depends_on: [get-routing-decision]
  goto_js: |
    const decision = outputs["get-routing-decision"];
    return `handle-${decision.workflow}`;
```

### 4. State-Based Routing

Route based on workflow state:

```yaml
state-router:
  type: noop
  goto_js: |
    const state = context.memory.get('workflow_state') || 'init';
    return `state-${state}`;

state-init:
  type: logger
  message: "Initializing workflow..."
  on_success:
    run: [transition-to-processing]

transition-to-processing:
  type: noop
  value_js: |
    context.memory.set('workflow_state', 'processing');
    return 'processing';
  on_success:
    run: [state-router]

state-processing:
  type: logger
  message: "Processing..."
  # ... processing logic
```

### 5. Dynamic Route Loading

Load routing configuration from external source:

```yaml
load-routes:
  type: http
  url: "https://api.example.com/routes/{{ bot.attributes.channel }}"
  method: GET

apply-routes:
  type: noop
  depends_on: [load-routes]
  goto_js: |
    const routes = outputs["load-routes"];
    const message = context.bot.currentMessage.text;

    for (const route of routes) {
      if (message.includes(route.keyword)) {
        return route.handler;
      }
    }

    return 'default-handler';
```

## Best Practices

### 1. Single Responsibility

Each route handler should focus on one task:

```yaml
# Good: Focused handlers
handle-deployment:
  type: logger
  message: "Handling deployment..."

handle-rollback:
  type: logger
  message: "Handling rollback..."

# Bad: One handler for everything
handle-everything:
  type: noop
  goto_js: |
    if (contains(bot.currentMessage.text, "deploy")) {
      // deployment logic
    } else if (contains(bot.currentMessage.text, "rollback")) {
      // rollback logic
    }
    // ... too much logic in one place
```

### 2. Explicit Over Implicit

Be explicit about routing conditions:

```yaml
# Good: Clear condition
route-production-deploy:
  type: noop
  if: |
    bot &&
    bot.attributes.channel == "C123PROD" &&
    contains(bot.currentMessage.text, "deploy")
  on_success:
    run: [handle-production-deployment]

# Bad: Implicit assumption
route-deploy:
  type: noop
  if: 'contains(bot.currentMessage.text, "deploy")'
  # Assumes production, but not explicit
  on_success:
    run: [handle-production-deployment]
```

### 3. Guard for Undefined

Always check if `bot` exists:

```yaml
# Good: Guarded
route-deploy:
  type: noop
  if: 'bot && contains(bot.currentMessage.text, "deploy")'
  on_success:
    run: [handle-deployment]

# Bad: Will fail if bot is undefined
route-deploy:
  type: noop
  if: 'contains(bot.currentMessage.text, "deploy")'
  on_success:
    run: [handle-deployment]
```

### 4. Default Handler

Always provide a default handler:

```yaml
router:
  type: noop
  on_success:
    run:
      - route-specific-case-1
      - route-specific-case-2
      - route-default  # Always include default

route-default:
  type: logger
  message: |
    I don't understand. Try:
    - help
    - deploy [service]
    - status
```

### 5. Logging and Observability

Log routing decisions for debugging:

```yaml
log-routing-decision:
  type: logger
  message: |
    Routing Decision:
    User: {{ bot.attributes.user }}
    Channel: {{ bot.attributes.channel }}
    Message: {{ bot.currentMessage.text }}
    Route: deployment

handle-deployment:
  type: logger
  depends_on: [log-routing-decision]
  message: "Executing deployment..."
```

### 6. Error Handling

Handle routing failures gracefully:

```yaml
route-with-error-handling:
  type: noop
  if: 'bot && contains(bot.currentMessage.text, "deploy")'
  on_success:
    run: [handle-deployment]
  on_failure:
    run: [handle-routing-error]

handle-routing-error:
  type: logger
  message: |
    ❌ Routing Error

    Something went wrong while processing your request.
    Please try again or contact support.
```

### 7. Documentation

Document routing logic inline:

```yaml
route-production:
  type: noop
  description: "Route production deployments (admins only, #production channel)"
  if: |
    bot &&
    (bot.attributes.user == "U001ADMIN" || bot.attributes.user == "U002ADMIN") &&
    bot.attributes.channel == "C123PROD" &&
    contains(bot.currentMessage.text, "deploy")
  on_success:
    run: [handle-production-deployment]
```

## Anti-Patterns

### 1. Over-Nested Routing

Avoid deeply nested routing logic:

```yaml
# Bad: Over-nested
route-level-1:
  type: noop
  on_success:
    run: [route-level-2]

route-level-2:
  type: noop
  on_success:
    run: [route-level-3]

route-level-3:
  type: noop
  on_success:
    run: [route-level-4]
  # Too deep!

# Good: Flat routing
main-router:
  type: noop
  on_success:
    run:
      - route-case-1
      - route-case-2
      - route-case-3
```

### 2. Duplicate Conditions

Avoid duplicating routing conditions:

```yaml
# Bad: Duplicate conditions
route-deploy-1:
  type: noop
  if: 'bot && contains(bot.currentMessage.text, "deploy")'
  on_success:
    run: [handle-deploy-1]

route-deploy-2:
  type: noop
  if: 'bot && contains(bot.currentMessage.text, "deploy")'
  on_success:
    run: [handle-deploy-2]

# Good: Single condition with multiple handlers
route-deploy:
  type: noop
  if: 'bot && contains(bot.currentMessage.text, "deploy")'
  on_success:
    run: [handle-deploy-1, handle-deploy-2]
```

### 3. Hardcoded Values

Avoid hardcoding user IDs, channel IDs, etc.:

```yaml
# Bad: Hardcoded IDs
route-admin:
  type: noop
  if: 'bot && bot.attributes.user == "U001ADMIN"'
  on_success:
    run: [handle-admin]

# Good: Use environment variables or config
route-admin:
  type: noop
  if: 'bot && bot.attributes.user == env.ADMIN_USER_ID'
  on_success:
    run: [handle-admin]
```

### 4. Silent Failures

Don't ignore routing failures:

```yaml
# Bad: No error handling
route-deploy:
  type: noop
  if: 'bot && contains(bot.currentMessage.text, "deploy")'
  on_success:
    run: [handle-deployment]
  # No on_failure - user gets no feedback

# Good: Handle all cases
route-deploy:
  type: noop
  if: 'bot && contains(bot.currentMessage.text, "deploy")'
  on_success:
    run: [handle-deployment]
  on_failure:
    run: [handle-no-match]

handle-no-match:
  type: logger
  message: "I don't understand. Try 'help' for assistance."
```

### 5. Mixing Concerns

Don't mix routing and business logic:

```yaml
# Bad: Routing and logic mixed
route-and-deploy:
  type: noop
  if: 'bot && contains(bot.currentMessage.text, "deploy")'
  on_success:
    run: [deploy-step-1, deploy-step-2, deploy-step-3]
  # Routing and deployment logic together

# Good: Separate routing and logic
route-deploy:
  type: noop
  if: 'bot && contains(bot.currentMessage.text, "deploy")'
  on_success:
    run: [handle-deployment]

handle-deployment:
  type: noop
  on_success:
    run: [deploy-step-1, deploy-step-2, deploy-step-3]
```

## Examples

Complete example configurations are available:

- **Content-Based Routing:** [`examples/slack-router-content.yaml`](../examples/slack-router-content.yaml)
  - Route by keywords (deploy, review, help, incident)
  - Regex pattern matching
  - Multi-word keyword matching
  - AI-powered intent classification

- **Channel-Based Routing:** [`examples/slack-router-channel.yaml`](../examples/slack-router-channel.yaml)
  - Production vs staging channels
  - Support channels
  - Engineering channels
  - Direct messages
  - Channel type detection

- **User-Based Routing:** [`examples/slack-router-user.yaml`](../examples/slack-router-user.yaml)
  - Admin users
  - Engineering team
  - Support team
  - Manager users
  - Permission-based access

- **Advanced Workflows:** [`examples/slack-router-advanced.yaml`](../examples/slack-router-advanced.yaml)
  - Multi-stage deployment workflows
  - Incident response workflows
  - Human-input integration
  - Approval workflows
  - Error handling and fallbacks

## Testing Router Workflows

Use Visor's Slack test mode to test router workflows:

```yaml
tests:
  - name: test-deploy-routing
    mode: slack
    slack_fixture:
      bot_user_id: U_BOT_123
      event:
        type: app_mention
        channel: C123PROD
        user: U001ADMIN
        text: "<@U_BOT_123> deploy api-service"
        ts: "1234567890.000001"
    workflow: main-router
    expect:
      outputs:
        route-deploy: true
    expect_slack:
      messages:
        - contains: "Deploying api-service"
```

See [`tests/fixtures/slack-router-tests.yaml`](../tests/fixtures/slack-router-tests.yaml) for more test examples.

## Further Reading

- [Slack Bot Setup Guide](./slack-bot-setup.md) - How to configure Slack apps
- [Bot Transports RFC](./bot-transports-rfc.md) - Technical specification
- [Visor Configuration Guide](./configuration.md) - General configuration reference
- [Human-Input Provider](./providers/human-input.md) - Interactive prompts in Slack

## Support

For questions or issues:
- File an issue on GitHub
- Join our Slack community
- Check the documentation at https://visor.dev/docs
