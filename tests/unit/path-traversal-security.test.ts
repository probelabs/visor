import { AIReviewService } from '../../src/ai-review-service';

// Mock the filesystem operations
jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
  },
}));

describe('Path Traversal Security Tests', () => {
  let aiService: AIReviewService;
  let mockReadFile: jest.Mock;

  beforeEach(() => {
    // Set up AI service without any provider (won't be making actual AI calls)
    aiService = new AIReviewService({
      debug: false,
    });

    // Get the mocked readFile function
    const fs = require('fs');
    mockReadFile = fs.promises.readFile as jest.Mock;
    mockReadFile.mockClear();
  });

  describe('loadSchemaContent path traversal protection', () => {
    test('should reject path traversal attempts with ../', async () => {
      // Attempt path traversal with ../
      const maliciousSchemaName = '../../../etc/passwd';

      await expect(
        // Access the private method using bracket notation for testing
        (aiService as any).loadSchemaContent(maliciousSchemaName)
      ).rejects.toThrow('Invalid schema name');

      // Ensure no file system access was attempted
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    test('should reject path traversal attempts with absolute paths', async () => {
      // Attempt absolute path traversal
      const maliciousSchemaName = '/etc/passwd';

      await expect((aiService as any).loadSchemaContent(maliciousSchemaName)).rejects.toThrow(
        'Invalid schema name'
      );

      expect(mockReadFile).not.toHaveBeenCalled();
    });

    test('should reject schema names with special characters', async () => {
      const maliciousSchemaNames = [
        'schema\x00name', // Null byte injection
        'schema;rm -rf /', // Command injection attempt
        'schema|cat /etc/passwd', // Pipe injection
        'schema$(cat /etc/passwd)', // Command substitution
        'schema`cat /etc/passwd`', // Backtick command substitution
        'schema\ncat /etc/passwd', // Newline injection
        'schema\r\ncat /etc/passwd', // CRLF injection
        'schema with spaces',
        'schema/with/slashes',
        'schema\\with\\backslashes',
      ];

      for (const maliciousName of maliciousSchemaNames) {
        await expect((aiService as any).loadSchemaContent(maliciousName)).rejects.toThrow(
          'Invalid schema name'
        );
      }

      expect(mockReadFile).not.toHaveBeenCalled();
    });

    test('should allow valid schema names', async () => {
      const validSchemaNames = [
        'plain',
        'code-review',
        'security-check',
        'performance123',
        'ABC123-def',
      ];

      // Mock successful file reading
      mockReadFile.mockResolvedValue('{"test": "schema"}');

      for (const validName of validSchemaNames) {
        await expect((aiService as any).loadSchemaContent(validName)).resolves.toBe(
          '{"test": "schema"}'
        );
      }

      expect(mockReadFile).toHaveBeenCalledTimes(validSchemaNames.length);
    });

    test('should sanitize schema name and construct safe path', async () => {
      const testSchemaName = 'test-schema';
      mockReadFile.mockResolvedValue('{"valid": "schema"}');

      await (aiService as any).loadSchemaContent(testSchemaName);

      // Verify the path was constructed safely
      expect(mockReadFile).toHaveBeenCalledWith(
        expect.stringMatching(/^.*[/\\]output[/\\]test-schema[/\\]schema\.json$/),
        'utf-8'
      );
    });

    test('should handle file system errors gracefully', async () => {
      const validSchemaName = 'valid-schema';
      const fsError = new Error('File not found');
      mockReadFile.mockRejectedValue(fsError);

      await expect((aiService as any).loadSchemaContent(validSchemaName)).rejects.toThrow(
        'Failed to load schema'
      );
    });

    test('should reject inputs with special characters completely', async () => {
      const inputWithMixedChars = 'test-schema123!@#$%^&*()_+=[]{}|;:,.<>?/\\';

      await expect((aiService as any).loadSchemaContent(inputWithMixedChars)).rejects.toThrow(
        'Invalid schema name'
      );

      // Ensure no file system access was attempted
      expect(mockReadFile).not.toHaveBeenCalled();
    });
  });
});
