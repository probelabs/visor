import "./chunk-WMJKH4XE.mjs";

// src/git-repository-analyzer.ts
import { simpleGit } from "simple-git";
import * as path2 from "path";
import * as fs2 from "fs";

// src/utils/file-exclusion.ts
import ignore from "ignore";
import * as fs from "fs";
import * as path from "path";
var DEFAULT_EXCLUSION_PATTERNS = [
  "dist/",
  "build/",
  ".next/",
  "out/",
  "node_modules/",
  "coverage/",
  ".turbo/",
  "bundled/"
];
var FileExclusionHelper = class {
  gitignore = null;
  workingDirectory;
  /**
   * @param workingDirectory - Directory to search for .gitignore
   * @param additionalPatterns - Additional patterns to include (optional, defaults to common build artifacts)
   */
  constructor(workingDirectory = process.cwd(), additionalPatterns = DEFAULT_EXCLUSION_PATTERNS) {
    const normalizedPath = path.resolve(workingDirectory);
    if (normalizedPath.includes("\0")) {
      throw new Error("Invalid workingDirectory: contains null bytes");
    }
    this.workingDirectory = normalizedPath;
    this.loadGitignore(additionalPatterns);
  }
  /**
   * Load .gitignore patterns from the working directory (called once in constructor)
   * @param additionalPatterns - Additional patterns to add to gitignore rules
   */
  loadGitignore(additionalPatterns) {
    const gitignorePath = path.resolve(this.workingDirectory, ".gitignore");
    const resolvedWorkingDir = path.resolve(this.workingDirectory);
    try {
      const relativePath = path.relative(resolvedWorkingDir, gitignorePath);
      if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        throw new Error("Invalid gitignore path: path traversal detected");
      }
      if (relativePath !== ".gitignore") {
        throw new Error("Invalid gitignore path: must be .gitignore in working directory");
      }
      this.gitignore = ignore();
      if (additionalPatterns && additionalPatterns.length > 0) {
        this.gitignore.add(additionalPatterns);
      }
      if (fs.existsSync(gitignorePath)) {
        const rawContent = fs.readFileSync(gitignorePath, "utf8");
        const gitignoreContent = rawContent.replace(/[\r\n]+/g, "\n").replace(/[\x00-\x09\x0B-\x1F\x7F]/g, "").split("\n").filter((line) => line.length < 1e3).join("\n").trim();
        this.gitignore.add(gitignoreContent);
        if (process.env.VISOR_DEBUG === "true") {
          console.error("\u2705 Loaded .gitignore patterns for file filtering");
        }
      } else if (additionalPatterns && additionalPatterns.length > 0) {
        console.error("No .gitignore found, using default exclusion patterns");
        console.warn("No .gitignore found, using default exclusion patterns");
      }
    } catch (error) {
      console.warn("Failed to load .gitignore:", error instanceof Error ? error.message : error);
    }
  }
  /**
   * Check if a file should be excluded based on .gitignore patterns
   */
  shouldExcludeFile(filename) {
    if (this.gitignore) {
      return this.gitignore.ignores(filename);
    }
    return false;
  }
};

