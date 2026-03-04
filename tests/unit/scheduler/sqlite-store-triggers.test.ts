/**
 * Unit tests for KnexStoreBackend (sqlite) message trigger CRUD operations
 */
import { KnexStoreBackend } from '../../../src/scheduler/store/knex-store';
import type { MessageTrigger } from '../../../src/scheduler/store/types';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock logger
jest.mock('../../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('KnexStoreBackend (sqlite) — Message Triggers', () => {
  let backend: KnexStoreBackend;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-trigger-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    backend = new KnexStoreBackend('sqlite', {
      driver: 'sqlite',
      connection: { filename: dbPath },
    });
    await backend.initialize();
  });

  afterEach(async () => {
    await backend.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeTriggerInput(
    overrides: Partial<Omit<MessageTrigger, 'id' | 'createdAt'>> = {}
  ): Omit<MessageTrigger, 'id' | 'createdAt'> {
    return {
      creatorId: 'U123',
      creatorContext: 'slack:U123',
      creatorName: 'testuser',
      description: 'Test trigger',
      channels: ['C0CICD'],
      fromBots: false,
      contains: ['failed'],
      threads: 'any',
      workflow: 'handle-cicd',
      status: 'active',
      enabled: true,
      ...overrides,
    };
  }

  describe('createTrigger', () => {
    it('should create a trigger with all fields', async () => {
      const input = makeTriggerInput({
        fromUsers: ['U456'],
        matchPattern: 'error.*critical',
        inputs: { severity: 'high' },
        outputContext: { type: 'slack', target: 'C0ALERT' },
      });

      const trigger = await backend.createTrigger(input);

      expect(trigger.id).toBeDefined();
      expect(trigger.id.length).toBe(36); // UUID
      expect(trigger.createdAt).toBeGreaterThan(0);
      expect(trigger.creatorId).toBe('U123');
      expect(trigger.workflow).toBe('handle-cicd');
      expect(trigger.channels).toEqual(['C0CICD']);
      expect(trigger.fromUsers).toEqual(['U456']);
      expect(trigger.fromBots).toBe(false);
      expect(trigger.contains).toEqual(['failed']);
      expect(trigger.matchPattern).toBe('error.*critical');
      expect(trigger.threads).toBe('any');
      expect(trigger.inputs).toEqual({ severity: 'high' });
      expect(trigger.outputContext).toEqual({ type: 'slack', target: 'C0ALERT' });
      expect(trigger.status).toBe('active');
      expect(trigger.enabled).toBe(true);
    });

    it('should create a trigger with minimal fields', async () => {
      const input = makeTriggerInput({
        fromUsers: undefined,
        matchPattern: undefined,
        inputs: undefined,
        outputContext: undefined,
        description: undefined,
        creatorContext: undefined,
        creatorName: undefined,
      });

      const trigger = await backend.createTrigger(input);

      expect(trigger.id).toBeDefined();
      expect(trigger.fromUsers).toBeUndefined();
      expect(trigger.matchPattern).toBeUndefined();
      expect(trigger.inputs).toBeUndefined();
      expect(trigger.outputContext).toBeUndefined();
    });

    it('should assign unique IDs', async () => {
      const t1 = await backend.createTrigger(makeTriggerInput());
      const t2 = await backend.createTrigger(makeTriggerInput());

      expect(t1.id).not.toBe(t2.id);
    });
  });

  describe('getTrigger', () => {
    it('should retrieve a trigger by ID', async () => {
      const created = await backend.createTrigger(makeTriggerInput());
      const retrieved = await backend.getTrigger(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.workflow).toBe('handle-cicd');
      expect(retrieved!.channels).toEqual(['C0CICD']);
    });

    it('should return undefined for non-existent ID', async () => {
      const result = await backend.getTrigger('nonexistent-id');
      expect(result).toBeUndefined();
    });
  });

  describe('updateTrigger', () => {
    it('should update enabled field', async () => {
      const created = await backend.createTrigger(makeTriggerInput());
      const updated = await backend.updateTrigger(created.id, { enabled: false });

      expect(updated).toBeDefined();
      expect(updated!.enabled).toBe(false);
      expect(updated!.workflow).toBe('handle-cicd'); // unchanged
    });

    it('should update status field', async () => {
      const created = await backend.createTrigger(makeTriggerInput());
      const updated = await backend.updateTrigger(created.id, { status: 'paused' });

      expect(updated).toBeDefined();
      expect(updated!.status).toBe('paused');
    });

    it('should update contains and channels', async () => {
      const created = await backend.createTrigger(makeTriggerInput());
      const updated = await backend.updateTrigger(created.id, {
        contains: ['error', 'warning'],
        channels: ['C0CICD', 'CSEC'],
      });

      expect(updated).toBeDefined();
      expect(updated!.contains).toEqual(['error', 'warning']);
      expect(updated!.channels).toEqual(['C0CICD', 'CSEC']);
    });

    it('should not change id or createdAt', async () => {
      const created = await backend.createTrigger(makeTriggerInput());
      const updated = await backend.updateTrigger(created.id, {
        enabled: false,
      });

      expect(updated!.id).toBe(created.id);
      expect(updated!.createdAt).toBe(created.createdAt);
    });

    it('should return undefined for non-existent ID', async () => {
      const result = await backend.updateTrigger('nonexistent-id', { enabled: false });
      expect(result).toBeUndefined();
    });

    it('should persist updates', async () => {
      const created = await backend.createTrigger(makeTriggerInput());
      await backend.updateTrigger(created.id, { enabled: false });

      const retrieved = await backend.getTrigger(created.id);
      expect(retrieved!.enabled).toBe(false);
    });
  });

  describe('deleteTrigger', () => {
    it('should delete an existing trigger', async () => {
      const created = await backend.createTrigger(makeTriggerInput());
      const result = await backend.deleteTrigger(created.id);

      expect(result).toBe(true);

      const retrieved = await backend.getTrigger(created.id);
      expect(retrieved).toBeUndefined();
    });

    it('should return false for non-existent ID', async () => {
      const result = await backend.deleteTrigger('nonexistent-id');
      expect(result).toBe(false);
    });
  });

  describe('getTriggersByCreator', () => {
    it('should return triggers for a specific creator', async () => {
      await backend.createTrigger(makeTriggerInput({ creatorId: 'U123' }));
      await backend.createTrigger(makeTriggerInput({ creatorId: 'U123', workflow: 'other' }));
      await backend.createTrigger(makeTriggerInput({ creatorId: 'U456' }));

      const triggers = await backend.getTriggersByCreator('U123');

      expect(triggers).toHaveLength(2);
      expect(triggers.every(t => t.creatorId === 'U123')).toBe(true);
    });

    it('should return empty array when no triggers exist for creator', async () => {
      const triggers = await backend.getTriggersByCreator('U999');
      expect(triggers).toEqual([]);
    });
  });

  describe('getActiveTriggers', () => {
    it('should return only active and enabled triggers', async () => {
      await backend.createTrigger(makeTriggerInput({ workflow: 'active-enabled' }));
      await backend.createTrigger(
        makeTriggerInput({ workflow: 'active-disabled', enabled: false })
      );

      const paused = await backend.createTrigger(makeTriggerInput({ workflow: 'paused' }));
      await backend.updateTrigger(paused.id, { status: 'paused' });

      const triggers = await backend.getActiveTriggers();

      expect(triggers).toHaveLength(1);
      expect(triggers[0].workflow).toBe('active-enabled');
    });

    it('should return empty array when no active triggers exist', async () => {
      await backend.createTrigger(makeTriggerInput({ enabled: false }));

      const triggers = await backend.getActiveTriggers();
      expect(triggers).toEqual([]);
    });

    it('should return triggers from all creators', async () => {
      await backend.createTrigger(makeTriggerInput({ creatorId: 'U123' }));
      await backend.createTrigger(makeTriggerInput({ creatorId: 'U456' }));

      const triggers = await backend.getActiveTriggers();
      expect(triggers).toHaveLength(2);
    });
  });

  describe('JSON serialization', () => {
    it('should round-trip array fields correctly', async () => {
      const input = makeTriggerInput({
        channels: ['C1', 'C2', 'C3'],
        fromUsers: ['U1', 'U2'],
        contains: ['keyword1', 'keyword2', 'keyword3'],
      });

      const created = await backend.createTrigger(input);
      const retrieved = await backend.getTrigger(created.id);

      expect(retrieved!.channels).toEqual(['C1', 'C2', 'C3']);
      expect(retrieved!.fromUsers).toEqual(['U1', 'U2']);
      expect(retrieved!.contains).toEqual(['keyword1', 'keyword2', 'keyword3']);
    });

    it('should round-trip inputs object correctly', async () => {
      const input = makeTriggerInput({
        inputs: {
          severity: 'high',
          tags: ['security', 'ci'],
          nested: { key: 'value' },
        },
      });

      const created = await backend.createTrigger(input);
      const retrieved = await backend.getTrigger(created.id);

      expect(retrieved!.inputs).toEqual({
        severity: 'high',
        tags: ['security', 'ci'],
        nested: { key: 'value' },
      });
    });

    it('should round-trip outputContext correctly', async () => {
      const input = makeTriggerInput({
        outputContext: { type: 'slack', target: 'C0ALERT', threadId: '123.456' },
      });

      const created = await backend.createTrigger(input);
      const retrieved = await backend.getTrigger(created.id);

      expect(retrieved!.outputContext).toEqual({
        type: 'slack',
        target: 'C0ALERT',
        threadId: '123.456',
      });
    });

    it('should handle null/undefined JSON fields', async () => {
      const input = makeTriggerInput({
        channels: undefined,
        fromUsers: undefined,
        contains: undefined,
        inputs: undefined,
        outputContext: undefined,
      });

      const created = await backend.createTrigger(input);
      const retrieved = await backend.getTrigger(created.id);

      expect(retrieved!.channels).toBeUndefined();
      expect(retrieved!.fromUsers).toBeUndefined();
      expect(retrieved!.contains).toBeUndefined();
      expect(retrieved!.inputs).toBeUndefined();
      expect(retrieved!.outputContext).toBeUndefined();
    });
  });
});
