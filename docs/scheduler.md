# Scheduler

The Visor scheduler provides a generic, frontend-agnostic system for executing workflows and reminders at specified times. It supports both static schedules defined in YAML configuration and dynamic schedules created via AI tool at runtime.

## Overview

The scheduler operates in two modes:

1. **Workflow Schedules**: Execute a named workflow/check from your configuration
2. **Simple Reminders**: Post a message or run it through the visor pipeline (e.g., for AI-powered responses)

Output destinations (Slack, GitHub, webhooks) are handled by **output adapters**, making the scheduler truly frontend-agnostic. When running with Slack, the `SlackOutputAdapter` automatically posts results back to the appropriate channel or DM.

## Configuration

Add scheduler settings to your `.visor.yaml`:

```yaml
scheduler:
  enabled: true
  storage:
    path: .visor/schedules.json
  default_timezone: America/New_York
  check_interval_ms: 60000  # How often to check for due schedules

  # Limits for dynamic schedules (created via AI tool)
  limits:
    max_per_user: 25
    max_recurring_per_user: 10
    max_global: 1000

  # Permissions for dynamic schedule creation
  permissions:
    allow_personal: true      # Allow schedules via DM or CLI
    allow_channel: true       # Allow channel schedules (Slack)
    allow_dm: true            # Allow DM schedules to other users
    allowed_workflows:        # Glob patterns for allowed workflows
      - "report-*"
      - "status-*"
    denied_workflows:         # Glob patterns for denied workflows
      - "admin-*"
      - "dangerous-*"

  # Static cron jobs (always allowed, bypass permissions)
  cron:
    daily-standup:
      schedule: "0 9 * * 1-5"  # Weekdays at 9am
      workflow: daily-standup
      timezone: America/New_York
      output:
        type: slack
        target: "#engineering"

    weekly-report:
      schedule: "0 10 * * 1"   # Mondays at 10am
      workflow: weekly-report
      inputs:
        team: platform
      output:
        type: slack
        target: "#platform-team"
```

## Static Cron Jobs

Static cron jobs are defined in your configuration file and always run regardless of permission settings. They're ideal for recurring organizational tasks:

```yaml
scheduler:
  cron:
    security-scan:
      schedule: "0 2 * * *"  # Daily at 2am
      workflow: security-scan
      output:
        type: slack
        target: "#security-alerts"

    backup-status:
      schedule: "0 6 * * *"  # Daily at 6am
      workflow: backup-check
      inputs:
        notify_on_failure: true
```

### Cron Expression Format

Standard 5-field cron expressions:
- `* * * * *` - minute, hour, day of month, month, day of week
- `0 9 * * *` - Every day at 9:00 AM
- `0 9 * * 1-5` - Weekdays at 9:00 AM
- `*/15 * * * *` - Every 15 minutes
- `0 0 1 * *` - First day of every month at midnight

## Dynamic Schedules (AI Tool)

Users can create schedules dynamically through the AI tool. The AI is responsible for:

1. **Extracting timing**: Converting natural language to cron expressions or ISO timestamps
2. **Determining targets**: Using the current channel context (channel ID from conversation)
3. **Identifying recurrence**: One-time vs recurring schedules

### Example Interactions

```
User in DM: "remind me to check builds every day at 9am"
AI: [calls schedule tool with action=create, reminder_text="check builds",
     cron="0 9 * * *", target_type="dm", target_id="D09SZABNLG3"]

User in #security: "run security-scan every Monday at 10am"
AI: [calls schedule tool with action=create, workflow="security-scan",
     cron="0 10 * * 1", target_type="channel", target_id="C05ABC123"]

User in DM: "remind me in 2 hours to review the PR"
AI: [calls schedule tool with action=create, reminder_text="review the PR",
     run_at="2026-02-08T18:00:00Z", target_type="dm", target_id="D09SZABNLG3"]
```

### AI Tool Parameters

The AI generates structured parameters:

| Parameter | Description |
|-----------|-------------|
| `reminder_text` | What to say when the schedule fires |
| `workflow` | Alternatively, a workflow to execute |
| `target_type` | "channel", "dm", "thread", or "user" |
| `target_id` | Slack channel ID (C... or D...) |
| `cron` | For recurring: cron expression |
| `run_at` | For one-time: ISO 8601 timestamp |
| `is_recurring` | Boolean flag |

### Permission Controls

Dynamic schedules respect the `permissions` configuration:

- **allow_personal**: Controls personal schedules (DM context or CLI)
- **allow_channel**: Controls channel schedules (Slack channels)
- **allow_dm**: Controls DM schedules to other users
- **allowed_workflows**: Glob patterns that workflows must match
- **denied_workflows**: Glob patterns that block workflows (checked first)

