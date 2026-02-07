/**
 * Natural language schedule parsing using chrono-node
 * Supports both one-time and recurring schedule expressions
 */
import * as chrono from 'chrono-node';

/**
 * Parsed schedule result
 */
export interface ParsedSchedule {
  type: 'one-time' | 'recurring';
  cronExpression?: string; // For recurring schedules
  runAt?: Date; // For one-time schedules
  timezone: string;
  description: string; // Human-readable description
}

/**
 * Day of week mapping for cron expressions
 */
const DAYS_OF_WEEK: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

/**
 * Recurring pattern detection
 */
interface RecurringPattern {
  frequency:
    | 'minute'
    | 'hourly'
    | 'daily'
    | 'weekly'
    | 'monthly'
    | 'yearly'
    | 'weekday'
    | 'weekend';
  daysOfWeek?: number[];
  dayOfMonth?: number;
  hour?: number;
  minute?: number;
  interval?: number;
}

/**
 * Parse a natural language schedule expression
 *
 * @param expression Natural language time expression (e.g., "every Monday at 9am", "in 2 hours")
 * @param userTimezone IANA timezone string (e.g., "America/New_York")
 * @param referenceDate Optional reference date for parsing (defaults to now)
 * @returns Parsed schedule information
 */
export function parseScheduleExpression(
  expression: string,
  userTimezone: string = 'UTC',
  referenceDate?: Date
): ParsedSchedule {
  const trimmedExpr = expression.trim();
  const normalizedExpr = trimmedExpr.toLowerCase();
  const refDate = referenceDate || new Date();

  // First check if it's a standard cron expression (5 space-separated parts)
  if (isValidCronExpression(trimmedExpr)) {
    return {
      type: 'recurring',
      cronExpression: trimmedExpr,
      timezone: userTimezone,
      description: describeCronExpression(trimmedExpr),
    };
  }

  // Check for natural language recurring patterns
  const recurring = detectRecurringPattern(normalizedExpr);
  if (recurring) {
    const cronExpr = buildCronExpression(recurring);
    return {
      type: 'recurring',
      cronExpression: cronExpr,
      timezone: userTimezone,
      description: buildRecurringDescription(recurring),
    };
  }

  // Try to parse as a one-time schedule using chrono
  const parsed = chrono.parseDate(expression, refDate, { forwardDate: true });

  if (!parsed) {
    throw new Error(
      `Could not parse schedule expression: "${expression}". Try formats like "in 2 hours", "tomorrow at 3pm", "every Monday at 9am", or a cron expression like "0 9 * * 1".`
    );
  }

  // Ensure the parsed date is in the future
  if (parsed.getTime() <= Date.now()) {
    // Add 24 hours if it parsed to a past time today
    parsed.setDate(parsed.getDate() + 1);
  }

  return {
    type: 'one-time',
    runAt: parsed,
    timezone: userTimezone,
    description: formatOneTimeDescription(parsed),
  };
}

/**
 * Detect recurring patterns in the expression
 */
