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
