import { logger } from '../../src/logger';

describe('logger sink error handling', () => {
  afterEach(() => {
    logger.setSink(undefined);
  });

  it('throws when sink error mode is throw', () => {
    logger.setSink(
      () => {
        throw new Error('sink failure');
      },
      { passthrough: true, errorMode: 'throw' }
    );

    expect(() => logger.info('hello')).toThrow('sink failure');
  });

  it('warns and continues when sink error mode is warn', () => {
    const writes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);

    // Capture stderr writes for assertion
    (process.stderr.write as unknown as (chunk: string | Uint8Array) => boolean) = (
      chunk: string | Uint8Array
    ) => {
      writes.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      return true;
    };

    try {
      logger.setSink(
        () => {
          throw new Error('sink warn');
        },
        { passthrough: true, errorMode: 'warn' }
      );

      expect(() => logger.info('hello')).not.toThrow();
      expect(writes.join('')).toContain('sink failed');
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});
