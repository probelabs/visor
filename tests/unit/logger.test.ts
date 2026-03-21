import { logger } from '../../src/logger';

describe('logger task context', () => {
  afterEach(() => {
    logger.setSink(undefined);
    logger.configure({ level: 'info' });
  });

  it('appends task_id to log messages inside task context', async () => {
    const sink = jest.fn();
    logger.configure({ level: 'info' });
    logger.setSink(sink, { passthrough: false });

    await logger.withTaskContext('task-abc', async () => {
      logger.info('hello');
    });

    expect(sink).toHaveBeenCalledWith('hello [task_id=task-abc]', 'info');
  });
});
