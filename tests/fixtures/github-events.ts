/**
 * Test fixtures for various GitHub event types used in PR detection testing
 */

export const MOCK_REPO_INFO = {
  owner: 'test-owner',
  name: 'test-repo',
};

export const MOCK_PR_DATA = {
  number: 123,
  state: 'open',
  title: 'Test PR for e2e testing',
  head: {
    ref: 'feature-branch',
    sha: 'abc123456789',
  },
  base: {
    ref: 'main',
    sha: 'def456789012',
  },
  draft: false,
  created_at: '2023-01-01T00:00:00Z',
  updated_at: '2023-01-01T12:00:00Z',
};

export const MOCK_COMMITS = [
  {
    id: 'abc123456789',
    message: 'feat: add new feature',
    author: { name: 'Test Author', email: 'test@example.com' },
    timestamp: '2023-01-01T10:00:00Z',
  },
  {
    id: 'def456789012',
    message: 'fix: resolve bug in feature',
    author: { name: 'Test Author', email: 'test@example.com' },
    timestamp: '2023-01-01T11:00:00Z',
  },
];

// Pull Request Event Fixtures
export const PULL_REQUEST_OPENED_EVENT = {
  event_name: 'pull_request',
  repository: {
    owner: { login: MOCK_REPO_INFO.owner },
    name: MOCK_REPO_INFO.name,
  },
  event: {
    action: 'opened',
    pull_request: MOCK_PR_DATA,
  },
  payload: {
    action: 'opened',
    number: MOCK_PR_DATA.number,
    pull_request: MOCK_PR_DATA,
  },
};

export const PULL_REQUEST_SYNCHRONIZE_EVENT = {
  ...PULL_REQUEST_OPENED_EVENT,
  event: {
    action: 'synchronize',
    pull_request: MOCK_PR_DATA,
  },
  payload: {
    ...PULL_REQUEST_OPENED_EVENT.payload,
    action: 'synchronize',
  },
};

export const PULL_REQUEST_EDITED_EVENT = {
  ...PULL_REQUEST_OPENED_EVENT,
  event: {
    action: 'edited',
    pull_request: MOCK_PR_DATA,
  },
  payload: {
    ...PULL_REQUEST_OPENED_EVENT.payload,
    action: 'edited',
  },
};

export const PULL_REQUEST_CLOSED_EVENT = {
  ...PULL_REQUEST_OPENED_EVENT,
  event: {
    action: 'closed',
    pull_request: { ...MOCK_PR_DATA, state: 'closed' },
  },
  payload: {
    ...PULL_REQUEST_OPENED_EVENT.payload,
    action: 'closed',
    pull_request: { ...MOCK_PR_DATA, state: 'closed' },
  },
};

// Push Event Fixtures
export const PUSH_EVENT_TO_FEATURE_BRANCH = {
  event_name: 'push',
  repository: {
    owner: { login: MOCK_REPO_INFO.owner },
    name: MOCK_REPO_INFO.name,
  },
  event: {
    ref: `refs/heads/${MOCK_PR_DATA.head.ref}`,
    head_commit: MOCK_COMMITS[1],
    commits: MOCK_COMMITS,
  },
  payload: {
    ref: `refs/heads/${MOCK_PR_DATA.head.ref}`,
    head_commit: MOCK_COMMITS[1],
    commits: MOCK_COMMITS,
  },
};

export const PUSH_EVENT_TO_MAIN_BRANCH = {
  ...PUSH_EVENT_TO_FEATURE_BRANCH,
  event: {
    ...PUSH_EVENT_TO_FEATURE_BRANCH.event,
    ref: 'refs/heads/main',
  },
  payload: {
    ...PUSH_EVENT_TO_FEATURE_BRANCH.payload,
    ref: 'refs/heads/main',
  },
};