function detectRecurringPattern(expr: string): RecurringPattern | null {
  // Check for keywords that indicate recurring schedules
  if (
    !expr.includes('every') &&
    !expr.includes('daily') &&
    !expr.includes('weekly') &&
    !expr.includes('monthly')
  ) {
    return null;
  }

  // Extract time component
  const timeMatch = expr.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  let hour: number | undefined;
  let minute: number | undefined;

  if (timeMatch) {
    hour = parseInt(timeMatch[1], 10);
    minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;

    // Convert to 24-hour format
    const ampm = timeMatch[3]?.toLowerCase();
    if (ampm === 'pm' && hour !== 12) {
      hour += 12;
    } else if (ampm === 'am' && hour === 12) {
      hour = 0;
    }
  } else {
    // Check for special times
    if (expr.includes('noon')) {
      hour = 12;
      minute = 0;
    } else if (expr.includes('midnight')) {
      hour = 0;
      minute = 0;
    } else if (expr.includes('morning')) {
      hour = 9;
      minute = 0;
    } else if (expr.includes('evening')) {
      hour = 18;
      minute = 0;
    }
  }

  // Every minute (singular, no number)
  if (expr.match(/every\s+minute\b/i) && !expr.match(/every\s+\d+\s+minute/i)) {
    return {
      frequency: 'minute',
      interval: 1,
      minute: 0,
    };
  }

  // Every hour (singular, no number)
  if (expr.match(/every\s+hour\b/i) && !expr.match(/every\s+\d+\s+hour/i)) {
    return {
      frequency: 'hourly',
      interval: 1,
      minute: minute ?? 0,
    };
  }

  // Every N minutes/hours
  const intervalMatch = expr.match(/every\s+(\d+)\s+(minute|hour)s?/i);
  if (intervalMatch) {
    const interval = parseInt(intervalMatch[1], 10);
    const unit = intervalMatch[2].toLowerCase();

    if (unit === 'minute') {
      return {
        frequency: 'minute',
        interval,
        minute: 0,
      };
    } else {
      return {
        frequency: 'hourly',
        interval,
        minute: minute ?? 0,
      };
    }
  }

  // Every day / daily
  if (expr.includes('every day') || expr.includes('daily')) {
    return {
      frequency: 'daily',
      hour: hour ?? 9,
      minute: minute ?? 0,
    };
  }

  // Every weekday
  if (
    expr.includes('weekday') ||
    (expr.includes('monday') && expr.includes('friday') && expr.includes('through'))
  ) {
    return {
      frequency: 'weekday',
      hour: hour ?? 9,
      minute: minute ?? 0,
    };
  }

  // Every weekend
  if (expr.includes('weekend')) {
    return {
      frequency: 'weekend',
      hour: hour ?? 10,
      minute: minute ?? 0,
    };
  }

  // Monthly - check before day of week to avoid false matches
  if (expr.includes('monthly') || expr.includes('every month')) {
    const dayOfMonthMatch = expr.match(/(?:on the\s+)?(\d{1,2})(?:st|nd|rd|th)?/);
    const dayOfMonth = dayOfMonthMatch ? parseInt(dayOfMonthMatch[1], 10) : 1;
    return {
      frequency: 'monthly',
      dayOfMonth,
      hour: hour ?? 9,
      minute: minute ?? 0,
    };
  }

  // Weekly on specific day(s)
  if (expr.includes('weekly') || expr.includes('every week')) {
    // Default to Monday if no day specified
    const daysOfWeek = extractDaysOfWeek(expr);
    return {
      frequency: 'weekly',
      daysOfWeek: daysOfWeek.length > 0 ? daysOfWeek : [1],
      hour: hour ?? 9,
      minute: minute ?? 0,
    };
  }

  // Every [day of week]
  const daysOfWeek = extractDaysOfWeek(expr);
  if (daysOfWeek.length > 0) {
    return {
      frequency: 'weekly',
      daysOfWeek,
      hour: hour ?? 9,
      minute: minute ?? 0,
    };
  }

  // If we detected "every" but couldn't parse the pattern, default to daily
  if (expr.includes('every')) {
    return {
      frequency: 'daily',
      hour: hour ?? 9,
      minute: minute ?? 0,
    };
  }

  return null;
}

/**
 * Extract days of week from expression
 */
function extractDaysOfWeek(expr: string): number[] {
  const days: Set<number> = new Set();

  for (const [dayName, dayNum] of Object.entries(DAYS_OF_WEEK)) {
    if (expr.includes(dayName)) {
      days.add(dayNum);
    }
  }

  return Array.from(days).sort((a, b) => a - b);
}

/**
 * Build a cron expression from a recurring pattern
 *
 * Cron format: minute hour day-of-month month day-of-week
 */
function buildCronExpression(pattern: RecurringPattern): string {
  const minute = pattern.minute ?? 0;
  const hour = pattern.hour ?? 9;

  switch (pattern.frequency) {
    case 'minute':
      // Every N minutes
      if (pattern.interval && pattern.interval > 1) {
        return `*/${pattern.interval} * * * *`;
      }
      return '* * * * *';

    case 'hourly':
      // Every N hours
      if (pattern.interval && pattern.interval > 1) {
        return `${minute} */${pattern.interval} * * *`;
      }
      return `${minute} * * * *`;

    case 'daily':
      return `${minute} ${hour} * * *`;

    case 'weekday':
      return `${minute} ${hour} * * 1-5`;

    case 'weekend':
      return `${minute} ${hour} * * 0,6`;

    case 'weekly':
      const days = pattern.daysOfWeek?.join(',') ?? '1';
      return `${minute} ${hour} * * ${days}`;

    case 'monthly':
      const dayOfMonth = pattern.dayOfMonth ?? 1;
      return `${minute} ${hour} ${dayOfMonth} * *`;

    case 'yearly':
      return `${minute} ${hour} 1 1 *`;

    default:
      return `${minute} ${hour} * * *`;
  }
}

/**
 * Build a human-readable description for recurring schedules
 */
