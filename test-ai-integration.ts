#!/usr/bin/env ts-node

/**
 * AI Integration Test
 * 
 * This test validates that the AI review service can successfully:
 * 1. Execute probe-chat commands
 * 2. Handle real API calls to the Gemini model
 * 3. Parse responses correctly
 * 4. Return proper review summaries
 * 
 * Environment variables required:
 * - GOOGLE_API_KEY=AIzaSyBdgXolglXrMGxQTmwIMaLnJRe1LseN3_A
 * - MODEL_NAME=gemini-2.5-pro-preview-06-05
 */

import { AIReviewService, ReviewFocus } from './src/ai-review-service';
import { PRInfo, PRDiff } from './src/pr-analyzer';

// Test data: Mock PR information
const createTestPRInfo = (): PRInfo => ({
  number: 123,
  title: 'Add authentication middleware and fix security issues',
  body: 'This PR adds JWT authentication middleware and fixes several security vulnerabilities including SQL injection risks and XSS vulnerabilities.',
  author: 'test-user',
  base: 'main',
  head: 'feature/auth-security-fixes',
  totalAdditions: 156,
  totalDeletions: 23,
  files: [
    {
      filename: 'src/auth/middleware.ts',
      status: 'added',
      additions: 89,
      deletions: 0,
      changes: 89,
      patch: `@@ -0,0 +1,89 @@
+import jwt from 'jsonwebtoken';
+import { Request, Response, NextFunction } from 'express';
+
+export interface AuthRequest extends Request {
+  user?: {
+    id: string;
+    email: string;
+    role: string;
+  };
+}
+
+// TODO: Move this to environment variables
+const JWT_SECRET = 'hardcoded-secret-key-123';
+
+export const authenticateToken = (req: AuthRequest, res: Response, next: NextFunction): void => {
+  const authHeader = req.headers['authorization'];
+  const token = authHeader && authHeader.split(' ')[1];
+
+  if (!token) {
+    res.sendStatus(401);
+    return;
+  }
+
+  // Potential security issue: not validating token properly
+  jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
+    if (err) {
+      res.sendStatus(403);
+      return;
+    }
+    req.user = user;
+    next();
+  });
+};
+
+export const requireRole = (role: string) => {
+  return (req: AuthRequest, res: Response, next: NextFunction): void => {
+    if (!req.user || req.user.role !== role) {
+      res.sendStatus(403);
+      return;
+    }
+    next();
+  };
+};`
    },
    {
      filename: 'src/database/queries.ts',
      status: 'modified',
      additions: 67,
      deletions: 23,
      changes: 90,
      patch: `@@ -15,10 +15,15 @@ export class UserService {
   }
 
-  async getUserById(id: string): Promise<User | null> {
-    // SQL injection vulnerability
-    const query = \`SELECT * FROM users WHERE id = '\${id}'\`;
-    const result = await this.db.query(query);
+  async getUserById(id: string): Promise<User | null> {
+    // Fixed: Using parameterized query to prevent SQL injection
+    const query = 'SELECT * FROM users WHERE id = $1';
+    const result = await this.db.query(query, [id]);
     return result.rows[0] || null;
   }
 
+  async searchUsers(searchTerm: string): Promise<User[]> {
+    // Still vulnerable to SQL injection
+    const query = \`SELECT * FROM users WHERE name LIKE '%\${searchTerm}%'\`;
+    const result = await this.db.query(query);
+    return result.rows;
+  }`
    }
  ]
});

// Test functions
async function testBasicAIReview(): Promise<any> {
  console.log('\n🧪 Testing Basic AI Review...');
  
  const aiService = new AIReviewService();
  const prInfo = createTestPRInfo();
  
  console.log('📋 PR Info:', {
    title: prInfo.title,
    files: prInfo.files.length,
    totalChanges: prInfo.totalAdditions + prInfo.totalDeletions
  });

  try {
    const result = await aiService.executeReview(prInfo, 'all');
    
    console.log('\n✅ AI Review Results:');
    console.log(`📊 Overall Score: ${result.overallScore}/100`);
    console.log(`📋 Total Issues: ${result.totalIssues}`);
    console.log(`🚨 Critical Issues: ${result.criticalIssues}`);
    console.log(`💡 Suggestions: ${result.suggestions.length}`);
    console.log(`💬 Comments: ${result.comments.length}`);
    
    // Display suggestions
    if (result.suggestions.length > 0) {
      console.log('\n💡 Suggestions:');
      result.suggestions.forEach((suggestion, index) => {
        console.log(`  ${index + 1}. ${suggestion}`);
      });
    }
    
    // Display comments
    if (result.comments.length > 0) {
      console.log('\n💬 Comments:');
      result.comments.forEach((comment, index) => {
        console.log(`  ${index + 1}. [${comment.severity.toUpperCase()}] ${comment.file}:${comment.line}`);
        console.log(`     Category: ${comment.category}`);
        console.log(`     Message: ${comment.message}`);
      });
    }
    
    return result;
  } catch (error) {
    console.error('❌ Basic AI Review failed:', error);
    throw error;
  }
}