// Issue Comment Event Fixtures
export const ISSUE_COMMENT_ON_PR_EVENT = {
  event_name: 'issue_comment',
  repository: {
    owner: { login: MOCK_REPO_INFO.owner },
    name: MOCK_REPO_INFO.name,
  },
  event: {
    action: 'created',
    issue: {
      number: MOCK_PR_DATA.number,
      pull_request: {
        url: `https://api.github.com/repos/${MOCK_REPO_INFO.owner}/${MOCK_REPO_INFO.name}/pulls/${MOCK_PR_DATA.number}`,
      }, // Presence indicates this is a PR
      state: 'open',
    },
    comment: {
      id: 789,
      body: '/review --focus=security',
      user: { login: 'reviewer' },
      created_at: '2023-01-01T13:00:00Z',
    },
  },
  payload: {
    action: 'created',
    issue: {
      number: MOCK_PR_DATA.number,
      pull_request: {
        url: `https://api.github.com/repos/${MOCK_REPO_INFO.owner}/${MOCK_REPO_INFO.name}/pulls/${MOCK_PR_DATA.number}`,
      },
      state: 'open',
    },
    comment: {
      id: 789,
      body: '/review --focus=security',
      user: { login: 'reviewer' },
      created_at: '2023-01-01T13:00:00Z',
    },
  },
};

export const ISSUE_COMMENT_ON_ISSUE_EVENT = {
  ...ISSUE_COMMENT_ON_PR_EVENT,
  event: {
    ...ISSUE_COMMENT_ON_PR_EVENT.event,
    issue: {
      number: 456,
      // No pull_request property - this is a regular issue
      state: 'open',
    },
  },
  payload: {
    ...ISSUE_COMMENT_ON_PR_EVENT.payload,
    issue: {
      number: 456,
      state: 'open',
    },
  },
};

// Other Event Types
export const WORKFLOW_RUN_EVENT = {
  event_name: 'workflow_run',
  repository: {
    owner: { login: MOCK_REPO_INFO.owner },
    name: MOCK_REPO_INFO.name,
  },
  event: {
    action: 'completed',
    workflow_run: {
      id: 123456,
      head_branch: MOCK_PR_DATA.head.ref,
      head_sha: MOCK_PR_DATA.head.sha,
    },
  },
  payload: {
    action: 'completed',
    workflow_run: {
      id: 123456,
      head_branch: MOCK_PR_DATA.head.ref,
      head_sha: MOCK_PR_DATA.head.sha,
    },
  },
};

export const CHECK_RUN_EVENT = {
  event_name: 'check_run',
  repository: {
    owner: { login: MOCK_REPO_INFO.owner },
    name: MOCK_REPO_INFO.name,
  },
  event: {
    action: 'created',
    check_run: {
      id: 789012,
      head_sha: MOCK_PR_DATA.head.sha,
    },
  },
  payload: {
    action: 'created',
    check_run: {
      id: 789012,
      head_sha: MOCK_PR_DATA.head.sha,
    },
  },
};

// Edge Case Event Fixtures
export const UNKNOWN_EVENT = {
  event_name: 'unknown',
  repository: {
    owner: { login: MOCK_REPO_INFO.owner },
    name: MOCK_REPO_INFO.name,
  },
  event: {},
  payload: {},
};

export const EVENT_WITHOUT_REPOSITORY = {
  event_name: 'push',
  event: {
    ref: 'refs/heads/feature-branch',
    commits: MOCK_COMMITS,
  },
  payload: {
    ref: 'refs/heads/feature-branch',
    commits: MOCK_COMMITS,
  },
};

// Mock API Responses
export const MOCK_API_RESPONSES = {
  // Multiple PRs for same branch
  multiplePRs: [
    { number: 123, head: { ref: 'feature-branch' }, state: 'open' },
    { number: 124, head: { ref: 'feature-branch' }, state: 'open' },
  ],

  // Single PR for branch
  singlePR: [{ number: 123, head: { ref: 'feature-branch' }, state: 'open' }],

  // No PRs found
  noPRs: [],

  // Closed PR
  closedPR: [
    {
      number: 123,
      head: { ref: 'feature-branch' },
      state: 'closed',
      merged_at: '2023-01-01T14:00:00Z',
    },
  ],

  // Search API response with PR containing commit
  searchWithCommit: {
    data: {
      items: [
        {
          number: 123,
          pull_request: {},
          state: 'open',
        },
      ],
    },
  },

  // Search API response with no results
  searchNoResults: {
    data: {
      items: [],
    },
  },

  // PR commits response
  prCommits: {
    data: [{ sha: 'abc123456789' }, { sha: 'def456789012' }],
  },

  // Rate limit error
  rateLimitError: {
    status: 403,
    response: {
      data: { message: 'API rate limit exceeded' },
      headers: { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) },
    },
  },

  // Generic API error
  apiError: {
    status: 500,
    response: {
      data: { message: 'Internal Server Error' },
    },
  },
};

