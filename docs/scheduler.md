# Scheduler

The Visor scheduler provides a generic, frontend-agnostic system for executing workflows at specified times. It supports both static schedules defined in YAML configuration and dynamic schedules created via AI tool at runtime.

## Overview

When a schedule fires, it runs a visor workflow/check. Output destinations (Slack, GitHub, webhooks) become workflow responsibilities, making the scheduler truly frontend-agnostic.

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

Users can create schedules dynamically through the AI tool:

```
User: "Run the daily-report check every Monday at 9am and post to #team"
AI: [creates schedule with workflow=daily-report, cron=0 9 * * 1, output=slack:#team]
```

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

### Schedule Types

The scheduler automatically determines schedule type based on context:

| Context | Schedule Type |
|---------|---------------|
| CLI | personal |
| Slack DM | personal |
| Slack channel | channel |
| Output to @user | dm |
| Output to #channel | channel |

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

When running the Slack bot, the scheduler automatically starts and uses the Slack output adapter:

```javascript
// In socket-runner.ts
const genericScheduler = new Scheduler({
  visorConfig: config,
  outputAdapters: [new SlackOutputAdapter(slackClient)],
});
await genericScheduler.start();
```

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

## Migration from Legacy Reminders

If you have existing Slack reminders, they're automatically migrated to the new schedule format:

| Old Field | New Field |
|-----------|-----------|
| `prompt` | `workflow: legacy-reminder` + output context |
| `userId` | `creatorId` |
| `target: 'dm'` | `outputContext.type: 'slack'` + DM target |
| `target: 'channel'` | `outputContext.type: 'slack'` + channel target |

Legacy reminders continue to work - they're converted to schedules that run a special `legacy-reminder` workflow.

## Troubleshooting

### Schedule Not Running

1. Check scheduler is running: `visor schedule start`
2. Verify schedule status: `visor schedule list`
3. Check workflow exists in config
4. Verify permissions allow the schedule type

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
  creatorContext?: string;             // "slack:U123", "github:user", "cli"
  timezone: string;                    // IANA timezone
  schedule: string;                    // Cron expression
  runAt?: number;                      // Unix timestamp (one-time)
  isRecurring: boolean;
  originalExpression: string;          // Natural language input
  workflow: string;                    // Workflow/check ID
  workflowInputs?: Record<string, unknown>;
  outputContext?: ScheduleOutputContext;
  status: 'active' | 'paused' | 'completed' | 'failed';
  nextRunAt?: number;
  lastRunAt?: number;
  runCount: number;
  failureCount: number;
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
