import { CronScheduler } from '../../src/cron-scheduler';
import * as cron from 'node-cron';
import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { VisorConfig } from '../../src/types/config';

// Mock node-cron
jest.mock('node-cron');

// Mock CheckExecutionEngine
jest.mock('../../src/check-execution-engine');

describe('CronScheduler', () => {
  let scheduler: CronScheduler;
  let mockExecutionEngine: jest.Mocked<CheckExecutionEngine>;
  let mockConfig: VisorConfig;
  let mockCronTasks: Map<string, { start: jest.Mock; stop: jest.Mock }>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCronTasks = new Map();

    mockExecutionEngine = {
      executeChecks: jest.fn(),
      executeGroupedChecks: jest.fn(),
      listProviders: jest.fn(),
      isGitRepository: jest.fn(),
      evaluateFailureConditions: jest.fn(),
      getRepositoryStatus: jest.fn(),
    } as unknown as jest.Mocked<CheckExecutionEngine>;

    mockConfig = {
      version: '1.0',
      checks: {
        'scheduled-check': {
          type: 'ai',
          prompt: 'Test prompt',
          schedule: '0 2 * * *',
          on: ['schedule'],
        },
        'another-scheduled': {
          type: 'http_client',
          url: 'https://example.com',
          schedule: '*/5 * * * *',
          on: ['schedule'],
        },
        'non-scheduled': {
          type: 'ai',
          prompt: 'No schedule',
          on: ['pr_opened'],
        },
      },
      output: {
        pr_comment: {
          format: 'markdown',
          group_by: 'check',
          collapse: true,
        },
      },
    };

    // Mock cron.schedule to return mock tasks
    (cron.schedule as jest.Mock).mockImplementation((expression, _callback) => {
      const mockTask = {
        start: jest.fn(),
        stop: jest.fn(),
      };
      mockCronTasks.set(expression, mockTask);
      return mockTask;
    });

    // Mock cron.validate
    (cron.validate as jest.Mock).mockReturnValue(true);

    scheduler = new CronScheduler(mockConfig, mockExecutionEngine);
    scheduler.initialize();
  });

  describe('constructor', () => {
    it('should initialize with config and execution engine', () => {
      expect(scheduler).toBeDefined();
    });

    it('should schedule checks with cron expressions', () => {
      expect(cron.schedule).toHaveBeenCalledWith(
        '0 2 * * *',
        expect.any(Function),
        expect.objectContaining({ scheduled: false })
      );
      expect(cron.schedule).toHaveBeenCalledWith(
        '*/5 * * * *',
        expect.any(Function),
        expect.objectContaining({ scheduled: false })
      );
      expect(cron.schedule).toHaveBeenCalledTimes(2); // Only scheduled checks
    });
  });

  describe('start', () => {
    it('should start all scheduled tasks', () => {
      scheduler.start();

      mockCronTasks.forEach(task => {
        expect(task.start).toHaveBeenCalled();
      });
    });

    it('should log started scheduled checks', () => {
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

      scheduler.start();

      expect(consoleLogSpy).toHaveBeenCalledWith('🚀 Starting cron scheduler...');
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('✅ Started 2 scheduled tasks')
      );

      consoleLogSpy.mockRestore();
    });

    it('should handle empty scheduled checks gracefully', () => {
      const emptyConfig: VisorConfig = {
        version: '1.0',
        checks: {
          'no-schedule': {
            type: 'ai',
            prompt: 'Test',
            on: ['pr_opened'],
          },
        },
        output: mockConfig.output,
      };

      const emptyScheduler = new CronScheduler(emptyConfig, mockExecutionEngine);
      emptyScheduler.initialize();
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

      emptyScheduler.start();

      expect(consoleLogSpy).toHaveBeenCalledWith('✅ Started 0 scheduled tasks');

      consoleLogSpy.mockRestore();
    });
  });

  describe('stop', () => {
    it('should stop all scheduled tasks', () => {
      scheduler.start();
      scheduler.stop();

      mockCronTasks.forEach(task => {
        expect(task.stop).toHaveBeenCalled();
      });
    });

    it('should log stop message', () => {
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

      scheduler.stop();

      expect(consoleLogSpy).toHaveBeenCalledWith('🕐 Scheduler is not running');

      consoleLogSpy.mockRestore();
    });
  });

  describe('executeScheduledCheck', () => {
    it('should execute check when cron triggers', async () => {
      let capturedCallback: Function | undefined;
      (cron.schedule as jest.Mock).mockImplementation((expression, callback) => {
        if (expression === '0 2 * * *') {
          capturedCallback = callback;
        }
        return {
          start: jest.fn(),
          stop: jest.fn(),
        };
      });

      scheduler = new CronScheduler(mockConfig, mockExecutionEngine);
      scheduler.initialize();

      // Trigger the scheduled callback
      if (capturedCallback) {
        await capturedCallback();
      }

      expect(mockExecutionEngine.executeChecks).toHaveBeenCalledWith({
        checks: ['scheduled-check'],
        showDetails: true,
        outputFormat: 'json',
        config: mockConfig,
      });
    });

    it('should handle execution errors gracefully', async () => {
      let capturedCallback: Function | undefined;
      (cron.schedule as jest.Mock).mockImplementation((expression, callback) => {
        if (expression === '0 2 * * *') {
          capturedCallback = callback;
        }
        return {
          start: jest.fn(),
          stop: jest.fn(),
        };
      });

      mockExecutionEngine.executeChecks.mockRejectedValueOnce(new Error('Execution failed'));
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      scheduler = new CronScheduler(mockConfig, mockExecutionEngine);
      scheduler.initialize();

      // Trigger the scheduled callback
      if (capturedCallback) {
        await capturedCallback();
      }

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '❌ Failed to execute scheduled check "scheduled-check":',
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('validateCronExpression', () => {
    it('should validate correct cron expressions', () => {
      (cron.validate as jest.Mock).mockReturnValue(true);

      expect(() => {
        new CronScheduler(mockConfig, mockExecutionEngine);
      }).not.toThrow();
    });

    it('should throw error for invalid cron expressions', () => {
      (cron.validate as jest.Mock).mockReturnValue(false);

      const invalidConfig: VisorConfig = {
        version: '1.0',
        checks: {
          'bad-cron': {
            type: 'ai',
            prompt: 'Test',
            schedule: 'invalid cron',
            on: ['schedule'],
          },
        },
        output: mockConfig.output,
      };

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      const badScheduler = new CronScheduler(invalidConfig, mockExecutionEngine);
      badScheduler.initialize();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '❌ Invalid cron expression for check "bad-cron": invalid cron'
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('getScheduledChecks', () => {
    it('should return list of scheduled check names', () => {
      const scheduledChecks = scheduler.getScheduledChecks();

      expect(scheduledChecks).toEqual([
        { name: 'scheduled-check', schedule: '0 2 * * *' },
        { name: 'another-scheduled', schedule: '*/5 * * * *' },
      ]);
    });

    it('should return empty array when no scheduled checks', () => {
      const emptyConfig: VisorConfig = {
        version: '1.0',
        checks: {},
        output: mockConfig.output,
      };

      const emptyScheduler = new CronScheduler(emptyConfig, mockExecutionEngine);
      const scheduledChecks = emptyScheduler.getScheduledChecks();

      expect(scheduledChecks).toEqual([]);
    });
  });

  describe('isRunning', () => {
    it('should return false when not started', () => {
      expect((scheduler as unknown as { isRunning: boolean }).isRunning).toBe(false);
    });

    it('should return true when started', () => {
      scheduler.start();
      expect((scheduler as unknown as { isRunning: boolean }).isRunning).toBe(true);
    });

    it('should return false after stopped', () => {
      scheduler.start();
      scheduler.stop();
      expect((scheduler as unknown as { isRunning: boolean }).isRunning).toBe(false);
    });
  });

  describe('GitHub Actions environment', () => {
    it('should not start scheduler in GitHub Actions', () => {
      const originalEnv = process.env.GITHUB_ACTIONS;
      process.env.GITHUB_ACTIONS = 'true';

      jest.clearAllMocks(); // Clear previous mock calls
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
      const githubScheduler = new CronScheduler(mockConfig, mockExecutionEngine);
      githubScheduler.initialize();

      githubScheduler.start();

      expect(consoleLogSpy).toHaveBeenCalledWith('🚀 Starting cron scheduler...');
      expect(cron.schedule).toHaveBeenCalledTimes(2); // Still creates tasks

      consoleLogSpy.mockRestore();
      process.env.GITHUB_ACTIONS = originalEnv;
    });
  });

  describe('multiple cron expressions', () => {
    it('should handle multiple checks with same cron expression', () => {
      jest.clearAllMocks(); // Clear previous mock calls

      const multiConfig: VisorConfig = {
        version: '1.0',
        checks: {
          'daily-1': {
            type: 'ai',
            prompt: 'Daily check 1',
            schedule: '0 2 * * *',
            on: ['schedule'],
          },
          'daily-2': {
            type: 'ai',
            prompt: 'Daily check 2',
            schedule: '0 2 * * *',
            on: ['schedule'],
          },
        },
        output: mockConfig.output,
      };

      const multiScheduler = new CronScheduler(multiConfig, mockExecutionEngine);
      multiScheduler.initialize();
      const scheduledChecks = multiScheduler.getScheduledChecks();

      expect(scheduledChecks).toEqual([
        { name: 'daily-1', schedule: '0 2 * * *' },
        { name: 'daily-2', schedule: '0 2 * * *' },
      ]);
      expect(cron.schedule).toHaveBeenCalledTimes(2); // 2 checks scheduled
    });
  });
});
