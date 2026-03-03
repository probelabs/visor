/**
 * Enterprise tests for KnexStoreBackend — message trigger CRUD
 *
 * Since Knex requires a real database connection, we mock the Knex query builder
 * to verify the backend builds correct queries and converts rows properly.
 */

// Mock logger
jest.mock('../../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock uuid to return predictable IDs
let uuidCounter = 0;
jest.mock('uuid', () => ({
  v4: () => `test-uuid-${++uuidCounter}`,
}));

import type { MessageTrigger } from '../../../src/scheduler/store/types';

// -------------------------------------------------------------------
// Build a minimal mock Knex query builder
// -------------------------------------------------------------------
function createMockQueryBuilder(rows: Record<string, unknown>[] = []) {
  const qb: any = {};
  // Chainable methods
  for (const method of ['where', 'andWhere', 'select', 'orderBy']) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  // Terminal methods
  qb.insert = jest.fn().mockResolvedValue([1]);
  qb.update = jest.fn().mockResolvedValue(1);
  qb.del = jest.fn().mockResolvedValue(1);
  qb.first = jest.fn().mockResolvedValue(rows[0] ?? undefined);
  // When used as iterable (getActiveTriggers returns rows directly)
  qb.then = (resolve: (v: any) => void) => resolve(rows);
  return qb;
}

function createMockKnex(queryBuilders: Record<string, any> = {}) {
  const knexFn: any = (table: string) => {
    return queryBuilders[table] || createMockQueryBuilder();
  };
  knexFn.schema = {
    hasTable: jest.fn().mockResolvedValue(true), // Tables already exist
    createTable: jest.fn().mockResolvedValue(undefined),
  };
  knexFn.destroy = jest.fn().mockResolvedValue(undefined);
  return knexFn;
}

// We can't easily test the actual KnexStoreBackend.initialize() since it
// dynamically loads knex. Instead, test the CRUD methods by injecting a mock
// knex instance via reflection.
function createBackendWithMockKnex(driver: 'postgresql' | 'mysql' | 'mssql', mockKnex: any) {
  // Import the class directly (constructor doesn't need knex)
  const { KnexStoreBackend } = require('../../../src/enterprise/scheduler/knex-store');
  const backend = new KnexStoreBackend(driver, { driver, connection: {} });
  // Inject mock knex (bypassing initialize)
  (backend as any).knex = mockKnex;
  return backend;
}

// Sample DB row in snake_case (as Knex returns from the database)
function makeTriggerRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'existing-id',
    creator_id: 'U123',
    creator_context: 'slack:U123',
    creator_name: 'testuser',
    description: 'Test trigger',
    channels: JSON.stringify(['C0CICD']),
    from_users: JSON.stringify(['U456']),
    from_bots: false,
    contains: JSON.stringify(['failed']),
    match_pattern: 'error.*critical',
    threads: 'any',
    workflow: 'handle-cicd',
    inputs: JSON.stringify({ severity: 'high' }),
    output_context: JSON.stringify({ type: 'slack', target: 'C0ALERT' }),
    status: 'active',
    enabled: true,
    created_at: 1700000000000,
    ...overrides,
  };
}