async function testSecurityFocusedReview(): Promise<any> {
  console.log('\n🔐 Testing Security-Focused Review...');
  
  const aiService = new AIReviewService();
  const prInfo = createTestPRInfo();
  
  try {
    const result = await aiService.executeReview(prInfo, 'security');
    
    console.log('\n🔐 Security Review Results:');
    console.log(`📊 Overall Score: ${result.overallScore}/100`);
    console.log(`🚨 Security Issues Found: ${result.totalIssues}`);
    
    // Check if security issues were detected
    const securityComments = result.comments.filter(c => c.category === 'security');
    console.log(`🛡️ Security-specific comments: ${securityComments.length}`);
    
    if (securityComments.length > 0) {
      console.log('\n🛡️ Security Issues:');
      securityComments.forEach((comment, index) => {
        console.log(`  ${index + 1}. [${comment.severity.toUpperCase()}] ${comment.file}:${comment.line}`);
        console.log(`     ${comment.message}`);
      });
    }
    
    return result;
  } catch (error) {
    console.error('❌ Security-focused review failed:', error);
    throw error;
  }
}

async function testPerformanceReview(): Promise<any> {
  console.log('\n⚡ Testing Performance-Focused Review...');
  
  const aiService = new AIReviewService();
  const prInfo = createTestPRInfo();
  
  try {
    const result = await aiService.executeReview(prInfo, 'performance');
    
    console.log('\n⚡ Performance Review Results:');
    console.log(`📊 Overall Score: ${result.overallScore}/100`);
    console.log(`⚡ Performance Issues Found: ${result.totalIssues}`);
    
    return result;
  } catch (error) {
    console.error('❌ Performance review failed:', error);
    throw error;
  }
}

async function testWithCustomConfig(): Promise<any> {
  console.log('\n⚙️ Testing with Custom Configuration...');
  
  const aiService = new AIReviewService({
    timeout: 45000, // 45 seconds
    model: process.env.MODEL_NAME,
    apiKey: process.env.GOOGLE_API_KEY,
    provider: 'google'
  });
  
  const prInfo = createTestPRInfo();
  
  try {
    const result = await aiService.executeReview(prInfo, 'all');
    
    console.log('\n⚙️ Custom Config Review Results:');
    console.log(`📊 Overall Score: ${result.overallScore}/100`);
    console.log(`📋 Total Issues: ${result.totalIssues}`);
    
    return result;
  } catch (error) {
    console.error('❌ Custom config review failed:', error);
    throw error;
  }
}

async function runAllTests(): Promise<void> {
  console.log('🚀 Starting AI Integration Tests');
  console.log('=' .repeat(50));
  
  // Check environment variables
  console.log('\n🔍 Environment Check:');
  console.log(`GOOGLE_API_KEY: ${process.env.GOOGLE_API_KEY ? '✅ Set' : '❌ Missing'}`);
  console.log(`MODEL_NAME: ${process.env.MODEL_NAME || '❌ Missing'}`);
  
  if (!process.env.GOOGLE_API_KEY) {
    console.error('❌ GOOGLE_API_KEY environment variable is required');
    process.exit(1);
  }
  
  const startTime = Date.now();
  let passed = 0;
  let failed = 0;
  
  // Run tests
  const tests = [
    { name: 'Basic AI Review', fn: testBasicAIReview },
    { name: 'Security-Focused Review', fn: testSecurityFocusedReview },
    { name: 'Performance Review', fn: testPerformanceReview },
    { name: 'Custom Configuration', fn: testWithCustomConfig },
  ];
  
  for (const test of tests) {
    try {
      console.log(`\n🧪 Running: ${test.name}`);
      await test.fn();
      console.log(`✅ PASSED: ${test.name}`);
      passed++;
    } catch (error) {
      console.error(`❌ FAILED: ${test.name}`, error);
      failed++;
    }
  }
  
  // Summary
  const duration = Date.now() - startTime;
  console.log('\n' + '='.repeat(50));
  console.log('🎯 TEST SUMMARY');
  console.log('='.repeat(50));
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`⏱️  Duration: ${duration}ms`);
  
  if (failed > 0) {
    console.log('\n❌ Some tests failed. Check the output above for details.');
    process.exit(1);
  } else {
    console.log('\n🎉 All tests passed! AI integration is working correctly.');
  }
}

// Run the tests if this script is executed directly
if (require.main === module) {
  runAllTests().catch((error) => {
    console.error('💥 Test suite crashed:', error);
    process.exit(1);
  });
}

export {
  testBasicAIReview,
  testSecurityFocusedReview,
  testPerformanceReview,
  testWithCustomConfig,
  runAllTests
};