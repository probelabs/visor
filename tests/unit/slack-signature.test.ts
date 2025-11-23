import { verifySlackSignature } from '../../src/slack/signature';

describe('verifySlackSignature', () => {
  test('accepts valid signature', () => {
    const secret = 'test_secret';
    const body = JSON.stringify({ type: 'event_callback', token: 'x' });
    const ts = Math.floor(Date.now() / 1000).toString();
    const crypto = require('crypto');
    const base = `v0:${ts}:${body}`;
    const sig = 'v0=' + crypto.createHmac('sha256', secret).update(base, 'utf8').digest('hex');
    const headers: any = {
      'x-slack-signature': sig,
      'x-slack-request-timestamp': ts,
    };
    expect(verifySlackSignature(headers, body, secret)).toBe(true);
  });

  test('rejects when outside tolerance', () => {
    const secret = 'test_secret';
    const body = '{}';
    const ts = (Math.floor(Date.now() / 1000) - 10000).toString();
    const crypto = require('crypto');
    const base = `v0:${ts}:${body}`;
    const sig = 'v0=' + crypto.createHmac('sha256', secret).update(base, 'utf8').digest('hex');
    const headers: any = {
      'x-slack-signature': sig,
      'x-slack-request-timestamp': ts,
    };
    expect(verifySlackSignature(headers, body, secret)).toBe(false);
  });
});
