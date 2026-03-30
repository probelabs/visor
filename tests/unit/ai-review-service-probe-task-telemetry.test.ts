jest.mock('../../src/telemetry/lazy-otel', () => ({
  trace: {
    getTracer: jest.fn(),
    getActiveSpan: jest.fn(),
  },
}));

jest.mock('../../src/telemetry/fallback-ndjson', () => ({
  emitNdjsonFullSpan: jest.fn(),
}));

import { createProbeTracerAdapter } from '../../src/ai-review-service';
import { trace as otTrace } from '../../src/telemetry/lazy-otel';
import { emitNdjsonFullSpan } from '../../src/telemetry/fallback-ndjson';

describe('createProbeTracerAdapter task telemetry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('promotes task events to probe.event spans and active span events', () => {
    const end = jest.fn();
    const startSpan = jest.fn().mockReturnValue({
      end,
      spanContext: () => ({ traceId: 'trace-1', spanId: 'child-1' }),
    });
    const addEvent = jest.fn();
    const activeSpan = {
      addEvent,
      spanContext: () => ({ traceId: 'trace-1', spanId: 'parent-1' }),
    };
    const fallback = { recordTaskEvent: jest.fn() };

    (otTrace.getTracer as jest.Mock).mockReturnValue({ startSpan });
    (otTrace.getActiveSpan as jest.Mock).mockReturnValue(activeSpan);

    const tracer = createProbeTracerAdapter(fallback);
    tracer.recordTaskEvent('completed', {
      'task.id': 'task-1',
      'task.title': 'Investigate timeout failure',
    });

    expect(startSpan).toHaveBeenCalledWith('probe.event.task.completed', {
      attributes: {
        'probe.event.name': 'task.completed',
        'task.id': 'task-1',
        'task.title': 'Investigate timeout failure',
      },
    });
    expect(end).toHaveBeenCalled();
    expect(addEvent).toHaveBeenCalledWith('task.completed', {
      'task.id': 'task-1',
      'task.title': 'Investigate timeout failure',
    });
    expect(emitNdjsonFullSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'probe.event.task.completed',
        traceId: 'trace-1',
        spanId: 'child-1',
        parentSpanId: 'parent-1',
        attributes: {
          'probe.event.name': 'task.completed',
          'task.id': 'task-1',
          'task.title': 'Investigate timeout failure',
        },
      })
    );
    expect(fallback.recordTaskEvent).toHaveBeenCalledWith('completed', {
      'task.id': 'task-1',
      'task.title': 'Investigate timeout failure',
    });
  });
});