describe('KnexStoreBackend — Message Trigger CRUD', () => {
  beforeEach(() => {
    uuidCounter = 0;
    jest.clearAllMocks();
  });

  describe('createTrigger', () => {
    it('should insert a row and return a MessageTrigger with generated id and createdAt', async () => {
      const triggersQb = createMockQueryBuilder();
      const mockKnex = createMockKnex({ message_triggers: triggersQb });
      const backend = createBackendWithMockKnex('postgresql', mockKnex);

      const result: MessageTrigger = await backend.createTrigger({
        creatorId: 'U123',
        creatorContext: 'slack:U123',
        creatorName: 'testuser',
        description: 'Watch CI',
        channels: ['C0CICD'],
        fromBots: false,
        contains: ['failed'],
        threads: 'any' as const,
        workflow: 'handle-cicd',
        status: 'active' as const,
        enabled: true,
      });

      expect(result.id).toBe('test-uuid-1');
      expect(result.createdAt).toBeGreaterThan(0);
      expect(result.creatorId).toBe('U123');
      expect(result.workflow).toBe('handle-cicd');

      // Verify insert was called with snake_case row
      expect(triggersQb.insert).toHaveBeenCalledTimes(1);
      const insertedRow = triggersQb.insert.mock.calls[0][0];
      expect(insertedRow.id).toBe('test-uuid-1');
      expect(insertedRow.creator_id).toBe('U123');
      expect(insertedRow.channels).toBe(JSON.stringify(['C0CICD']));
      expect(insertedRow.workflow).toBe('handle-cicd');
    });

    it('should serialize JSON fields as strings', async () => {
      const triggersQb = createMockQueryBuilder();
      const mockKnex = createMockKnex({ message_triggers: triggersQb });
      const backend = createBackendWithMockKnex('postgresql', mockKnex);

      await backend.createTrigger({
        creatorId: 'U123',
        fromBots: false,
        contains: ['error', 'warning'],
        threads: 'root_only' as const,
        workflow: 'alert',
        inputs: { tags: ['ci', 'prod'] },
        outputContext: { type: 'slack', target: 'C0ALERT', threadId: '123.456' },
        status: 'active' as const,
        enabled: true,
      });

      const row = triggersQb.insert.mock.calls[0][0];
      expect(row.contains).toBe(JSON.stringify(['error', 'warning']));
      expect(row.inputs).toBe(JSON.stringify({ tags: ['ci', 'prod'] }));
      expect(row.output_context).toBe(
        JSON.stringify({ type: 'slack', target: 'C0ALERT', threadId: '123.456' })
      );
    });

    it('should set null for undefined optional fields', async () => {
      const triggersQb = createMockQueryBuilder();
      const mockKnex = createMockKnex({ message_triggers: triggersQb });
      const backend = createBackendWithMockKnex('postgresql', mockKnex);

      await backend.createTrigger({
        creatorId: 'U123',
        fromBots: false,
        threads: 'any' as const,
        workflow: 'handle-cicd',
        status: 'active' as const,
        enabled: true,
      });

      const row = triggersQb.insert.mock.calls[0][0];
      expect(row.channels).toBeNull();
      expect(row.from_users).toBeNull();
      expect(row.match_pattern).toBeNull();
      expect(row.inputs).toBeNull();
      expect(row.output_context).toBeNull();
      expect(row.description).toBeNull();
    });
  });

  describe('getTrigger', () => {
    it('should retrieve and convert a row to MessageTrigger', async () => {
      const row = makeTriggerRow();
      const triggersQb = createMockQueryBuilder([row]);
      const mockKnex = createMockKnex({ message_triggers: triggersQb });
      const backend = createBackendWithMockKnex('postgresql', mockKnex);

      const result = await backend.getTrigger('existing-id');

      expect(result).toBeDefined();
      expect(result!.id).toBe('existing-id');
      expect(result!.creatorId).toBe('U123');
      expect(result!.channels).toEqual(['C0CICD']);
      expect(result!.fromUsers).toEqual(['U456']);
      expect(result!.fromBots).toBe(false);
      expect(result!.contains).toEqual(['failed']);
      expect(result!.matchPattern).toBe('error.*critical');
      expect(result!.inputs).toEqual({ severity: 'high' });
      expect(result!.outputContext).toEqual({ type: 'slack', target: 'C0ALERT' });
      expect(result!.createdAt).toBe(1700000000000);
    });

    it('should return undefined when row not found', async () => {
      const triggersQb = createMockQueryBuilder();
      triggersQb.first = jest.fn().mockResolvedValue(undefined);
      const mockKnex = createMockKnex({ message_triggers: triggersQb });
      const backend = createBackendWithMockKnex('postgresql', mockKnex);

      const result = await backend.getTrigger('nonexistent');
      expect(result).toBeUndefined();
    });

    it('should handle MSSQL numeric booleans (1/0)', async () => {
      const row = makeTriggerRow({ from_bots: 1, enabled: 0 });
      const triggersQb = createMockQueryBuilder([row]);
      const mockKnex = createMockKnex({ message_triggers: triggersQb });
      const backend = createBackendWithMockKnex('mssql', mockKnex);

      const result = await backend.getTrigger('existing-id');

      expect(result!.fromBots).toBe(true);
      expect(result!.enabled).toBe(false);
    });

    it('should handle null JSON fields gracefully', async () => {
      const row = makeTriggerRow({
        channels: null,
        from_users: null,
        contains: null,
        inputs: null,
        output_context: null,
        match_pattern: null,
        description: null,
        creator_context: null,
        creator_name: null,
      });
      const triggersQb = createMockQueryBuilder([row]);
      const mockKnex = createMockKnex({ message_triggers: triggersQb });
      const backend = createBackendWithMockKnex('postgresql', mockKnex);

      const result = await backend.getTrigger('existing-id');

      expect(result!.channels).toBeUndefined();
      expect(result!.fromUsers).toBeUndefined();
      expect(result!.contains).toBeUndefined();
      expect(result!.inputs).toBeUndefined();
      expect(result!.outputContext).toBeUndefined();
      expect(result!.matchPattern).toBeUndefined();
      expect(result!.description).toBeUndefined();
    });
  });

  describe('updateTrigger', () => {
    it('should update fields and return the merged trigger', async () => {
      const row = makeTriggerRow();
      const triggersQb = createMockQueryBuilder([row]);
      const mockKnex = createMockKnex({ message_triggers: triggersQb });
      const backend = createBackendWithMockKnex('postgresql', mockKnex);

      const result = await backend.updateTrigger('existing-id', { enabled: false });

      expect(result).toBeDefined();
      expect(result!.enabled).toBe(false);
      expect(result!.id).toBe('existing-id'); // Preserved
      expect(result!.createdAt).toBe(1700000000000); // Preserved
      expect(triggersQb.update).toHaveBeenCalledTimes(1);
    });

    it('should return undefined when trigger not found', async () => {
      const triggersQb = createMockQueryBuilder();
      triggersQb.first = jest.fn().mockResolvedValue(undefined);
      const mockKnex = createMockKnex({ message_triggers: triggersQb });
      const backend = createBackendWithMockKnex('postgresql', mockKnex);

      const result = await backend.updateTrigger('nonexistent', { enabled: false });
      expect(result).toBeUndefined();
      expect(triggersQb.update).not.toHaveBeenCalled();
    });

    it('should not include id in the update payload', async () => {
      const row = makeTriggerRow();
      const triggersQb = createMockQueryBuilder([row]);
      const mockKnex = createMockKnex({ message_triggers: triggersQb });
      const backend = createBackendWithMockKnex('postgresql', mockKnex);

      await backend.updateTrigger('existing-id', { status: 'paused' as const });

      const updatePayload = triggersQb.update.mock.calls[0][0];
      expect(updatePayload.id).toBeUndefined();
    });
  });

  describe('deleteTrigger', () => {
    it('should delete and return true when trigger exists', async () => {
      const triggersQb = createMockQueryBuilder();
      triggersQb.del = jest.fn().mockResolvedValue(1);
      const mockKnex = createMockKnex({ message_triggers: triggersQb });
      const backend = createBackendWithMockKnex('postgresql', mockKnex);

      const result = await backend.deleteTrigger('existing-id');

      expect(result).toBe(true);
      expect(triggersQb.where).toHaveBeenCalledWith('id', 'existing-id');
    });

    it('should return false when trigger not found', async () => {
      const triggersQb = createMockQueryBuilder();
      triggersQb.del = jest.fn().mockResolvedValue(0);
      const mockKnex = createMockKnex({ message_triggers: triggersQb });
      const backend = createBackendWithMockKnex('postgresql', mockKnex);

      const result = await backend.deleteTrigger('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('getTriggersByCreator', () => {
    it('should query by creator_id and return converted triggers', async () => {
      const rows = [
        makeTriggerRow({ id: 't1', workflow: 'workflow-a' }),
        makeTriggerRow({ id: 't2', workflow: 'workflow-b' }),
      ];
      const triggersQb = createMockQueryBuilder(rows);
      const mockKnex = createMockKnex({ message_triggers: triggersQb });
      const backend = createBackendWithMockKnex('postgresql', mockKnex);

      const result = await backend.getTriggersByCreator('U123');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('t1');
      expect(result[1].id).toBe('t2');
      expect(triggersQb.where).toHaveBeenCalledWith('creator_id', 'U123');
    });
  });

  describe('getActiveTriggers', () => {
    it('should query with status=active and enabled=true for PostgreSQL', async () => {
      const rows = [makeTriggerRow()];
      const triggersQb = createMockQueryBuilder(rows);
      const mockKnex = createMockKnex({ message_triggers: triggersQb });
      const backend = createBackendWithMockKnex('postgresql', mockKnex);

      const result = await backend.getActiveTriggers();

      expect(result).toHaveLength(1);
      expect(triggersQb.where).toHaveBeenCalledWith('status', 'active');
      expect(triggersQb.where).toHaveBeenCalledWith('enabled', true);
    });

    it('should use numeric 1 for enabled filter on MSSQL', async () => {
      const rows = [makeTriggerRow({ from_bots: 0, enabled: 1 })];
      const triggersQb = createMockQueryBuilder(rows);
      const mockKnex = createMockKnex({ message_triggers: triggersQb });
      const backend = createBackendWithMockKnex('mssql', mockKnex);

      await backend.getActiveTriggers();

      expect(triggersQb.where).toHaveBeenCalledWith('status', 'active');
      expect(triggersQb.where).toHaveBeenCalledWith('enabled', 1);
    });
  });
});
