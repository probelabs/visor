import * as crypto from 'crypto';

export function verifySlackSignature(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  signingSecret: string,
  toleranceSeconds = 300
): boolean {
  try {
    const sig = String(headers['x-slack-signature'] || headers['X-Slack-Signature'] || '');
    const tsRaw = String(
      headers['x-slack-request-timestamp'] || headers['X-Slack-Request-Timestamp'] || ''
    );
    if (!sig || !tsRaw) return false;
    const ts = parseInt(tsRaw, 10);
    if (!Number.isFinite(ts)) return false;
    // Optional replay protection
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > Math.max(60, toleranceSeconds)) return false;
    const base = `v0:${ts}:${rawBody}`;
    const hmac = crypto.createHmac('sha256', signingSecret);
    hmac.update(base, 'utf8');
    const digest = `v0=${hmac.digest('hex')}`;
    return timingSafeEqual(sig, digest);
  } catch {
    return false;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}