```yaml
permissions:
  allow_personal: true
  allow_channel: false     # Disable channel schedules
  allow_dm: false          # Disable DM schedules
  allowed_workflows:
    - "report-*"           # Only allow report workflows
```

### Schedule Types and Context Restrictions

The scheduler determines schedule type based on context and enforces restrictions:

| Context | Allowed Schedule Type |
|---------|----------------------|
| CLI | personal only |
| Slack DM | personal only |
| Slack channel | channel only |
| Slack group DM | dm only |

**Context-Based Enforcement**: When creating a schedule from a DM, you can only create personal schedules. When in a channel, you can only create channel schedules. This prevents cross-context leakage (e.g., personal reminders shouldn't appear when listing schedules in a public channel).

### List Filtering

When listing schedules, only schedules matching the current context type are shown:
- In a DM: Only personal schedules
- In a channel: Only channel schedules
- In a group DM: Only dm/group schedules

This protects privacy - personal reminders created in a DM won't be visible when someone lists schedules in a public channel.

## CLI Commands

### Start the Scheduler Daemon

```bash
visor schedule start [--config .visor.yaml]
```

Runs the scheduler daemon that checks for and executes due schedules.

### List Schedules

```bash
visor schedule list [--user <userId>] [--status <status>] [--json]
```

Shows schedules. Use `--json` for machine-readable output.

### Create a Schedule

```bash
visor schedule create <workflow> --at "<expression>" [--inputs key=value] [--output-type slack] [--output-target #channel]
```

Examples:
```bash
# One-time schedule
visor schedule create daily-report --at "tomorrow at 9am"

# Recurring schedule
visor schedule create standup --at "every weekday at 9am" --output-type slack --output-target "#team"

# With inputs
visor schedule create backup-check --at "every day at 2am" --inputs environment=production
```

### Cancel a Schedule

```bash
visor schedule cancel <id>
```

### Pause/Resume

```bash
visor schedule pause <id>
visor schedule resume <id>
```

## Output Adapters

When a schedule executes, results can be routed to different destinations:

### Slack Output

```yaml
output:
  type: slack
  target: "#channel-name"  # or @username for DM
  thread_id: "1234567890.123456"  # Optional thread
```

### GitHub Output

```yaml
output:
  type: github
  target: "owner/repo"
```

### Webhook Output

```yaml
output:
  type: webhook
  target: "https://example.com/webhook"
```

### No Output

```yaml
output:
  type: none
```

## Integration with Slack

When running the Slack bot, the scheduler automatically starts and integrates with the Slack frontend:

```typescript
// In socket-runner.ts
import { Scheduler, createSlackOutputAdapter } from '../scheduler';

// Create scheduler
this.genericScheduler = new Scheduler(this.visorConfig, schedulerConfig);

// Set execution context so scheduled reminders can use the Slack client
this.genericScheduler.setExecutionContext({
  slack: this.client,
  slackClient: this.client,
});

// Register Slack output adapter for posting results
this.genericScheduler.registerOutputAdapter(
  createSlackOutputAdapter(this.client)
);

await this.genericScheduler.start();
```

### Execution Context

The scheduler uses an execution context to pass runtime dependencies to workflow executions:

- **`slackClient`**: The Slack API client for posting messages
- **`cliMessage`**: For simple reminders, this bypasses `human-input` prompts

### First Message Seeding

For simple reminders, the scheduler seeds the `PromptStateManager` so that `human-input` checks can consume the reminder text as if the user sent it:

```typescript
const mgr = getPromptStateManager();
mgr.setFirstMessage(channel, threadTs, reminderText);
```

This ensures reminders run through chat workflows smoothly without blocking for user input.

## Natural Language Parsing

The scheduler understands various time expressions:

### One-time
- "in 2 hours"
- "in 30 minutes"
- "tomorrow at 9am"
- "next Monday at 3pm"
- "Friday at noon"

### Recurring
- "every day at 9am"
- "every Monday at 9am"
- "every weekday at 9am"
- "every hour"
- "every 30 minutes"
- "every month on the 1st at midnight"

## Schedule Lifecycle

1. **Created**: Schedule is stored with status `active`
2. **Due**: When current time >= nextRunAt, schedule is picked up
3. **Executing**: Workflow runs with schedule context
4. **Completed**:
   - One-time: status changes to `completed`
   - Recurring: `nextRunAt` is updated, status stays `active`
5. **Paused**: Schedule is skipped during checks
6. **Failed**: Increments `failureCount`, may be retried

## Simple Reminders (No Workflow)

When a schedule has no `workflow` specified but includes `workflowInputs.text`, it runs as a "simple reminder":

1. The reminder text is treated as if the user sent it as a new message
2. It runs through the full visor pipeline (all configured checks)
3. The AI processes it and posts the response back via the Slack frontend
4. The `SlackOutputAdapter` detects when the pipeline handled output and avoids double-posting

This allows reminders like "check how many Jira tickets were created this week" to get an AI-generated response rather than just echoing the reminder text.

```yaml
# Example: Schedule created via AI tool
# When this fires, it runs through the pipeline and posts the AI response
{
  "workflowInputs": { "text": "How many PRs were merged today?" },
  "outputContext": { "type": "slack", "target": "D09SZABNLG3" }
}
```

## Architecture

### File Structure

```
src/
├── scheduler/                    # Generic scheduler module
│   ├── index.ts                  # Public exports
│   ├── schedule-store.ts         # JSON persistence for schedules
│   ├── schedule-parser.ts        # Natural language parsing utilities
│   ├── scheduler.ts              # Generic scheduler daemon
│   ├── schedule-tool.ts          # AI tool for schedule management
│   └── cli-handler.ts            # CLI command handlers
│
└── slack/
    └── slack-output-adapter.ts   # Posts results to Slack
```

### Key Components

| Component | Purpose |
|-----------|---------|
| `Scheduler` | Main daemon that checks for due schedules and executes them |
| `ScheduleStore` | Singleton for persisting schedules to JSON |
| `ScheduleOutputAdapter` | Interface for output destinations |
| `SlackOutputAdapter` | Implements output posting for Slack |
| `schedule-tool` | AI tool definition and handler |

### Execution Flow

1. User creates schedule via AI tool or CLI
2. `ScheduleStore.create()` persists schedule
3. `Scheduler` either sets up cron job (recurring) or setTimeout (one-time)
4. When schedule fires:
   - With workflow: Runs named workflow via `StateMachineExecutionEngine`
   - Without workflow: Runs reminder text through full visor pipeline
5. `SlackOutputAdapter.sendResult()` posts results (unless pipeline already handled it)

## Troubleshooting

### Schedule Not Running

1. Check scheduler is running: `visor schedule start`
2. Verify schedule status: `visor schedule list`
3. Check workflow exists in config
4. Verify permissions allow the schedule type

### Reminder Not Posting to Slack

1. Verify the execution context includes Slack client:
   ```typescript
   scheduler.setExecutionContext({ slack: client, slackClient: client });
   ```
2. Check that `SlackOutputAdapter` is registered:
   ```typescript
   scheduler.registerOutputAdapter(createSlackOutputAdapter(client));
   ```
3. For simple reminders, verify the pipeline has a `human-input` check and AI check
4. Check logs for `[SlackOutputAdapter] Skipping post` - this means the pipeline already handled output

### Personal Reminders Showing in Channel

If personal reminders appear when listing in a channel, ensure:
1. The `allowedScheduleType` context is being set correctly based on channel type
2. The schedule's `outputContext.target` correctly identifies the channel type

### Permission Denied

1. Check `permissions` config matches schedule type
2. Verify workflow matches `allowed_workflows` patterns
3. Ensure workflow doesn't match `denied_workflows`

### Timezone Issues

1. Set explicit timezone in config: `default_timezone: America/New_York`
2. User timezone is captured when schedule is created
3. All times stored as UTC internally

## API Reference

### Schedule Interface

```typescript
interface Schedule {
  id: string;                          // UUID v4
  creatorId: string;                   // User who created
  creatorName?: string;                // User display name (for messages)
  creatorContext?: string;             // "slack:U123", "github:user", "cli"
  timezone: string;                    // IANA timezone
  schedule: string;                    // Cron expression (empty for one-time)
  runAt?: number;                      // Unix timestamp (one-time only)
  isRecurring: boolean;
  originalExpression: string;          // Natural language input (for display)
  workflow?: string;                   // Workflow/check ID (undefined for simple reminders)
  workflowInputs?: Record<string, unknown>;  // For reminders: { text: "..." }
  outputContext?: ScheduleOutputContext;
  status: 'active' | 'paused' | 'completed' | 'failed';
  nextRunAt?: number;
  lastRunAt?: number;
  runCount: number;
  failureCount: number;
  lastError?: string;                  // Last error message if failed
  createdAt: number;                   // Creation timestamp
}
```

### ScheduleOutputContext

```typescript
interface ScheduleOutputContext {
  type: 'slack' | 'github' | 'webhook' | 'none';
  target?: string;
  threadId?: string;
  metadata?: Record<string, unknown>;
}
```
