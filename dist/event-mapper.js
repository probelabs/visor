"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventMapper = void 0;
exports.createEventMapper = createEventMapper;
exports.extractFileContext = extractFileContext;
/**
 * Maps GitHub events to Visor check executions based on configuration
 */
class EventMapper {
    config;
    constructor(config) {
        this.config = config;
    }
    /**
     * Map GitHub event to execution plan
     */
    mapEventToExecution(eventContext, fileContext) {
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
    mapGitHubEventToTrigger(eventContext) {
        const { event_name, action } = eventContext;
        switch (event_name) {
            case 'pull_request':
                if (action === 'opened')
                    return 'pr_opened';
                if (action === 'synchronize' || action === 'edited')
                    return 'pr_updated';
                if (action === 'closed')
                    return 'pr_closed';
                break;
            case 'issue_comment':
                // Only handle PR comments
                if (eventContext.issue?.pull_request) {
                    return 'pr_updated'; // Treat comments as PR updates
                }
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
    getChecksForEvent(eventTrigger, fileContext) {
        const checksToRun = [];
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
    shouldRunCheck(checkConfig, eventTrigger, fileContext) {
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
    matchesFilePatterns(patterns, fileContext) {
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
    convertGlobToRegex(glob) {
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
            const alternatives = content.split(',').map((alt) => alt.trim());
            return `(${alternatives.join('|')})`;
        });
        return new RegExp(`^${regexPattern}$`);
    }
    /**
     * Extract PR number from event context
     */
    extractPRNumber(eventContext) {
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
    getRepositoryName(eventContext) {
        if (eventContext.repository &&
            typeof eventContext.repository === 'object' &&
            eventContext.repository.owner &&
            typeof eventContext.repository.owner === 'object' &&
            eventContext.repository.owner.login &&
            eventContext.repository.name) {
            return `${eventContext.repository.owner.login}/${eventContext.repository.name}`;
        }
        return 'unknown/repository';
    }
    /**
     * Get triggered by information
     */
    getTriggeredBy(eventContext) {
        const { event_name, action } = eventContext;
        if (eventContext.comment?.user?.login) {
            return `comment_by_${eventContext.comment.user.login}`;
        }
        return action ? `${event_name}_${action}` : event_name;
    }
    /**
     * Get selective execution plan for specific checks
     */
    getSelectiveExecution(eventContext, requestedChecks, fileContext) {
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
    shouldProcessEvent(eventContext) {
        const eventTrigger = this.mapGitHubEventToTrigger(eventContext);
        if (!eventTrigger) {
            return false;
        }
        // Check if any configured checks match this event
        return Object.values(this.config.checks || {}).some(checkConfig => checkConfig.on.includes(eventTrigger));
    }
    /**
     * Get available checks for display purposes
     */
    getAvailableChecks() {
        return Object.entries(this.config.checks || {}).map(([name, config]) => ({
            name,
            description: config.prompt.split('\n')[0] || 'No description available',
            triggers: config.on,
        }));
    }
    /**
     * Validate event context
     */
    validateEventContext(eventContext) {
        const errors = [];
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
exports.EventMapper = EventMapper;
/**
 * Utility function to create EventMapper from config
 */
function createEventMapper(config) {
    return new EventMapper(config);
}
/**
 * Utility function to extract file context from GitHub PR
 */
async function extractFileContext(octokit, owner, repo, prNumber) {
    try {
        const { data: files } = await octokit.rest.pulls.listFiles({
            owner,
            repo,
            pull_number: prNumber,
        });
        const changedFiles = [];
        const addedFiles = [];
        const modifiedFiles = [];
        const deletedFiles = [];
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
    }
    catch (error) {
        console.error('Failed to extract file context:', error);
        return {};
    }
}
//# sourceMappingURL=event-mapper.js.map