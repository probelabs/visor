/**
 * Schedule parsing utilities
 * Note: Natural language parsing is handled by the AI which generates
 * cron expressions or ISO timestamps directly. This module provides
 * validation and helper functions.
 */
/**
 * Parsed schedule result
 */
export interface ParsedSchedule {
    type: 'one-time' | 'recurring';
    cronExpression?: string;
    runAt?: Date;
    timezone: string;
    description: string;
}
/**
 * Parse a natural language schedule expression
 *
 * @param expression Natural language time expression (e.g., "every Monday at 9am", "in 2 hours")
 * @param userTimezone IANA timezone string (e.g., "America/New_York")
 * @param referenceDate Optional reference date for parsing (defaults to now)
 * @returns Parsed schedule information
 */
export declare function parseScheduleExpression(expression: string, userTimezone?: string, _referenceDate?: Date): ParsedSchedule;
/**
 * Calculate the next run time for a cron expression
 */
export declare function getNextRunTime(cronExpression: string, _timezone?: string): Date;
/**
 * Validate a cron expression
 */
export declare function isValidCronExpression(expr: string): boolean;
//# sourceMappingURL=schedule-parser.d.ts.map