function buildRecurringDescription(pattern: RecurringPattern): string {
  const timeStr = formatTime(pattern.hour ?? 9, pattern.minute ?? 0);

  switch (pattern.frequency) {
    case 'minute':
      if (pattern.interval && pattern.interval > 1) {
        return `Every ${pattern.interval} minutes`;
      }
      return 'Every minute';

    case 'hourly':
      if (pattern.interval && pattern.interval > 1) {
        return `Every ${pattern.interval} hours at :${String(pattern.minute ?? 0).padStart(2, '0')}`;
      }
      return `Every hour at :${String(pattern.minute ?? 0).padStart(2, '0')}`;

    case 'daily':
      return `Daily at ${timeStr}`;

    case 'weekday':
      return `Weekdays at ${timeStr}`;

    case 'weekend':
      return `Weekends at ${timeStr}`;

    case 'weekly':
      const dayNames = (pattern.daysOfWeek ?? [1])
        .map(d => Object.entries(DAYS_OF_WEEK).find(([, v]) => v === d)?.[0] ?? String(d))
        .map(n => n.charAt(0).toUpperCase() + n.slice(1, 3));
      return `Every ${dayNames.join(', ')} at ${timeStr}`;

    case 'monthly':
      return `Monthly on the ${ordinal(pattern.dayOfMonth ?? 1)} at ${timeStr}`;

    case 'yearly':
      return `Yearly on January 1st at ${timeStr}`;

    default:
      return `At ${timeStr}`;
  }
}

/**
 * Format time in 12-hour format
 */
function formatTime(hour: number, minute: number): string {
  const h = hour % 12 || 12;
  const m = String(minute).padStart(2, '0');
  const ampm = hour >= 12 ? 'PM' : 'AM';
  return `${h}:${m} ${ampm}`;
}

/**
 * Format a one-time schedule description
 */
function formatOneTimeDescription(date: Date): string {
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffMins = Math.round(diffMs / 60000);
  const diffHours = Math.round(diffMs / 3600000);
  const diffDays = Math.round(diffMs / 86400000);

  // Format the actual time
  const timeStr = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  // Format the date
  const dateOptions: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  };

  if (date.getFullYear() !== now.getFullYear()) {
    dateOptions.year = 'numeric';
  }

  const dateStr = date.toLocaleDateString('en-US', dateOptions);

  // Add relative time if within 24 hours
  if (diffMins < 60) {
    return `In ${diffMins} minute${diffMins !== 1 ? 's' : ''} (${dateStr} at ${timeStr})`;
  } else if (diffHours < 24) {
    return `In ${diffHours} hour${diffHours !== 1 ? 's' : ''} (${dateStr} at ${timeStr})`;
  } else if (diffDays === 1) {
    return `Tomorrow at ${timeStr}`;
  } else if (diffDays < 7) {
    return `${dateStr} at ${timeStr}`;
  }

  return `${dateStr} at ${timeStr}`;
}

/**
 * Calculate the next run time for a cron expression
 */
