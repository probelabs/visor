/**
 * GitHub Action input types
 */
export interface GitHubActionInputs {
  'github-token': string;
  owner?: string;
  repo?: string;
  'auto-review'?: string;
  // GitHub App authentication
  'app-id'?: string;
  'private-key'?: string;
  'installation-id'?: string;
  checks?: string;
  'output-format'?: string;
  'config-path'?: string;
  'comment-on-pr'?: string;
  'create-check'?: string;
  'add-labels'?: string;
  'add-reactions'?: string;
  'fail-on-critical'?: string;
  'fail-on-api-error'?: string;
  'min-score'?: string;
  'max-parallelism'?: string;
  'fail-fast'?: string;
  debug?: string;
  'ai-provider'?: string;
  'ai-model'?: string;
  // Tag filtering
  tags?: string;
  'exclude-tags'?: string;
  // Legacy inputs for backward compatibility
  'visor-config-path'?: string;
  'visor-checks'?: string;
}

/**
 * GitHub context information
 */
export interface GitHubContext {
  event_name: string;
  repository?: {
    owner: { login: string };
    name: string;
  };
  event?: {
    comment?: Record<string, unknown>;
    issue?: Record<string, unknown>;
    pull_request?: Record<string, unknown>;
    action?: string;
  };
  payload?: Record<string, unknown>;
}