// Environment Variable Fixtures
export const GITHUB_ENV_VARS = {
  withPRContext: {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_REPOSITORY: `${MOCK_REPO_INFO.owner}/${MOCK_REPO_INFO.name}`,
    GITHUB_REPOSITORY_OWNER: MOCK_REPO_INFO.owner,
    GITHUB_HEAD_REF: MOCK_PR_DATA.head.ref,
    GITHUB_BASE_REF: MOCK_PR_DATA.base.ref,
    GITHUB_SHA: MOCK_PR_DATA.head.sha,
    GITHUB_REF: `refs/pull/${MOCK_PR_DATA.number}/merge`,
    GITHUB_REF_NAME: `${MOCK_PR_DATA.number}/merge`,
  },

  withPushContext: {
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REPOSITORY: `${MOCK_REPO_INFO.owner}/${MOCK_REPO_INFO.name}`,
    GITHUB_REPOSITORY_OWNER: MOCK_REPO_INFO.owner,
    GITHUB_SHA: MOCK_COMMITS[1].id,
    GITHUB_REF: `refs/heads/${MOCK_PR_DATA.head.ref}`,
    GITHUB_REF_NAME: MOCK_PR_DATA.head.ref,
  },

  minimal: {
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REPOSITORY: `${MOCK_REPO_INFO.owner}/${MOCK_REPO_INFO.name}`,
    GITHUB_REPOSITORY_OWNER: MOCK_REPO_INFO.owner,
  },
};

// Visor Config Fixtures
export const VISOR_CONFIG = {
  version: '1.0',
  checks: {
    'security-review': {
      type: 'ai' as const,
      prompt: 'Review for security vulnerabilities',
      on: ['pr_opened' as const, 'pr_updated' as const],
      triggers: ['**/*.{js,ts,py}'],
    },
    'performance-review': {
      type: 'ai' as const,
      prompt: 'Analyze performance implications',
      on: ['pr_opened' as const, 'pr_updated' as const],
      triggers: ['**/*.sql', 'src/database/**/*'],
    },
    'style-check': {
      type: 'ai' as const,
      prompt: 'Check code style and formatting',
      on: ['pr_opened' as const],
      triggers: ['src/**/*'],
    },
  },
  output: {
    pr_comment: {
      format: 'table' as const,
      group_by: 'check' as const,
      collapse: true,
    },
  },
};

// Action Input Fixtures
export const ACTION_INPUTS = {
  visorMode: {
    'github-token': 'test-token',
    'visor-config-path': './.visor.yaml',
    owner: MOCK_REPO_INFO.owner,
    repo: MOCK_REPO_INFO.name,
  },

  visorModeWithChecks: {
    'github-token': 'test-token',
    'visor-checks': 'security-review,performance-review',
    owner: MOCK_REPO_INFO.owner,
    repo: MOCK_REPO_INFO.name,
  },

  autoReviewMode: {
    'github-token': 'test-token',
    'auto-review': 'true',
    'visor-config-path': './.visor.yaml',
    owner: MOCK_REPO_INFO.owner,
    repo: MOCK_REPO_INFO.name,
  },

  legacyMode: {
    'github-token': 'test-token',
    'auto-review': 'true',
    owner: MOCK_REPO_INFO.owner,
    repo: MOCK_REPO_INFO.name,
  },

  debugMode: {
    'github-token': 'test-token',
    'visor-config-path': './.visor.yaml',
    debug: 'true',
    owner: MOCK_REPO_INFO.owner,
    repo: MOCK_REPO_INFO.name,
  },
};
