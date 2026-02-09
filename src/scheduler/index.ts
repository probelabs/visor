/**
 * Scheduler module public exports
 *
 * This module provides a generic, frontend-agnostic scheduler for executing
 * workflows at specified times. It supports both:
 * - Static schedules defined in YAML configuration
 * - Dynamic schedules created via AI tool at runtime
 */

// Schedule store
export {
  ScheduleStore,
  Schedule,
  ScheduleOutputContext,
  ScheduleStoreConfig,
  ScheduleLimits,
} from './schedule-store';

// Store backends
export type {
  ScheduleStoreBackend,
  ScheduleStoreStats,
  StorageConfig,
  HAConfig,
} from './store/types';

export { createStoreBackend } from './store/index';

// Schedule parser
export {
  parseScheduleExpression,
  getNextRunTime,
  isValidCronExpression,
  ParsedSchedule,
} from './schedule-parser';

// Scheduler daemon
export {
  Scheduler,
  SchedulerConfig,
  ScheduleOutputAdapter,
  ScheduleExecutionResult,
  getScheduler,
  resetScheduler,
} from './scheduler';

// Schedule tool (for AI providers)
export {
  handleScheduleAction,
  getScheduleToolDefinition,
  isScheduleTool,
  buildScheduleToolContext,
  ScheduleToolArgs,
  ScheduleToolContext,
  ScheduleToolResult,
  ScheduleAction,
  ScheduleType,
  SchedulePermissions,
} from './schedule-tool';

// CLI handler
export { handleScheduleCommand } from './cli-handler';
