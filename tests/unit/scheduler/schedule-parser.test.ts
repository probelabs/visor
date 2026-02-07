/**
 * Unit tests for schedule-parser.ts
 * Tests cron expression handling and recurring pattern parsing
 * Note: Natural language parsing like "in 2 hours" is now handled by the AI
 */
import {
  parseScheduleExpression,
  getNextRunTime,
  isValidCronExpression,
} from '../../../src/scheduler/schedule-parser';

describe('parseScheduleExpression', () => {
  const timezone = 'America/New_York';

  describe('ISO timestamp expressions', () => {
    it('should parse valid ISO 8601 timestamp', () => {
      const futureDate = new Date(Date.now() + 3600000); // 1 hour from now
      const result = parseScheduleExpression(futureDate.toISOString(), timezone);

      expect(result.type).toBe('one-time');
      expect(result.runAt).toBeDefined();
      expect(result.runAt!.getTime()).toBeCloseTo(futureDate.getTime(), -3);
    });

    it('should throw for past ISO timestamps', () => {
      const pastDate = new Date(Date.now() - 3600000); // 1 hour ago
      expect(() => {
        parseScheduleExpression(pastDate.toISOString(), timezone);
      }).toThrow('must be in the future');
    });
  });

  describe('Recurring expressions', () => {
    it('should parse "every day at 9am"', () => {
      const result = parseScheduleExpression('every day at 9am', timezone);

      expect(result.type).toBe('recurring');
      expect(result.cronExpression).toBeDefined();
      // Should run at 9:00
      expect(result.cronExpression).toMatch(/\s9\s/);
    });

    it('should parse "every Monday at 9am"', () => {
      const result = parseScheduleExpression('every Monday at 9am', timezone);

      expect(result.type).toBe('recurring');
      expect(result.cronExpression).toBeDefined();
      // Should have Monday (1) in day of week field
      expect(result.cronExpression).toMatch(/1$/);
    });

    it('should parse "every hour"', () => {
      const result = parseScheduleExpression('every hour', timezone);

      expect(result.type).toBe('recurring');
      expect(result.cronExpression).toBeDefined();
    });

    it('should parse "every 30 minutes"', () => {
      const result = parseScheduleExpression('every 30 minutes', timezone);

      expect(result.type).toBe('recurring');
      expect(result.cronExpression).toBeDefined();
    });

    it('should parse "every weekday at 9am"', () => {
      const result = parseScheduleExpression('every weekday at 9am', timezone);

      expect(result.type).toBe('recurring');
      expect(result.cronExpression).toBeDefined();
      // Should have weekday pattern (1-5)
      expect(result.cronExpression).toMatch(/1-5$/);
    });

    it('should parse standard cron expression', () => {
      const result = parseScheduleExpression('0 9 * * 1', timezone);

      expect(result.type).toBe('recurring');
      expect(result.cronExpression).toBe('0 9 * * 1');
      expect(result.description).toContain('At');
    });

    it('should parse cron with ranges', () => {
      const result = parseScheduleExpression('0 9 * * 1-5', timezone);

      expect(result.type).toBe('recurring');
      expect(result.cronExpression).toBe('0 9 * * 1-5');
      expect(result.description).toContain('weekdays');
    });

    it('should parse cron with lists', () => {
      const result = parseScheduleExpression('0 9,12 * * *', timezone);

      expect(result.type).toBe('recurring');
      expect(result.cronExpression).toBe('0 9,12 * * *');
    });

    it('should parse cron with step values', () => {
      const result = parseScheduleExpression('*/15 * * * *', timezone);

      expect(result.type).toBe('recurring');
      expect(result.cronExpression).toBe('*/15 * * * *');
      expect(result.description).toContain('15 minute');
    });
  });

  describe('Edge cases', () => {
    it('should handle mixed case input', () => {
      const result = parseScheduleExpression('Every MONDAY at 9AM', timezone);

      expect(result.type).toBe('recurring');
    });

    it('should throw for invalid expressions', () => {
      expect(() => {
        parseScheduleExpression('whenever', timezone);
      }).toThrow();
    });

    it('should throw for natural language (not supported)', () => {
      // These expressions require AI to convert - parseScheduleExpression only handles cron/ISO
      expect(() => {
        parseScheduleExpression('in 2 hours', timezone);
      }).toThrow('Could not parse');

      expect(() => {
        parseScheduleExpression('tomorrow at 3pm', timezone);
      }).toThrow('Could not parse');
    });
  });
});

describe('getNextRunTime', () => {
  it('should return next run time for cron expression', () => {
    const now = new Date();
    const cronExpression = '0 9 * * *'; // Every day at 9am

    const nextRun = getNextRunTime(cronExpression, 'UTC');

    expect(nextRun).toBeInstanceOf(Date);
    expect(nextRun.getTime()).toBeGreaterThan(now.getTime());
  });

  it('should return valid next run for weekly schedule', () => {
    const cronExpression = '0 9 * * 1'; // Every Monday at 9am

    const nextRun = getNextRunTime(cronExpression, 'UTC');

    // Should be a Monday
    expect(nextRun.getDay()).toBe(1);
  });

  it('should handle step values correctly', () => {
    const cronExpression = '*/30 * * * *'; // Every 30 minutes

    const nextRun = getNextRunTime(cronExpression, 'UTC');

    // Minutes should be 0 or 30
    expect([0, 30]).toContain(nextRun.getMinutes());
  });

  it('should throw for invalid cron expression', () => {
    expect(() => {
      getNextRunTime('invalid', 'UTC');
    }).toThrow('Invalid cron expression');
  });
});

describe('isValidCronExpression', () => {
  describe('valid expressions', () => {
    it('should return true for valid 5-field cron', () => {
      expect(isValidCronExpression('0 9 * * *')).toBe(true);
      expect(isValidCronExpression('*/15 * * * *')).toBe(true);
      expect(isValidCronExpression('0 9 * * 1-5')).toBe(true);
      expect(isValidCronExpression('0 9,12 * * *')).toBe(true);
    });

    it('should handle all wildcards', () => {
      expect(isValidCronExpression('* * * * *')).toBe(true);
    });

    it('should handle day of week 7 as Sunday', () => {
      expect(isValidCronExpression('0 9 * * 7')).toBe(true);
    });

    it('should handle boundary values', () => {
      expect(isValidCronExpression('59 23 31 12 6')).toBe(true);
      expect(isValidCronExpression('0 0 1 1 0')).toBe(true);
    });
  });

  describe('invalid expressions', () => {
    it('should return false for invalid cron', () => {
      expect(isValidCronExpression('invalid')).toBe(false);
      expect(isValidCronExpression('0 9 * *')).toBe(false); // Too few fields
      expect(isValidCronExpression('0 25 * * *')).toBe(false); // Invalid hour
      expect(isValidCronExpression('60 9 * * *')).toBe(false); // Invalid minute
    });

    it('should return false for empty string', () => {
      expect(isValidCronExpression('')).toBe(false);
    });

    it('should return false for null/undefined', () => {
      expect(isValidCronExpression(null as any)).toBe(false);
      expect(isValidCronExpression(undefined as any)).toBe(false);
    });

    it('should return false for out of range values', () => {
      expect(isValidCronExpression('0 9 32 * *')).toBe(false); // day > 31
      expect(isValidCronExpression('0 9 * 13 *')).toBe(false); // month > 12
      expect(isValidCronExpression('0 9 * * 8')).toBe(false); // day of week > 7
    });
  });
});
