import { VisorConfig, CheckConfig, EventTrigger } from './types/config';

export interface GitHubEventContext {
  event_name: string;
  action?: string;
  repository?: {
    owner: { login: string };
    name: string;
  };
  pull_request?: {
    number: number;
    state: string;
    head: {
      sha: string;
      ref: string;
    };
    base: {
      sha: string;
      ref: string;
    };
    draft: boolean;
  };
  issue?: {
    number: number;
    title?: string;
    body?: string;
    state?: string;
    user?: {
      login: string;
    };
    labels?: Array<{
      name: string;
      color: string;
    }>;
    assignees?: Array<{
      login: string;
    }>;
    created_at?: string;
    updated_at?: string;
    pull_request?: Record<string, unknown>;
  };
  comment?: {
    body: string;
    user: {
      login: string;
    };
  };
}

export interface MappedExecution {
  shouldExecute: boolean;
  checksToRun: string[];
  executionContext: {
    eventType: EventTrigger;
    prNumber?: number;
    repository: string;
    triggeredBy: string;
  };
}

export interface FileChangeContext {
  changedFiles?: string[];
  addedFiles?: string[];
  modifiedFiles?: string[];
  deletedFiles?: string[];
}

/**
 * Maps GitHub events to Visor check executions based on configuration
 */
export class EventMapper {
  constructor(private config: VisorConfig) {}

  /**
   * Map GitHub event to execution plan
   */
  public mapEventToExecution(
    eventContext: GitHubEventContext,
    fileContext?: FileChangeContext
  ): MappedExecution {
    // Validate input payload first
    if (!eventContext || typeof eventContext !== 'object') {
      throw new Error('Invalid or corrupted event payload: missing event context');
    }

    if (!eventContext.event_name || typeof eventContext.event_name !== 'string') {
      throw new Error('Invalid or corrupted event payload: missing or invalid event_name');
    }

    const eventTrigger = this.mapGitHubEventToTrigger(eventContext);

    if (!eventTrigger) {
      return {
        shouldExecute: false,
        checksToRun: [],
        executionContext: {
          eventType: 'pr_opened',
          repository: this.getRepositoryName(eventContext),
          triggeredBy: 'unknown_event',
        },
      };
    }

    const checksToRun = this.getChecksForEvent(eventTrigger, fileContext);
    const repository = this.getRepositoryName(eventContext);

    return {
      shouldExecute: checksToRun.length > 0,
      checksToRun,
      executionContext: {
        eventType: eventTrigger,
        prNumber: this.extractPRNumber(eventContext),
        repository,
        triggeredBy: this.getTriggeredBy(eventContext),
      },
    };
  }

  /**
   * Map GitHub event to Visor event trigger
   */
  private mapGitHubEventToTrigger(eventContext: GitHubEventContext): EventTrigger | null {
    const { event_name, action } = eventContext;

    switch (event_name) {
      case 'pull_request':
        if (action === 'opened') return 'pr_opened';
        if (action === 'synchronize' || action === 'edited') return 'pr_updated';
        if (action === 'closed') return 'pr_closed';
        break;

      case 'issues':
        if (action === 'opened') return 'issue_opened';
        break;

      case 'issue_comment':
        // Check if this is a comment on a PR (has pull_request property)
        if (eventContext.issue?.pull_request) {
          return 'pr_updated'; // Treat PR comments as PR updates
        }
        return 'issue_comment'; // Regular issue comments remain issue_comment
        break;

      case 'pull_request_review':
        return 'pr_updated';

      case 'push':
        // Push events are not directly supported as PR events
        // They would need additional context to determine if they're part of a PR
        return null;
    }

    return null;
  }

  /**
   * Get checks that should run for a specific event
   */
  private getChecksForEvent(eventTrigger: EventTrigger, fileContext?: FileChangeContext): string[] {
    const checksToRun: string[] = [];

    for (const [checkName, checkConfig] of Object.entries(this.config.checks || {})) {
      if (this.shouldRunCheck(checkConfig, eventTrigger, fileContext)) {
        checksToRun.push(checkName);
      }
    }

    return checksToRun;
  }

