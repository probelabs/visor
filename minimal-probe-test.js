#!/usr/bin/env node

const { ProbeAgent } = require('@probelabs/probe');

async function testProbeAgent() {
  console.log('🚀 Starting minimal ProbeAgent test...\n');

  // Check command line arguments for test type
  const testType = process.argv[2] || 'review';
  console.log(`📌 Test type: ${testType}\n`);

  // Choose prompt based on test type
  let prompt, schemaString, promptType;

  if (testType === 'overview') {
    // PR Overview prompt - exactly like visor's default config (no schema, plain markdown)
    prompt = `# 📋 Pull Request Overview: Add user authentication system

## Description
Implements JWT-based authentication with refresh tokens for secure user authentication

## Files Changed Analysis

<files_summary>
- src/auth/jwt.service.ts (new file, 150 lines)
- src/auth/auth.controller.ts (new file, 85 lines)
- src/users/users.service.ts (modified, +45 lines)
- package.json (modified, +2 dependencies)
</files_summary>

Analyze the files listed in the <files_summary> section, which provides a structured overview of all changes including filenames, status, additions, and deletions.

## Architecture & Impact Assessment

Please generate a comprehensive overview and analysis of this pull request.

Follow these instructions to create a thorough assessment:

1. **Change Summary**: Provide a clear, concise summary of what this PR accomplishes
2. **Architecture Impact**: Analyze how these changes affect the system architecture
3. **Security Considerations**: Identify any security implications or concerns
4. **Performance Impact**: Note any performance implications
5. **Testing Requirements**: Suggest what tests should be added or updated
6. **Risk Assessment**: Evaluate the overall risk level (low/medium/high) with justification

Format your response as clear markdown sections. Be thorough but concise.`;

    // No schema for overview - visor uses plain markdown output
    schemaString = undefined;
    promptType = undefined;  // No promptType for plain markdown output

  } else if (testType === 'plain') {
    // Plain review without schema - like visor's plain mode
    prompt = `Review this code change for potential issues:

\`\`\`javascript
function calculateTotal(items) {
  let total = 0;
  for (let i = 0; i <= items.length; i++) {  // Bug: should be i < items.length
    total += items[i].price;
  }
  return total;
}
\`\`\`

Please identify any bugs, security issues, or performance problems.`;

    schemaString = undefined;  // No schema for plain mode
    promptType = undefined;  // No prompt type for plain mode

  } else {
    // Default: Code review with schema
    prompt = `Review this code change for potential issues:

\`\`\`javascript
function calculateTotal(items) {
  let total = 0;
  for (let i = 0; i <= items.length; i++) {  // Bug: should be i < items.length
    total += items[i].price;
  }
  return total;
}
\`\`\`

Please identify any bugs, security issues, or performance problems.`;

    // Schema for structured response (optional - visor uses this for JSON validation)
    schemaString = JSON.stringify({
      type: 'object',
      properties: {
        issues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              severity: { type: 'string' },
              description: { type: 'string' },
              line: { type: 'number' }
            },
            required: ['type', 'severity', 'description']
          }
        }
      },
      required: ['issues']
    });

    promptType = 'code-review-template';
  }

  // Session ID - visor generates these with timestamps
  const timestamp = new Date().toISOString();
  const sessionId = `test-${timestamp.replace(/[:.]/g, '-')}`;

  console.log(`📋 Session ID: ${sessionId}`);
  console.log(`📝 Prompt length: ${prompt.length} characters`);
  console.log(`🔧 Using provider: ${process.env.PROVIDER || 'auto'}`);
  console.log(`🤖 Using model: ${process.env.MODEL_NAME || 'default'}\n`);

  // ProbeAgent options - exactly as visor configures them
  const debugMode = process.env.DEBUG === 'true';
  const options = {
    sessionId: sessionId,
    promptType: promptType,  // Use the promptType determined by test type
    allowEdit: false,  // Visor sets this to false (don't modify files)
    debug: debugMode,  // Enable SDK debug output
    provider: process.env.PROVIDER,
    model: process.env.MODEL_NAME
  };

  if (debugMode) {
    console.log('🐛 DEBUG MODE ENABLED - ProbeAgent will show internal operations');
    console.log('');
  }

  console.log('🔨 Creating ProbeAgent with options:', JSON.stringify(options, null, 2));

  try {
    // Create the ProbeAgent instance - same as visor
    const agent = new ProbeAgent(options);

    console.log(`\n📤 Calling agent.answer()${schemaString ? ' with schema' : ' (plain markdown mode)'}...`);

    // Schema options - visor passes schema in this format when schema exists
    const schemaOptions = schemaString ? { schema: schemaString } : undefined;

    // Call the agent - exactly as visor does
    const response = await agent.answer(prompt, undefined, schemaOptions);

    console.log('\n✅ Response received!');
    console.log(`📊 Response length: ${response.length} characters`);
    console.log('\n--- RESPONSE ---');
    console.log(response);
    console.log('--- END RESPONSE ---\n');

    // Try parsing if it looks like JSON
    try {
      const parsed = JSON.parse(response);
      console.log('✨ Response is valid JSON:', JSON.stringify(parsed, null, 2));
    } catch {
      console.log('ℹ️  Response is plain text (not JSON)');
    }

    // Test session reuse - THIS IS WHERE THE INTERESTING BEHAVIOR HAPPENS
    console.log('\n🔄 Testing session reuse...');

    // Simple follow-up prompt - exactly like the original version that showed the issue
    const followUpPrompt = 'Can you elaborate on the first issue you found?';

    try {
      // Just call answer() without any schema options - this was triggering the binary download
      const followUpResponse = await agent.answer(followUpPrompt);

      console.log('✅ Session reuse successful!');
      console.log(`📊 Follow-up response length: ${followUpResponse.length} characters`);
      console.log('\n--- FOLLOW-UP RESPONSE ---');
      console.log(followUpResponse);
      console.log('--- END FOLLOW-UP RESPONSE ---\n');

      // If you see <thinking> tags or attempt_complete in the response, that's the issue!
      if (followUpResponse.includes('<thinking>') || followUpResponse.includes('attempt_complete')) {
        console.log('⚠️  WARNING: Response contains internal XML tags!');
        console.log('This indicates the ProbeAgent is exposing internal processing tags.');
      }

    } catch (reuseError) {
      console.error('⚠️  Session reuse failed:', reuseError);
      console.error('\nError details:', reuseError.message || 'Unknown error');
    }

  } catch (error) {
    console.error('\n❌ ProbeAgent failed:', error);
    console.error('Error details:', error.message || 'Unknown error');
    process.exit(1);
  }

  console.log('🎉 Test completed successfully!');
}

// Run the test
testProbeAgent().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});