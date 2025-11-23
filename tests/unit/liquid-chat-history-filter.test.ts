import { createExtendedLiquid } from '../../src/liquid-extensions';

describe('Liquid chat_history filter', () => {
  it('merges steps, sorts by ts and assigns roles from checks_meta', async () => {
    const engine = createExtendedLiquid({ strictVariables: false, strictFilters: false });

    const template = `{{ '' | chat_history: 'ask', 'reply' | json }}`;

    const outputs_history = {
      ask: [
        { text: 'hi', ts: 1 },
        { text: 'second', ts: 3 },
      ],
      reply: [{ text: 'hello', ts: 2 }],
    };

    const checks_meta = {
      ask: { type: 'human-input', group: 'chat' },
      reply: { type: 'ai', group: 'chat' },
    };

    const rendered = await engine.parseAndRender(template, {
      outputs_history,
      checks_meta,
    });

    const parsed = JSON.parse(String(rendered)) as Array<{
      step: string;
      role: string;
      text: string;
      ts: number;
    }>;

    expect(parsed.map(m => `${m.step}-${m.role}-${m.text}`)).toEqual([
      'ask-user-hi',
      'reply-assistant-hello',
      'ask-user-second',
    ]);
  });

  it('respects direction and limit options', async () => {
    const engine = createExtendedLiquid({ strictVariables: false, strictFilters: false });

    const template = `{{ '' | chat_history: 'a', 'b', direction: 'desc', limit: 2 | json }}`;

    const outputs_history = {
      a: [
        { text: '1', ts: 1 },
        { text: '4', ts: 4 },
      ],
      b: [
        { text: '2', ts: 2 },
        { text: '3', ts: 3 },
      ],
    };

    const rendered = await engine.parseAndRender(template, { outputs_history });

    const parsed = JSON.parse(String(rendered)) as Array<{ step: string; text: string }>;

    // Combined ascending would be: a-1, b-2, b-3, a-4
    // direction: desc, limit: 2 -> keep newest two: a-4, b-3
    expect(parsed.map(m => `${m.step}-${m.text}`)).toEqual(['a-4', 'b-3']);
  });
});
