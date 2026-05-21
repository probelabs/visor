function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function stripWrapperPrefixes(text: string): string {
  let cleaned = text.trim();
  const wrapperPatterns = [
    /^AI analysis failed:\s*/i,
    /^Claude Code analysis failed:\s*/i,
    /^ProbeAgent execution failed:\s*/i,
    /^Workflow step '[^']+' failed:\s*/i,
    /^Error:\s*/i,
  ];

  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of wrapperPatterns) {
      const next = cleaned.replace(pattern, '');
      if (next !== cleaned) {
        cleaned = next.trim();
        changed = true;
      }
    }
  }

  return cleaned;
}

function collectErrorStrings(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
  out: string[] = []
): string[] {
  if (value == null || depth > 3) return out;

  if (typeof value === 'string') {
    if (value.trim()) out.push(value.trim());
    return out;
  }

  if (typeof value !== 'object') {
    out.push(String(value));
    return out;
  }

  if (seen.has(value)) return out;
  seen.add(value);

  const obj = value as Record<string, unknown>;
  const candidateKeys = ['message', 'responseBody', 'error', 'details', 'body', 'cause'];

  for (const key of candidateKeys) {
    if (key in obj) collectErrorStrings(obj[key], seen, depth + 1, out);
  }

  return out;
}

function matchUserFacingErrorMessage(raw: string): string | null {
  if (/no api key provided and neither claude nor codex command found/i.test(raw)) {
    return 'No API key provided and neither claude nor codex command found.';
  }

  if (/budget limit exceeded|budget exceeded/i.test(raw)) {
    return 'The AI provider budget limit was exceeded before a response could be generated. Please retry later or switch model/provider.';
  }

  if (
    /currently experiencing high demand|status.?unavailable|spikes in demand are usually temporary/i.test(
      raw
    )
  ) {
    return 'The AI provider is currently experiencing high demand and did not generate a response. Please retry shortly.';
  }

  if (/rate limit/i.test(raw)) {
    return 'The AI provider rate limit was reached before a response could be generated. Please retry shortly.';
  }

  if (/401|authentication|api key|invalid api key|unauthorized/i.test(raw)) {
    return 'The AI provider request was rejected before a response could be generated. Please check credentials and provider access.';
  }

  if (/403|forbidden/i.test(raw)) {
    return 'The AI provider rejected the request before a response could be generated. This is usually caused by budget limits, access policy, or model permissions.';
  }

  if (
    /^request timed out$/i.test(raw) ||
    (/timed out|timeout/i.test(raw) &&
      /(failed to get response from ai model|ai request|probeagent|provider|model|streamtext)/i.test(
        raw
      ))
  ) {
    return 'The AI request timed out before a response could be generated. Please retry.';
  }

  if (/no output generated|failed to get response from ai model/i.test(raw)) {
    return 'The AI provider failed before generating any response. This is usually caused by a provider-side limit, rate limit, or outage. Please retry.';
  }

  return null;
}

export function formatUserFacingExecutionError(error: unknown): string {
  const collected = collectErrorStrings(error);
  const raw = normalizeWhitespace(collected.join(' | ') || String(error ?? 'Unknown error'));
  const matched = matchUserFacingErrorMessage(raw);
  if (matched) return matched;

  const cleaned = normalizeWhitespace(stripWrapperPrefixes(raw));
  return cleaned || 'The request failed before a response could be generated. Please retry.';
}

export function formatUserFacingExecutionMessage(message: string): string {
  return formatUserFacingExecutionError(message);
}

type IssueLike = {
  ruleId?: string;
  message?: string;
  severity?: string;
};

function issuePriority(issue: IssueLike): number {
  const ruleId = String(issue.ruleId || '');
  const message = String(issue.message || '');

  if (ruleId.startsWith('system/') || ruleId.endsWith('/error')) return 0;
  if (ruleId.includes('timeout') || /timed out|timeout/i.test(message)) return 1;
  if (
    ruleId.includes('contract/guarantee_failed') &&
    /output\??\.\s*text|\btext\b.*length\s*>\s*0|\btext\b.*trim/i.test(message)
  ) {
    return 2;
  }
  return 3;
}

function formatGuaranteeFailureMessage(issue: IssueLike): string | null {
  const ruleId = String(issue.ruleId || '');
  const message = String(issue.message || '');
  if (!ruleId.includes('contract/guarantee_failed')) return null;
  if (/output\??\.\s*text|\btext\b.*length\s*>\s*0|\btext\b.*trim/i.test(message)) {
    return 'The assistant failed to produce a response. This is usually caused by a provider-side limit, outage, or invalid structured output. Please retry.';
  }
  return null;
}

export function summarizeUserFacingIssues(issues: unknown): string | null {
  if (!Array.isArray(issues) || issues.length === 0) return null;

  const candidates = issues.filter(
    (issue): issue is IssueLike =>
      !!issue &&
      typeof issue === 'object' &&
      String((issue as IssueLike).severity || '').toLowerCase() === 'error'
  );
  if (candidates.length === 0) return null;

  const prioritized = [...candidates].sort((a, b) => issuePriority(a) - issuePriority(b));
  const seen = new Set<string>();
  const messages: string[] = [];

  for (const issue of prioritized) {
    const formatted =
      formatGuaranteeFailureMessage(issue) ||
      formatUserFacingExecutionMessage(String(issue.message || 'Execution error'));
    if (!formatted || seen.has(formatted)) continue;
    seen.add(formatted);
    messages.push(formatted);
    if (messages.length >= 2) break;
  }

  return messages.length > 0 ? messages.join('\n') : null;
}