export function getNextRunTime(cronExpression: string, _timezone: string = 'UTC'): Date {
  // Note: Full timezone support would require a library like luxon or date-fns-tz
  // For now, calculations are done in local time
  // Simple cron parser for next run calculation
  // For production, consider using a library like 'cron-parser'
  const parts = cronExpression.split(' ');
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: ${cronExpression}`);
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const now = new Date();

  // Start from the next minute
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1);

  // Try to find the next matching time (within 1 year)
  const maxAttempts = 365 * 24 * 60; // 1 year of minutes
  for (let i = 0; i < maxAttempts; i++) {
    if (
      matchesCronPart(next.getMinutes(), minute) &&
      matchesCronPart(next.getHours(), hour) &&
      matchesCronPart(next.getDate(), dayOfMonth) &&
      matchesCronPart(next.getMonth() + 1, month) &&
      matchesCronPart(next.getDay(), dayOfWeek)
    ) {
      return next;
    }
    next.setMinutes(next.getMinutes() + 1);
  }

  // Fallback to tomorrow at the specified time
  const fallback = new Date(now);
  fallback.setDate(fallback.getDate() + 1);
  fallback.setHours(parseInt(hour, 10) || 9);
  fallback.setMinutes(parseInt(minute, 10) || 0);
  fallback.setSeconds(0, 0);
  return fallback;
}

/**
 * Check if a value matches a cron part
 */
function matchesCronPart(value: number, cronPart: string): boolean {
  if (cronPart === '*') return true;

  // Handle step values (*/n)
  if (cronPart.startsWith('*/')) {
    const step = parseInt(cronPart.slice(2), 10);
    return value % step === 0;
  }

  // Handle ranges (n-m)
  if (cronPart.includes('-')) {
    const [start, end] = cronPart.split('-').map(n => parseInt(n, 10));
    return value >= start && value <= end;
  }

  // Handle lists (n,m,o)
  if (cronPart.includes(',')) {
    return cronPart
      .split(',')
      .map(n => parseInt(n, 10))
      .includes(value);
  }

  // Handle exact value
  return parseInt(cronPart, 10) === value;
}

/**
 * Get ordinal suffix for a number
 */
function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/**
 * Validate a cron expression
 */
export function isValidCronExpression(expr: string): boolean {
  if (!expr || typeof expr !== 'string') return false;

  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const ranges: [number, number][] = [
    [0, 59], // minute
    [0, 23], // hour
    [1, 31], // day of month
    [1, 12], // month
    [0, 7], // day of week (0 and 7 are Sunday)
  ];

  return parts.every((part, i) => {
    if (part === '*') return true;
    if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2), 10);
      return !isNaN(step) && step > 0;
    }
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(n => parseInt(n, 10));
      return !isNaN(start) && !isNaN(end) && start >= ranges[i][0] && end <= ranges[i][1];
    }
    if (part.includes(',')) {
      return part.split(',').every(n => {
        const val = parseInt(n, 10);
        return !isNaN(val) && val >= ranges[i][0] && val <= ranges[i][1];
      });
    }
    const val = parseInt(part, 10);
    return !isNaN(val) && val >= ranges[i][0] && val <= ranges[i][1];
  });
}

/**
 * Generate a human-readable description for a cron expression
 */
function describeCronExpression(cronExpr: string): string {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return `Cron: ${cronExpr}`;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const descriptions: string[] = [];

  // Time description
  if (minute === '*' && hour === '*') {
    descriptions.push('Every minute');
  } else if (minute.startsWith('*/')) {
    const interval = parseInt(minute.slice(2), 10);
    descriptions.push(`Every ${interval} minute${interval > 1 ? 's' : ''}`);
  } else if (hour.startsWith('*/')) {
    const interval = parseInt(hour.slice(2), 10);
    const m = minute === '*' ? 0 : parseInt(minute, 10);
    descriptions.push(
      `Every ${interval} hour${interval > 1 ? 's' : ''} at :${String(m).padStart(2, '0')}`
    );
  } else {
    const h = hour === '*' ? null : parseInt(hour, 10);
    const m = minute === '*' ? 0 : parseInt(minute, 10);
    if (h !== null) {
      descriptions.push(`At ${formatTime(h, m)}`);
    } else {
      descriptions.push(`At :${String(m).padStart(2, '0')}`);
    }
  }

  // Day of week description
  if (dayOfWeek !== '*') {
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    if (dayOfWeek === '1-5') {
      descriptions.push('on weekdays');
    } else if (dayOfWeek === '0,6' || dayOfWeek === '6,0') {
      descriptions.push('on weekends');
    } else if (dayOfWeek.includes(',')) {
      const days = dayOfWeek.split(',').map(d => dayNames[parseInt(d, 10) % 7]);
      descriptions.push(`on ${days.join(', ')}`);
    } else if (dayOfWeek.includes('-')) {
      const [start, end] = dayOfWeek.split('-').map(d => parseInt(d, 10) % 7);
      descriptions.push(`on ${dayNames[start]}-${dayNames[end]}`);
    } else {
      const dayNum = parseInt(dayOfWeek, 10) % 7;
      descriptions.push(`on ${dayNames[dayNum]}`);
    }
  }

  // Day of month description
  if (dayOfMonth !== '*' && dayOfWeek === '*') {
    if (dayOfMonth.includes(',')) {
      const days = dayOfMonth.split(',');
      descriptions.push(`on day${days.length > 1 ? 's' : ''} ${days.join(', ')} of the month`);
    } else {
      descriptions.push(`on day ${dayOfMonth} of the month`);
    }
  }

  // Month description
  if (month !== '*') {
    const monthNames = [
      '',
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    if (month.includes(',')) {
      const months = month.split(',').map(m => monthNames[parseInt(m, 10)]);
      descriptions.push(`in ${months.join(', ')}`);
    } else {
      descriptions.push(`in ${monthNames[parseInt(month, 10)]}`);
    }
  }

  return descriptions.join(' ');
}
