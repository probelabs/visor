#!/usr/bin/env node

import { ProbeAgent } from '@probelabs/probe';
import type { ProbeAgentOptions } from '@probelabs/probe';

async function testProbeAgent() {
  console.log('🚀 Starting minimal ProbeAgent test...\n');

  // Test prompt - similar to what visor would send
  const prompt = `Review this code change for potential issues:

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
  const schemaString = JSON.stringify({
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

  // Session ID - visor generates these with timestamps
  const timestamp = new Date().toISOString();
  const sessionId = `test-${timestamp.replace(/[:.]/g, '-')}`;

  console.log(`📋 Session ID: ${sessionId}`);
  console.log(`📝 Prompt length: ${prompt.length} characters`);
  console.log(`🔧 Using provider: ${process.env.PROVIDER || 'auto'}`);
  console.log(`🤖 Using model: ${process.env.MODEL_NAME || 'default'}\n`);

  // ProbeAgent options - exactly as visor configures them
  const options: ProbeAgentOptions = {
    sessionId: sessionId,
    promptType: 'code-review-template' as 'code-review',  // Visor uses this for schema-based reviews
    allowEdit: false,  // Visor sets this to false (don't modify files)
    debug: process.env.DEBUG === 'true',
    provider: process.env.PROVIDER as any,
    model: process.env.MODEL_NAME
  };

  console.log('🔨 Creating ProbeAgent with options:', JSON.stringify(options, null, 2));

  try {
    // Create the ProbeAgent instance - same as visor
    const agent = new ProbeAgent(options);

    console.log('\n📤 Calling agent.answer() with schema...');

    // Schema options - visor passes schema in this format
    const schemaOptions = { schema: schemaString };

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

    // Test session reuse (as visor does for dependent checks)
    console.log('\n🔄 Testing session reuse...');
    const followUpPrompt = 'Can you elaborate on the first issue you found?';
    const followUpResponse = await agent.answer(followUpPrompt);

    console.log('✅ Session reuse successful!');
    console.log(`📊 Follow-up response length: ${followUpResponse.length} characters`);
    console.log('\n--- FOLLOW-UP RESPONSE ---');
    console.log(followUpResponse);
    console.log('--- END FOLLOW-UP RESPONSE ---\n');

  } catch (error) {
    console.error('\n❌ ProbeAgent failed:', error);
    console.error('Error details:', error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }

  console.log('🎉 Test completed successfully!');
}

// Run the test
testProbeAgent().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});