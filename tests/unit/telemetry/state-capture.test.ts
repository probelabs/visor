import { describe, it, expect, jest } from '@jest/globals';
import { Span, SpanStatusCode } from '@opentelemetry/api';
import {
  captureCheckInputContext,
  captureCheckOutput,
  captureForEachState,
  captureLiquidEvaluation,
  captureTransformJS,
  captureProviderCall,
  captureConditionalEvaluation,
  captureRoutingDecision,
  captureStateSnapshot,
} from '../../../src/telemetry/state-capture';

describe('State Capture', () => {
  let mockSpan: jest.Mocked<Span>;

  beforeEach(() => {
    mockSpan = {
      setAttribute: jest.fn(),
      addEvent: jest.fn(),
      setStatus: jest.fn(),
      spanContext: jest.fn(),
      isRecording: jest.fn().mockReturnValue(true),
      recordException: jest.fn(),
      updateName: jest.fn(),
      end: jest.fn(),
      setAttributes: jest.fn(),
    } as any;
  });

  describe('captureCheckInputContext', () => {
    it('should capture full context with all keys', () => {
      const context = {
        pr: { number: 123, title: 'Test PR' },
        outputs: { 'check-1': { result: 'ok' } },
        env: { NODE_ENV: 'test' },
      };

      captureCheckInputContext(mockSpan, context);

      expect(mockSpan.setAttribute).toHaveBeenCalledWith('visor.check.input.keys', 'pr,outputs,env');
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('visor.check.input.count', 3);
      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'visor.check.input.context',
        expect.stringContaining('"pr"')
      );
    });

    it('should capture PR object separately', () => {
      const context = {
        pr: { number: 456, title: 'Another PR', author: 'alice' },
        outputs: {},
        env: {},
      };

      captureCheckInputContext(mockSpan, context);

      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'visor.check.input.pr',
        expect.stringContaining('"number":456')
      );
    });

    it('should handle errors gracefully', () => {
      const context = { circular: {} as any };
      context.circular.self = context.circular;

      captureCheckInputContext(mockSpan, context);

      // Should not throw, and should set an attribute
      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'visor.check.input.context',
        expect.stringContaining('[Circular]')
      );
    });
  });

  describe('captureCheckOutput', () => {
    it('should capture array output with length', () => {
      const output = [{ id: 1 }, { id: 2 }, { id: 3 }];

      captureCheckOutput(mockSpan, output);

      expect(mockSpan.setAttribute).toHaveBeenCalledWith('visor.check.output.type', 'object');
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('visor.check.output.length', 3);
      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'visor.check.output.preview',
        expect.stringContaining('[{')
      );
    });

    it('should capture string output', () => {
      const output = 'simple string result';

      captureCheckOutput(mockSpan, output);

      expect(mockSpan.setAttribute).toHaveBeenCalledWith('visor.check.output.type', 'string');
      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'visor.check.output',
        JSON.stringify(output)
      );
    });

    it('should capture object output', () => {
      const output = { status: 'success', count: 42 };

      captureCheckOutput(mockSpan, output);

      expect(mockSpan.setAttribute).toHaveBeenCalledWith('visor.check.output.type', 'object');
      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'visor.check.output',
        JSON.stringify(output)
      );
    });
  });

  describe('captureForEachState', () => {
    it('should capture iteration details', () => {
      const items = ['item1', 'item2', 'item3'];
      const index = 1;
      const current = 'item2';

      captureForEachState(mockSpan, items, index, current);

      expect(mockSpan.setAttribute).toHaveBeenCalledWith('visor.foreach.total', 3);
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('visor.foreach.index', 1);
      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'visor.foreach.current_item',
        '"item2"'
      );
      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'visor.foreach.items',
        JSON.stringify(items)
      );
    });

    it('should truncate large arrays', () => {
      const items = Array.from({ length: 200 }, (_, i) => `item${i}`);
      const index = 0;

      captureForEachState(mockSpan, items, index, items[0]);

      expect(mockSpan.setAttribute).toHaveBeenCalledWith('visor.foreach.total', 200);
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('visor.foreach.items.truncated', true);
      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'visor.foreach.items.preview',
        expect.any(String)
      );
    });
  });

  describe('captureTransformJS', () => {
    it('should capture transform code and results', () => {
      const code = 'output.map(x => x * 2)';
      const input = [1, 2, 3];
      const output = [2, 4, 6];

      captureTransformJS(mockSpan, code, input, output);

      expect(mockSpan.setAttribute).toHaveBeenCalledWith('visor.transform.code', code);
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('visor.transform.code.length', code.length);
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('visor.transform.input', JSON.stringify(input));
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('visor.transform.output', JSON.stringify(output));
    });

    it('should truncate long code', () => {
      const longCode = 'x'.repeat(3000);
      captureTransformJS(mockSpan, longCode, {}, {});

      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        'visor.transform.code',
        expect.stringContaining('...[truncated]')
      );
    });
  });

  describe('captureStateSnapshot', () => {
    it('should emit snapshot event with full state', () => {
      const outputs = { 'check-1': { result: 'ok' }, 'check-2': { result: 'fail' } };
      const memory = { key1: 'value1', key2: 'value2' };

      captureStateSnapshot(mockSpan, 'check-3', outputs, memory);

      expect(mockSpan.addEvent).toHaveBeenCalledWith('state.snapshot', {
        'visor.snapshot.check_id': 'check-3',
        'visor.snapshot.outputs': JSON.stringify(outputs),
        'visor.snapshot.memory': JSON.stringify(memory),
        'visor.snapshot.timestamp': expect.any(String),
      });
    });
  });

  describe('Error handling', () => {
    it('should handle setAttribute errors gracefully', () => {
      mockSpan.setAttribute.mockImplementation(() => {
        throw new Error('Span error');
      });

      // Should not throw
      expect(() => {
        captureCheckInputContext(mockSpan, { test: 'value' });
      }).not.toThrow();

      expect(() => {
        captureCheckOutput(mockSpan, 'output');
      }).not.toThrow();
    });

    it('should handle addEvent errors gracefully', () => {
      mockSpan.addEvent.mockImplementation(() => {
        throw new Error('Event error');
      });

      // Should not throw
      expect(() => {
        captureStateSnapshot(mockSpan, 'test', {}, {});
      }).not.toThrow();
    });
  });
});
