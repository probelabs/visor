"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitRepositoryAnalyzer = void 0;
const simple_git_1 = require("simple-git");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
class GitRepositoryAnalyzer {
    git;
    cwd;
    constructor(workingDirectory = process.cwd()) {
        this.cwd = workingDirectory;
        this.git = (0, simple_git_1.simpleGit)(workingDirectory);
    }
    /**
     * Analyze the current git repository state and return data compatible with PRInfo interface
     */
    async analyzeRepository() {
        // Check if we're in a git repository
        const isRepo = await this.isGitRepository();
        if (!isRepo) {
            return this.createEmptyRepositoryInfo('Not a git repository');
        }
        try {
            // Get current branch and status
            const [status, currentBranch] = await Promise.all([
                this.git.status(),
                this.getCurrentBranch(),
            ]);
            // Get uncommitted changes
            const uncommittedFiles = await this.getUncommittedChanges();
            // Get recent commit info
            const recentCommits = await this.git.log({ maxCount: 1 });
            const lastCommit = recentCommits.latest;
            // Create repository info
            const repositoryInfo = {
                title: this.generateTitle(status, currentBranch),
                body: this.generateDescription(status, lastCommit),
                author: lastCommit?.author_name || 'unknown',
                base: await this.getBaseBranch(),
                head: currentBranch,
                files: uncommittedFiles,
                totalAdditions: uncommittedFiles.reduce((sum, file) => sum + file.additions, 0),
                totalDeletions: uncommittedFiles.reduce((sum, file) => sum + file.deletions, 0),
                isGitRepository: true,
                workingDirectory: this.cwd,
            };
            return repositoryInfo;
        }
        catch (error) {
            console.error('Error analyzing git repository:', error);
            return this.createEmptyRepositoryInfo('Error analyzing git repository');
        }
    }
    /**
     * Convert GitRepositoryInfo to PRInfo format for compatibility with existing PRReviewer
     */
    toPRInfo(repositoryInfo) {
        return {
            number: 0, // Local analysis doesn't have PR number
            title: repositoryInfo.title,
            body: repositoryInfo.body,
            author: repositoryInfo.author,
            base: repositoryInfo.base,
            head: repositoryInfo.head,
            files: repositoryInfo.files.map((file) => ({
                filename: file.filename,
                additions: file.additions,
                deletions: file.deletions,
                changes: file.changes,
                patch: file.patch,
                status: file.status,
            })),
            totalAdditions: repositoryInfo.totalAdditions,
            totalDeletions: repositoryInfo.totalDeletions,
        };
    }
    async isGitRepository() {
        try {
            await this.git.checkIsRepo();
            return true;
        }
        catch {
            return false;
        }
    }
    async getCurrentBranch() {
        try {
            const branchSummary = await this.git.branch();
            return branchSummary.current || 'unknown';
        }
        catch {
            return 'unknown';
        }
    }
    async getBaseBranch() {
        try {
            // Try to get the default branch from remote
            const branches = await this.git.branch(['-r']);
            const mainBranches = ['origin/main', 'origin/master', 'origin/develop'];
            for (const mainBranch of mainBranches) {
                if (branches.all.includes(mainBranch)) {
                    return mainBranch.replace('origin/', '');
                }
            }
            // Fallback to main/master
            return 'main';
        }
        catch {
            return 'main';
        }
    }
    async getRemoteInfo() {
        try {
            const remotes = await this.git.getRemotes(true);
            const origin = remotes.find(r => r.name === 'origin');
            return origin
                ? { name: origin.name, url: origin.refs.fetch || origin.refs.push || '' }
                : null;
        }
        catch {
            return null;
        }
    }
    async getUncommittedChanges() {
        try {
            const status = await this.git.status();
            const changes = [];
            // Process different types of changes
            const fileChanges = [
                ...status.created.map(f => ({ file: f, status: 'added' })),
                ...status.deleted.map(f => ({ file: f, status: 'removed' })),
                ...status.modified.map(f => ({ file: f, status: 'modified' })),
                ...status.renamed.map(f => ({
                    file: typeof f === 'string' ? f : f.to || f.from,
                    status: 'renamed',
                })),
            ];
            for (const { file, status } of fileChanges) {
                const filePath = path.join(this.cwd, file);
                const fileChange = await this.analyzeFileChange(file, status, filePath);
                changes.push(fileChange);
            }
            return changes;
        }
        catch (error) {
            console.error('Error getting uncommitted changes:', error);
            return [];
        }
    }
    async analyzeFileChange(filename, status, filePath) {
        let additions = 0;
        let deletions = 0;
        let patch;
        let content;
        try {
            // Get diff for the file if it exists and is not binary
            if (status !== 'added' && fs.existsSync(filePath)) {
                const diff = await this.git.diff(['--', filename]).catch(() => '');
                if (diff) {
                    patch = diff;
                    // Count additions and deletions from diff
                    const lines = diff.split('\n');
                    additions = lines.filter(line => line.startsWith('+')).length;
                    deletions = lines.filter(line => line.startsWith('-')).length;
                }
            }
            // For added files, count lines as additions
            if (status === 'added' && fs.existsSync(filePath)) {
                try {
                    const stats = fs.statSync(filePath);
                    if (stats.isFile() && stats.size < 1024 * 1024) {
                        // Skip files larger than 1MB
                        content = fs.readFileSync(filePath, 'utf8');
                        additions = content.split('\n').length;
                        patch = content; // For new files, the entire content is the "patch"
                    }
                }
                catch {
                    // Skip binary or unreadable files
                }
            }
            // For removed files, we can't easily count the lines without the previous version
            if (status === 'removed') {
                deletions = 1; // Placeholder - in real git we'd need the previous version
            }
        }
        catch (error) {
            console.error(`Error analyzing file change for ${filename}:`, error);
        }
        return {
            filename,
            status,
            additions,
            deletions,
            changes: additions + deletions,
            content,
            patch,
        };
    }
    generateTitle(status, branch) {
        if (status.files.length === 0) {
            return `Local Analysis: ${branch} (No changes)`;
        }
        const changeTypes = [];
        if (status.created.length > 0)
            changeTypes.push(`${status.created.length} added`);
        if (status.modified.length > 0)
            changeTypes.push(`${status.modified.length} modified`);
        if (status.deleted.length > 0)
            changeTypes.push(`${status.deleted.length} deleted`);
        if (status.renamed.length > 0)
            changeTypes.push(`${status.renamed.length} renamed`);
        return `Local Analysis: ${branch} (${changeTypes.join(', ')})`;
    }
    generateDescription(status, lastCommit) {
        let description = `Analysis of local git repository working directory.\n\n`;
        if (lastCommit) {
            description += `**Last Commit:** ${lastCommit.message}\n`;
            description += `**Author:** ${lastCommit.author_name} <${lastCommit.author_email}>\n`;
            description += `**Date:** ${lastCommit.date}\n\n`;
        }
        if (status.files.length === 0) {
            description += `**Status:** Working directory is clean - no uncommitted changes found.\n`;
        }
        else {
            description += `**Changes Summary:**\n`;
            description += `- Files to be committed: ${status.staged.length}\n`;
            description += `- Modified files: ${status.modified.length}\n`;
            description += `- Untracked files: ${status.not_added.length}\n`;
            if (status.conflicted.length > 0) {
                description += `- Conflicted files: ${status.conflicted.length}\n`;
            }
        }
        return description;
    }
    createEmptyRepositoryInfo(reason) {
        return {
            title: `Local Analysis: ${reason}`,
            body: `Unable to analyze repository: ${reason}`,
            author: 'system',
            base: 'main',
            head: 'HEAD',
            files: [],
            totalAdditions: 0,
            totalDeletions: 0,
            isGitRepository: false,
            workingDirectory: this.cwd,
        };
    }
}
exports.GitRepositoryAnalyzer = GitRepositoryAnalyzer;
//# sourceMappingURL=git-repository-analyzer.js.map