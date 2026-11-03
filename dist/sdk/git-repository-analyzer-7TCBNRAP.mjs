import {
  __esm
} from "./chunk-J7LXIPZS.mjs";

// src/utils/file-exclusion.ts
import ignore from "ignore";
import * as fs from "fs";
import * as path from "path";
var DEFAULT_EXCLUSION_PATTERNS, FileExclusionHelper;
var init_file_exclusion = __esm({
  "src/utils/file-exclusion.ts"() {
    "use strict";
    DEFAULT_EXCLUSION_PATTERNS = [
      "dist/",
      "build/",
      ".next/",
      "out/",
      "node_modules/",
      "coverage/",
      ".turbo/",
      "bundled/"
    ];
    FileExclusionHelper = class {
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
  }
});

// src/git-repository-analyzer.ts
import { simpleGit } from "simple-git";
import * as path2 from "path";
import * as fs2 from "fs";
function resolveLocalDiffSelection(opts) {
  if (opts.analyzeBranchDiff && opts.uncommitted) {
    throw new Error("--uncommitted and --analyze-branch-diff are mutually exclusive");
  }
  if (opts.debugServer && opts.uncommitted) {
    throw new Error("--uncommitted cannot be used with --debug-server (it skips diff analysis)");
  }
  if (opts.debugServer) return { enableBranchDiff: false, diffMode: "auto" };
  if (opts.uncommitted) return { enableBranchDiff: false, diffMode: "uncommitted" };
  if (opts.analyzeBranchDiff) return { enableBranchDiff: true, diffMode: "branch" };
  return { enableBranchDiff: opts.hasCodeReviewSchema, diffMode: "auto" };
}
function applyPrContextOverrides(info, overrides) {
  if (overrides.prBody !== void 0 && overrides.prBodyFile !== void 0) {
    throw new Error("--pr-body and --pr-body-file are mutually exclusive");
  }
  let body = overrides.prBody;
  if (overrides.prBodyFile !== void 0) {
    try {
      body = fs2.readFileSync(overrides.prBodyFile, "utf8");
    } catch (error) {
      throw new Error(
        `Cannot read --pr-body-file ${overrides.prBodyFile}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return {
    ...info,
    title: overrides.prTitle !== void 0 ? overrides.prTitle : info.title,
    body: body !== void 0 ? body : info.body
  };
}
var MAX_PATCH_SIZE, MAX_UNTRACKED_FILE_SIZE, UNTRACKED_EXCLUDED_DIRS, SECRET_FILE_NAMES, SECRET_DIRS, GitRepositoryAnalyzer;
var init_git_repository_analyzer = __esm({
  "src/git-repository-analyzer.ts"() {
    init_file_exclusion();
    MAX_PATCH_SIZE = 50 * 1024;
    MAX_UNTRACKED_FILE_SIZE = 1024 * 1024;
    UNTRACKED_EXCLUDED_DIRS = /* @__PURE__ */ new Set(["vendor", ".venv", "venv", "target", "__pycache__"]);
    SECRET_FILE_NAMES = /* @__PURE__ */ new Set([
      "id_rsa",
      "id_dsa",
      "id_ecdsa",
      "id_ed25519",
      "credentials.json",
      ".envrc",
      ".netrc",
      ".npmrc",
      ".pypirc",
      ".pgpass",
      ".git-credentials"
    ]);
    SECRET_DIRS = /* @__PURE__ */ new Set([".aws", ".ssh", ".gnupg"]);
    GitRepositoryAnalyzer = class {
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
      async analyzeRepository(includeContext = true, enableBranchDiff = false, options = {}) {
        const isRepo = await this.isGitRepository();
        if (!isRepo) {
          return this.createEmptyRepositoryInfo("Not a git repository");
        }
        try {
          const explicitBase = options.baseBranch?.trim() || void 0;
          const [status, currentBranch, baseBranch] = await Promise.all([
            this.git.status(),
            this.getCurrentBranch(),
            explicitBase ? Promise.resolve(explicitBase) : this.getBaseBranch()
          ]);
          const isFeatureBranch = currentBranch !== baseBranch && (explicitBase !== void 0 || currentBranch !== "main" && currentBranch !== "master");
          const diffMode = options.diffMode ?? (enableBranchDiff ? "branch" : "auto");
          const forceBranchDiff = diffMode === "branch";
          const branchDiffAllowed = diffMode !== "uncommitted" && (enableBranchDiff || forceBranchDiff);
          const includeUntracked = diffMode === "uncommitted" || options.includeUntracked === true;
          let tracked = [];
          let untracked = [];
          try {
            ({ tracked, untracked } = await this.listWorkingTreeChanges(
              includeUntracked,
              options.outputFile
            ));
          } catch (error) {
            console.error("Error getting uncommitted changes:", error);
          }
          const useBranchDiff = isFeatureBranch && includeContext && branchDiffAllowed && (forceBranchDiff || tracked.length === 0);
          let files = [];
          let diffSource = "uncommitted";
          let untrackedReviewed = 0;
          if (useBranchDiff) {
            console.error(`\u{1F4CA} Feature branch detected: ${currentBranch}`);
            if (untracked.length > 0) {
              console.error(
                `\u26A0\uFE0F  Not including ${untracked.length} untracked file(s): a branch diff covers tracked files only (tracked uncommitted edits stay in it)`
              );
            }
            console.error(
              `\u{1F4C2} Analyzing diff vs ${baseBranch} (${forceBranchDiff ? "forced by --analyze-branch-diff" : "auto: no tracked uncommitted changes on a feature branch"})`
            );
            files = await this.getBranchDiff(baseBranch, includeContext, options.outputFile);
            diffSource = "branch";
          } else if (tracked.length > 0 || diffMode === "uncommitted") {
            const entries = [...tracked, ...untracked];
            untrackedReviewed = untracked.length;
            files = await this.analyzeWorkingTreeEntries(entries, includeContext);
            let reason = "";
            if (diffMode === "uncommitted") {
              reason = " (forced by --uncommitted)";
            } else if (isFeatureBranch && includeContext && branchDiffAllowed) {
              reason = " (auto: tracked uncommitted changes present; pass --analyze-branch-diff to review the branch diff instead)";
            }
            if (files.length > 0) {
              const breakdown = untracked.length > 0 ? `: ${tracked.length} tracked, ${untracked.length} untracked` : "";
              console.error(
                `\u{1F4DD} Analyzing uncommitted changes (${files.length} files${breakdown})${reason}`
              );
            } else {
              console.error("\u{1F4DD} No uncommitted changes to analyze (--uncommitted)");
            }
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
            title: this.generateTitle(currentBranch, files, diffSource, baseBranch, untrackedReviewed),
            body: this.generateDescription(status, lastCommit),
            author,
            base: baseBranch,
            head: currentBranch,
            files,
            totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
            totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
            isGitRepository: true,
            workingDirectory: this.cwd,
            diffSource
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
      /**
       * Paths Visor itself writes into the working directory before (or while) it analyzes
       * it: its state dir `.visor/` (config snapshot DB + WAL, schedules, tasks, worktrees,
       * snapshots), run traces (VISOR_TRACE_DIR, default `output/traces`), the fallback trace
       * file, and this run's `--output-file`. They are never review input, whether or not the
       * user's .gitignore covers them.
       */
      visorOwnedMatcher(outputFile) {
        const cwd = path2.resolve(this.cwd);
        const dirs = [];
        const files = [];
        const traceFileDirs = [];
        const addDir = (dir) => {
          if (!dir) return;
          const abs = path2.resolve(cwd, dir);
          if (abs === cwd || cwd.startsWith(abs + path2.sep)) return;
          dirs.push(abs);
        };
        addDir(".visor");
        addDir(process.env.VISOR_SNAPSHOT_DIR);
        addDir(process.env.VISOR_WORKTREE_PATH);
        addDir(process.env.VISOR_TRACE_DIR || path2.join("output", "traces"));
        const fallbackTrace = process.env.VISOR_FALLBACK_TRACE_FILE;
        if (fallbackTrace) {
          files.push(path2.resolve(cwd, fallbackTrace));
          traceFileDirs.push(path2.dirname(path2.resolve(cwd, fallbackTrace)));
        }
        if (outputFile) files.push(path2.resolve(cwd, outputFile));
        return (file) => {
          const abs = path2.resolve(cwd, file);
          return files.includes(abs) || dirs.some((dir) => abs === dir || abs.startsWith(dir + path2.sep)) || abs.endsWith(".ndjson") && traceFileDirs.includes(path2.dirname(abs));
        };
      }
      /**
       * Why an untracked file must not be read into a review (or count as uncommitted work),
       * or null when it may. Untracked files have never been looked at by git, so on top of
       * .gitignore + FileExclusionHelper they also skip dependency/build dirs, a root
       * `output/` dir (`--output-file` targets), secret-looking names, binaries and big files.
       */
      untrackedSkipReason(file) {
        const segments = file.split("/");
        const dirSegments = segments.slice(0, -1);
        const base = segments[segments.length - 1];
        if (dirSegments.some((seg) => UNTRACKED_EXCLUDED_DIRS.has(seg)) || segments.length > 1 && segments[0] === "output") {
          return "dependency/build/output dir";
        }
        if (base === ".env" || base.startsWith(".env.") || base.endsWith(".pem") || base.endsWith(".key") || SECRET_FILE_NAMES.has(base) || dirSegments.some((seg) => SECRET_DIRS.has(seg))) {
          return "secret-looking name";
        }
        try {
          const filePath = path2.join(this.cwd, file);
          const stats = fs2.lstatSync(filePath);
          if (!stats.isFile()) return "not a regular file";
          if (stats.size >= MAX_UNTRACKED_FILE_SIZE) return "too large";
          const fd = fs2.openSync(filePath, "r");
          try {
            const head = Buffer.alloc(Math.min(stats.size, 8e3));
            fs2.readSync(fd, head, 0, head.length, 0);
            if (head.includes(0)) return "binary";
          } finally {
            fs2.closeSync(fd);
          }
        } catch {
          return "unreadable";
        }
        return null;
      }
      /**
       * List the working-tree changes, split into tracked (staged/unstaged edits, deletes,
       * renames, staged new files) and untracked files. Visor-owned paths are dropped from
       * both; untracked files are additionally screened by untrackedSkipReason().
       */
      async listWorkingTreeChanges(includeUntracked, outputFile) {
        const status = await this.git.status();
        const isVisorOwned = this.visorOwnedMatcher(outputFile);
        const skipped = /* @__PURE__ */ new Map();
        const skip = (reason) => skipped.set(reason, (skipped.get(reason) || 0) + 1);
        const keep = (file) => {
          if (isVisorOwned(file)) {
            skip("Visor state/output");
            return false;
          }
          if (this.fileExclusionHelper.shouldExcludeFile(file)) {
            console.error(`\u23ED\uFE0F  Skipping excluded file: ${file}`);
            return false;
          }
          return true;
        };
        const byFile = /* @__PURE__ */ new Map();
        const add = (entry) => {
          if (!byFile.has(entry.file)) byFile.set(entry.file, entry);
        };
        for (const f of status.renamed) {
          if (typeof f === "string") add({ file: f, status: "renamed" });
          else add({ file: f.to || f.from, from: f.to ? f.from : void 0, status: "renamed" });
        }
        status.created.forEach((f) => add({ file: f, status: "added" }));
        status.deleted.forEach((f) => add({ file: f, status: "removed" }));
        status.modified.forEach((f) => add({ file: f, status: "modified" }));
        const tracked = [...byFile.values()].filter((entry) => keep(entry.file));
        const untracked = [];
        if (includeUntracked) {
          for (const file of status.not_added || []) {
            if (!keep(file)) continue;
            const reason = this.untrackedSkipReason(file);
            if (reason) {
              skip(reason);
              continue;
            }
            untracked.push({ file, status: "added", untracked: true });
          }
        }
        if (skipped.size > 0) {
          const total = [...skipped.values()].reduce((a, b) => a + b, 0);
          const detail = [...skipped.entries()].map(([reason, n]) => `${n} ${reason}`).join(", ");
          console.error(`\u23ED\uFE0F  Not reviewing ${total} working-tree file(s): ${detail}`);
        }
        return { tracked, untracked };
      }
      async analyzeWorkingTreeEntries(entries, includeContext) {
        const hasHead = await this.hasHeadCommit();
        const changes = [];
        for (const entry of entries) {
          if (hasHead && !entry.untracked) {
            changes.push(await this.analyzeTrackedChangeVsHead(entry, includeContext));
          } else {
            const filePath = path2.join(this.cwd, entry.file);
            changes.push(
              await this.analyzeFileChange(entry.file, entry.status, filePath, includeContext)
            );
          }
        }
        return changes;
      }
      async hasHeadCommit() {
        try {
          const out = await this.git.raw(["rev-parse", "--verify", "--quiet", "HEAD"]);
          return typeof out === "string" && out.trim().length > 0;
        } catch {
          return false;
        }
      }
      /**
       * The uncommitted delta of one tracked path: `git diff HEAD` (staged + unstaged), with
       * rename detection across the old and new path. Works for paths that no longer exist.
       */
      async analyzeTrackedChangeVsHead(entry, includeContext) {
        const pathspec = entry.from ? [entry.from, entry.file] : [entry.file];
        let raw = "";
        try {
          raw = await this.git.diff(["--no-color", "--no-ext-diff", "-M", "HEAD", "--", ...pathspec]);
        } catch (error) {
          console.error(`Error diffing ${entry.file} against HEAD:`, error);
        }
        raw = raw || "";
        let additions = 0;
        let deletions = 0;
        for (const line of raw.split("\n")) {
          if (line.startsWith("+") && !line.startsWith("+++")) additions++;
          else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
        }
        let patch;
        let truncated = false;
        if (includeContext && raw) {
          const result = this.truncatePatch(raw, entry.file);
          patch = result.patch;
          truncated = result.truncated;
        }
        return {
          filename: entry.file,
          status: entry.status,
          additions,
          deletions,
          changes: additions + deletions,
          patch,
          truncated
        };
      }
      /**
       * Get diff between current branch and base branch (for feature branch analysis)
       */
      /**
       * Resolve the base branch ref to a revision that exists locally.
       * In CI (shallow clones), the local branch may not exist, so we try:
       *   1. The branch name as-is (e.g. "main")
       *   2. The remote-tracking ref (e.g. "origin/main")
       *   3. Fetch from origin then retry
       */
      async resolveBaseBranchRef(baseBranch) {
        try {
          await this.git.revparse([baseBranch]);
          return baseBranch;
        } catch {
        }
        const remoteBranch = `origin/${baseBranch}`;
        try {
          await this.git.revparse([remoteBranch]);
          return remoteBranch;
        } catch {
        }
        try {
          await this.git.fetch(["origin", baseBranch]);
          await this.git.revparse([remoteBranch]);
          return remoteBranch;
        } catch {
          return baseBranch;
        }
      }
      async getBranchDiff(baseBranch, includeContext = true, outputFile) {
        try {
          const resolvedBase = await this.resolveBaseBranchRef(baseBranch);
          if (resolvedBase !== baseBranch) {
            console.error(`\u{1F4CE} Resolved base branch: ${baseBranch} \u2192 ${resolvedBase}`);
          }
          const diffSummary = await this.git.diffSummary([resolvedBase]);
          const changes = [];
          if (!diffSummary || !diffSummary.files) {
            return [];
          }
          const isVisorOwned = this.visorOwnedMatcher(outputFile);
          for (const file of diffSummary.files) {
            if (isVisorOwned(file.file)) {
              console.error(`\u23ED\uFE0F  Skipping Visor state/output file: ${file.file}`);
              continue;
            }
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
                const rawPatch = await this.git.diff([resolvedBase, "--", file.file]);
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
      /** Title from the change set actually reviewed (not raw `git status`). */
      generateTitle(branch, files, diffSource, base, untrackedReviewed = 0) {
        if (files.length === 0) {
          return `Local Analysis: ${branch} (No changes)`;
        }
        if (diffSource === "branch") {
          return `Local Analysis: ${branch} (${files.length} file(s) changed vs ${base})`;
        }
        const count = (st) => files.filter((f) => f.status === st).length;
        const changeTypes = [];
        const added = count("added") - untrackedReviewed;
        if (added > 0) changeTypes.push(`${added} added`);
        if (count("modified") > 0) changeTypes.push(`${count("modified")} modified`);
        if (count("removed") > 0) changeTypes.push(`${count("removed")} deleted`);
        if (count("renamed") > 0) changeTypes.push(`${count("renamed")} renamed`);
        if (untrackedReviewed > 0) changeTypes.push(`${untrackedReviewed} untracked`);
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
  }
});
init_git_repository_analyzer();
export {
  GitRepositoryAnalyzer,
  applyPrContextOverrides,
  resolveLocalDiffSelection
};
//# sourceMappingURL=git-repository-analyzer-7TCBNRAP.mjs.map