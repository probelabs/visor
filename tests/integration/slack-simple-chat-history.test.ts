import fs from 'fs';
import yaml from 'js-yaml';
import { createExtendedLiquid } from '../../src/liquid-extensions';
import type { VisorConfig } from '../../src/types/config';

describe('Slack simple chat prompt history', () => {
  it('uses chat_history to produce ordered user/assistant transcript across turns', async () => {
    const raw = fs.readFileSync('examples/slack-simple-chat.yaml', 'utf8');
    const cfg = yaml.load(raw) as VisorConfig;

    const reply = cfg.checks?.['chat-answer'];
    expect(reply).toBeDefined();
    const prompt = String((reply as any).prompt || '');

    const engine = createExtendedLiquid({ strictVariables: false, strictFilters: false });

    // Simulate two turns: user1 -> assistant1 -> user2 -> assistant2
    const outputs_history = {
      ask: [
        { text: 'Hello 1', ts: 1 },
        { text: 'Hello 2', ts: 3 },
      ],
      'chat-answer': [
        { text: 'Reply 1', ts: 2 },
        { text: 'Reply 2', ts: 4 },
      ],
    };

    const checks_meta = {
      ask: { type: 'human-input', group: 'chat' },
      'chat-answer': { type: 'ai', group: 'chat' },
    };

    const rendered = await engine.parseAndRender(prompt, {
      outputs_history,
      checks_meta,
      outputs: {
        ask: { text: 'Hello 2', ts: 3 },
      },
    });

    const lines = String(rendered)
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);

    const convoLines = lines.filter(l => l.startsWith('User:') || l.startsWith('Assistant:'));

    expect(convoLines).toEqual([
      'User: Hello 1',
      'Assistant: Reply 1',
      'User: Hello 2',
      'Assistant: Reply 2',
    ]);
  });
});