// src/git-repository-analyzer.ts
var MAX_PATCH_SIZE = 50 * 1024;
var GitRepositoryAnalyzer = class {
  git;
  cwd;
  fileExclusionHelper;
  constructor(workingDirectory = process.cwd()) {
    this.cwd = workingDirectory;
    this.git = simpleGit(workingDirectory);
    this.fileExclusionHelper = new FileExclusionHelper(workingDirectory);
  }
  /**
   * Analyze the current git repository state and return data compatible with PRInfo interface
   */
  async analyzeRepository(includeContext = true, enableBranchDiff = false) {
    const isRepo = await this.isGitRepository();
    if (!isRepo) {
      return this.createEmptyRepositoryInfo("Not a git repository");
    }
    try {
      const [status, currentBranch, baseBranch] = await Promise.all([
        this.git.status(),
        this.getCurrentBranch(),
        this.getBaseBranch()
      ]);
      const isFeatureBranch = currentBranch !== baseBranch && currentBranch !== "main" && currentBranch !== "master";
      let uncommittedFiles = await this.getUncommittedChanges(includeContext);
      if (isFeatureBranch && includeContext && enableBranchDiff) {
        if (uncommittedFiles.length > 0) {
          console.error(`\u{1F4CA} Feature branch detected: ${currentBranch}`);
          console.error(
            `\u26A0\uFE0F  Ignoring ${uncommittedFiles.length} uncommitted file(s) due to --analyze-branch-diff flag`
          );
        } else {
          console.error(`\u{1F4CA} Feature branch detected: ${currentBranch}`);
        }
        console.error(
          `\u{1F4C2} Analyzing diff vs ${baseBranch} (${uncommittedFiles.length > 0 ? "forced by --analyze-branch-diff" : "auto-enabled for code-review schemas"})`
        );
        uncommittedFiles = await this.getBranchDiff(baseBranch, includeContext);
      } else if (uncommittedFiles.length > 0) {
        console.error(`\u{1F4DD} Analyzing uncommitted changes (${uncommittedFiles.length} files)`);
      }
      let lastCommit = null;
      try {
        const recentCommits = await this.git.log({ maxCount: 1 });
        lastCommit = recentCommits.latest;
      } catch {
        console.error("\u{1F4DD} Repository has no commits yet, analyzing uncommitted changes");
      }
      let author = lastCommit?.author_name;
      if (!author) {
        try {
          const [userName, userEmail] = await Promise.all([
            this.git.raw(["config", "--local", "user.name"]).catch(() => null),
            this.git.raw(["config", "--local", "user.email"]).catch(() => null)
          ]);
          author = userName?.trim() || userEmail?.trim() || "unknown";
        } catch {
          author = "unknown";
        }
      }
      const repositoryInfo = {
        title: this.generateTitle(status, currentBranch),
        body: this.generateDescription(status, lastCommit),
        author,
        base: baseBranch,
        head: currentBranch,
        files: uncommittedFiles,
        totalAdditions: uncommittedFiles.reduce((sum, file) => sum + file.additions, 0),
        totalDeletions: uncommittedFiles.reduce((sum, file) => sum + file.deletions, 0),
        isGitRepository: true,
        workingDirectory: this.cwd
      };
      return repositoryInfo;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      console.error("Error analyzing git repository:", errorMessage);
      return this.createEmptyRepositoryInfo("Error analyzing git repository");
    }
  }
  /**
   * Convert GitRepositoryInfo to PRInfo format for compatibility with existing PRReviewer
   */
  toPRInfo(repositoryInfo, includeContext = true) {
    const files = repositoryInfo.files.map(
      (file) => ({
        filename: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        patch: includeContext ? file.patch : void 0,
        status: file.status
      })
    );
    let fullDiff;
    if (includeContext) {
      fullDiff = files.filter((file) => file.patch).map((file) => `--- ${file.filename}
${file.patch}`).join("\n\n");
    }
    return {
      number: 0,
      // Local analysis doesn't have PR number
      title: repositoryInfo.title,
      body: repositoryInfo.body,
      author: repositoryInfo.author,
      base: repositoryInfo.base,
      head: repositoryInfo.head,
      files,
      totalAdditions: repositoryInfo.totalAdditions,
      totalDeletions: repositoryInfo.totalDeletions,
      fullDiff
    };
  }
  async isGitRepository() {
    try {
      await this.git.checkIsRepo();
      return true;
    } catch {
      return false;
    }
  }
  async getCurrentBranch() {
    try {
      const branchSummary = await this.git.branch();
      return branchSummary.current || "unknown";
    } catch {
      return "unknown";
    }
  }
  async getBaseBranch() {
    try {
      const branches = await this.git.branch(["-r"]);
      const mainBranches = ["origin/main", "origin/master", "origin/develop"];
      for (const mainBranch of mainBranches) {
        if (branches.all.includes(mainBranch)) {
          return mainBranch.replace("origin/", "");
        }
      }
      return "main";
    } catch {
      return "main";
    }
  }
  /**
   * Truncate a patch if it exceeds MAX_PATCH_SIZE
   */
  truncatePatch(patch, filename) {
    const patchSize = Buffer.byteLength(patch, "utf8");
    if (patchSize <= MAX_PATCH_SIZE) {
      return { patch, truncated: false };
    }
    const truncated = patch.substring(0, MAX_PATCH_SIZE);
    const truncatedPatch = `${truncated}

... [TRUNCATED: Diff too large (${(patchSize / 1024).toFixed(1)}KB), showing first ${(MAX_PATCH_SIZE / 1024).toFixed(0)}KB] ...`;
    console.error(
      `\u26A0\uFE0F  Truncated diff for ${filename} (${(patchSize / 1024).toFixed(1)}KB \u2192 ${(MAX_PATCH_SIZE / 1024).toFixed(0)}KB)`
    );
    return { patch: truncatedPatch, truncated: true };
  }
  async getRemoteInfo() {
    try {
      const remotes = await this.git.getRemotes(true);
      const origin = remotes.find((r) => r.name === "origin");
      return origin ? { name: origin.name, url: origin.refs.fetch || origin.refs.push || "" } : null;
    } catch {
      return null;
    }
  }
  async getUncommittedChanges(includeContext = true) {
    try {
      const status = await this.git.status();
      const changes = [];
      const fileChanges = [
        ...status.created.map((f) => ({ file: f, status: "added" })),
        ...status.deleted.map((f) => ({ file: f, status: "removed" })),
        ...status.modified.map((f) => ({ file: f, status: "modified" })),
        ...status.renamed.map((f) => ({
          file: typeof f === "string" ? f : f.to || f.from,
          status: "renamed"
        }))
      ];
      for (const { file, status: status2 } of fileChanges) {
        if (this.fileExclusionHelper.shouldExcludeFile(file)) {
          console.error(`\u23ED\uFE0F  Skipping excluded file: ${file}`);
          continue;
        }
        const filePath = path2.join(this.cwd, file);
        const fileChange = await this.analyzeFileChange(file, status2, filePath, includeContext);
        changes.push(fileChange);
      }
      return changes;
    } catch (error) {
      console.error("Error getting uncommitted changes:", error);
      return [];
    }
  }
  /**
   * Get diff between current branch and base branch (for feature branch analysis)
   */
  async getBranchDiff(baseBranch, includeContext = true) {
    try {
      const diffSummary = await this.git.diffSummary([baseBranch]);
      const changes = [];
      if (!diffSummary || !diffSummary.files) {
        return [];
      }
      for (const file of diffSummary.files) {
        if (this.fileExclusionHelper.shouldExcludeFile(file.file)) {
          console.error(`\u23ED\uFE0F  Skipping excluded file: ${file.file}`);
          continue;
        }
        const isBinary = "binary" in file && file.binary;
        const insertions = "insertions" in file ? file.insertions : 0;
        const deletions = "deletions" in file ? file.deletions : 0;
        const fileChanges = "changes" in file ? file.changes : 0;
        let status;
        if (isBinary) {
          status = "modified";
        } else if (insertions > 0 && deletions === 0) {
          status = "added";
        } else if (insertions === 0 && deletions > 0) {
          status = "removed";
        } else {
          status = "modified";
        }
        let patch;
        let truncated = false;
        if (includeContext && !isBinary) {
          try {
            const rawPatch = await this.git.diff([baseBranch, "--", file.file]);
            if (rawPatch) {
              const result = this.truncatePatch(rawPatch, file.file);
              patch = result.patch;
              truncated = result.truncated;
            }
          } catch {
          }
        }
        const fileChange = {
          filename: file.file,
          additions: insertions,
          deletions,
          changes: fileChanges,
          status,
          patch,
          truncated
        };
        changes.push(fileChange);
      }
      return changes;
    } catch (error) {
      console.error("Error getting branch diff:", error);
      return [];
    }
  }
  async analyzeFileChange(filename, status, filePath, includeContext = true) {
    let additions = 0;
    let deletions = 0;
    let patch;
    let content;
    let truncated = false;
    try {
      if (includeContext && status !== "added" && fs2.existsSync(filePath)) {
        const diff = await this.git.diff(["--", filename]).catch(() => "");
        if (diff) {
          const result = this.truncatePatch(diff, filename);
          patch = result.patch;
          truncated = result.truncated;
          const lines = diff.split("\n");
          additions = lines.filter((line) => line.startsWith("+")).length;
          deletions = lines.filter((line) => line.startsWith("-")).length;
        }
      } else if (status !== "added" && fs2.existsSync(filePath)) {
        const diff = await this.git.diff(["--", filename]).catch(() => "");
        if (diff) {
          const lines = diff.split("\n");
          additions = lines.filter((line) => line.startsWith("+")).length;
          deletions = lines.filter((line) => line.startsWith("-")).length;
        }
      }
      if (status === "added" && fs2.existsSync(filePath)) {
        try {
          const stats = fs2.statSync(filePath);
          if (stats.isFile() && stats.size < 1024 * 1024) {
            if (includeContext) {
              content = fs2.readFileSync(filePath, "utf8");
              const result = this.truncatePatch(content, filename);
              patch = result.patch;
              truncated = result.truncated;
            }
            const fileContent = includeContext ? content : fs2.readFileSync(filePath, "utf8");
            additions = fileContent.split("\n").length;
          }
        } catch {
        }
      }
      if (status === "removed") {
        deletions = 1;
      }
    } catch (error) {
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
      truncated
    };
  }
  generateTitle(status, branch) {
    if (status.files.length === 0) {
      return `Local Analysis: ${branch} (No changes)`;
    }
    const changeTypes = [];
    if (status.created.length > 0) changeTypes.push(`${status.created.length} added`);
    if (status.modified.length > 0) changeTypes.push(`${status.modified.length} modified`);
    if (status.deleted.length > 0) changeTypes.push(`${status.deleted.length} deleted`);
    if (status.renamed.length > 0) changeTypes.push(`${status.renamed.length} renamed`);
    return `Local Analysis: ${branch} (${changeTypes.join(", ")})`;
  }
  generateDescription(status, lastCommit) {
    let description = `Analysis of local git repository working directory.

`;
    if (lastCommit) {
      description += `**Last Commit:** ${lastCommit.message}
`;
      description += `**Author:** ${lastCommit.author_name} <${lastCommit.author_email}>
`;
      description += `**Date:** ${lastCommit.date}

`;
    }
    if (status.files.length === 0) {
      description += `**Status:** Working directory is clean - no uncommitted changes found.
`;
    } else {
      description += `**Changes Summary:**
`;
      description += `- Files to be committed: ${status.staged.length}
`;
      description += `- Modified files: ${status.modified.length}
`;
      description += `- Untracked files: ${status.not_added.length}
`;
      if (status.conflicted.length > 0) {
        description += `- Conflicted files: ${status.conflicted.length}
`;
      }
    }
    return description;
  }
  createEmptyRepositoryInfo(reason) {
    return {
      title: `Local Analysis: ${reason}`,
      body: `Unable to analyze repository: ${reason}`,
      author: "system",
      base: "main",
      head: "HEAD",
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      isGitRepository: false,
      workingDirectory: this.cwd
    };
  }
};
export {
  GitRepositoryAnalyzer
};
//# sourceMappingURL=git-repository-analyzer-HJC4MYW4.mjs.map