  /**
   * Determine if a specific check should run
   */
  private shouldRunCheck(
    checkConfig: CheckConfig,
    eventTrigger: EventTrigger,
    fileContext?: FileChangeContext
  ): boolean {
    // Check if event trigger matches
    if (!checkConfig.on.includes(eventTrigger)) {
      return false;
    }

    // Check file-based triggers if file context is available
    if (fileContext && checkConfig.triggers) {
      return this.matchesFilePatterns(checkConfig.triggers, fileContext);
    }

    // If no file triggers specified, run on matching events
    return true;
  }

  /**
   * Check if file changes match trigger patterns
   */
  private matchesFilePatterns(patterns: string[], fileContext: FileChangeContext): boolean {
    const allFiles = [
      ...(fileContext.changedFiles || []),
      ...(fileContext.addedFiles || []),
      ...(fileContext.modifiedFiles || []),
    ];

    return patterns.some(pattern => {
      const regex = this.convertGlobToRegex(pattern);
      return allFiles.some(file => regex.test(file));
    });
  }

  /**
   * Convert glob pattern to RegExp
   */
  private convertGlobToRegex(glob: string): RegExp {
    let regexPattern = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&'); // Escape special regex chars

    // Handle different types of glob patterns
    regexPattern = regexPattern
      .replace(/\*\*\/\*/g, '___GLOBSTAR_ALL___') // Temporarily replace **/*
      .replace(/\*\*\//g, '___GLOBSTAR_DIR___') // Temporarily replace **/
      .replace(/\/\*\*/g, '___SLASH_GLOBSTAR___') // Temporarily replace /**
      .replace(/\*\*/g, '___GLOBSTAR___') // Temporarily replace **
      .replace(/\*/g, '[^/]*') // Convert * to [^/]* (matches within directory)
      .replace(/\?/g, '.') // Convert ? to .
      .replace(/___GLOBSTAR_ALL___/g, '.*') // Convert **/* to .*
      .replace(/___GLOBSTAR_DIR___/g, '(?:.*/)?') // Convert **/ to (?:.*/)?
      .replace(/___SLASH_GLOBSTAR___/g, '(?:/.*)?') // Convert /** to (?:/.*)?
      .replace(/___GLOBSTAR___/g, '.*'); // Convert ** to .*

    // Handle brace expansion {a,b} -> (a|b)
    regexPattern = regexPattern.replace(/\\\{([^}]+)\\\}/g, (match, content) => {
      // Convert comma-separated alternatives to regex alternation
      const alternatives = content.split(',').map((alt: string) => alt.trim());
      return `(${alternatives.join('|')})`;
    });

    return new RegExp(`^${regexPattern}$`);
  }

  /**
   * Extract PR number from event context
   */
  private extractPRNumber(eventContext: GitHubEventContext): number | undefined {
    if (eventContext.pull_request) {
      return eventContext.pull_request.number;
    }

    if (eventContext.issue?.pull_request) {
      return eventContext.issue.number;
    }

    return undefined;
  }

  /**
   * Get repository name from event context
   */
  private getRepositoryName(eventContext: GitHubEventContext): string {
    if (
      eventContext.repository &&
      typeof eventContext.repository === 'object' &&
      eventContext.repository.owner &&
      typeof eventContext.repository.owner === 'object' &&
      eventContext.repository.owner.login &&
      eventContext.repository.name
    ) {
      return `${eventContext.repository.owner.login}/${eventContext.repository.name}`;
    }
    return 'unknown/repository';
  }

  /**
   * Get triggered by information
   */
  private getTriggeredBy(eventContext: GitHubEventContext): string {
    const { event_name, action } = eventContext;

    if (eventContext.comment?.user?.login) {
      return `comment_by_${eventContext.comment.user.login}`;
    }

    return action ? `${event_name}_${action}` : event_name;
  }

  /**
   * Get selective execution plan for specific checks
   */
  public getSelectiveExecution(
    eventContext: GitHubEventContext,
    requestedChecks: string[],
    fileContext?: FileChangeContext
  ): MappedExecution {
    const eventTrigger = this.mapGitHubEventToTrigger(eventContext);

    if (!eventTrigger) {
      return {
        shouldExecute: false,
        checksToRun: [],
        executionContext: {
          eventType: 'pr_opened',
          repository: this.getRepositoryName(eventContext),
          triggeredBy: 'selective_execution',
        },
      };
    }

    // Filter requested checks by what's available in config and what should run
    const validChecks = requestedChecks.filter(checkName => {
      const checkConfig = this.config.checks?.[checkName];
      return checkConfig && this.shouldRunCheck(checkConfig, eventTrigger, fileContext);
    });

    return {
      shouldExecute: validChecks.length > 0,
      checksToRun: validChecks,
      executionContext: {
        eventType: eventTrigger,
        prNumber: this.extractPRNumber(eventContext),
        repository: this.getRepositoryName(eventContext),
        triggeredBy: 'selective_execution',
      },
    };
  }

  /**
   * Check if event should trigger any executions
   */
  public shouldProcessEvent(eventContext: GitHubEventContext): boolean {
    const eventTrigger = this.mapGitHubEventToTrigger(eventContext);

    if (!eventTrigger) {
      return false;
    }

    // Check if any configured checks match this event
    return Object.values(this.config.checks || {}).some(checkConfig =>
      checkConfig.on.includes(eventTrigger)
    );
  }

  /**
   * Get available checks for display purposes
   */
  public getAvailableChecks(): Array<{
    name: string;
    description: string;
    triggers: EventTrigger[];
  }> {
    return Object.entries(this.config.checks || {}).map(([name, config]) => ({
      name,
      description: config.prompt.split('\n')[0] || 'No description available',
      triggers: config.on,
    }));
  }

  /**
   * Validate event context
   */
  public validateEventContext(eventContext: GitHubEventContext): {
    isValid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    if (!eventContext.event_name) {
      errors.push('Missing event_name in event context');
    }

    if (!eventContext.repository) {
      errors.push('Missing repository information in event context');
    }

    // For PR events, ensure PR information is present
    if (eventContext.event_name === 'pull_request' && !eventContext.pull_request) {
      errors.push('Missing pull_request information for pull_request event');
    }

    // For comment events, ensure comment and issue information is present
    if (eventContext.event_name === 'issue_comment') {
      if (!eventContext.comment) {
        errors.push('Missing comment information for issue_comment event');
      }
      if (!eventContext.issue) {
        errors.push('Missing issue information for issue_comment event');
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }
}

/**
 * Utility function to create EventMapper from config
 */
export function createEventMapper(config: VisorConfig): EventMapper {
  return new EventMapper(config);
}

/**
 * Utility function to extract file context from GitHub PR
 */
export async function extractFileContext(
  octokit: import('@octokit/rest').Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<FileChangeContext> {
  try {
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
    });

    const changedFiles: string[] = [];
    const addedFiles: string[] = [];
    const modifiedFiles: string[] = [];
    const deletedFiles: string[] = [];

    for (const file of files) {
      changedFiles.push(file.filename);

      switch (file.status) {
        case 'added':
          addedFiles.push(file.filename);
          break;
        case 'modified':
          modifiedFiles.push(file.filename);
          break;
        case 'removed':
          deletedFiles.push(file.filename);
          break;
      }
    }

    return {
      changedFiles,
      addedFiles,
      modifiedFiles,
      deletedFiles,
    };
  } catch (error) {
    console.error('Failed to extract file context:', error);
    return {};
  }
}
