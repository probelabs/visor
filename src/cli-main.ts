#!/usr/bin/env node

// Load environment variables from .env file (override existing to allow .env to take precedence)
import * as dotenv from 'dotenv';
dotenv.config({ override: true, quiet: true });

import { CLI } from './cli';
import { ConfigManager } from './config';
import { StateMachineExecutionEngine } from './state-machine-execution-engine';
import { OutputFormatters, AnalysisResult } from './output-formatters';
import { CheckResult, GroupedCheckResults } from './reviewer';
import { PRInfo } from './pr-analyzer';
import { logger, configureLoggerFromCli } from './logger';
import { TuiManager } from './tui';
import { extractTextFromJson } from './utils/json-text-extractor';
import * as fs from 'fs';
import * as path from 'path';
import { initTelemetry, shutdownTelemetry } from './telemetry/opentelemetry';
import { flushNdjson } from './telemetry/fallback-ndjson';
import { withActiveSpan } from './telemetry/trace-helpers';
import { DebugVisualizerServer } from './debug-visualizer/ws-server';
import open from 'open';

/**
 * Execute a single check in sandbox mode (--run-check).
 * Reads CheckRunPayload from argument or stdin, executes one check,
 * writes CheckRunResult JSON to stdout. All logging goes to stderr.
 */
async function runCheckMode(payloadArg?: string): Promise<void> {
  // Force all logging to stderr so stdout is reserved for JSON result
  configureLoggerFromCli({ output: 'json', debug: false, verbose: false, quiet: true });

  // Initialize telemetry when enabled (sandbox child trace relay)
  let telemetryEnabled = false;
  if (process.env.VISOR_TELEMETRY_ENABLED === 'true') {
    try {
      const { initTelemetry } = await import('./telemetry/opentelemetry');
      await initTelemetry({ enabled: true });
      telemetryEnabled = true;
    } catch {
      // Telemetry not available — continue without it
    }
  }

  let payloadJson: string;
  if (payloadArg && payloadArg !== '-') {
    payloadJson = payloadArg;
  } else {
    // Read from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    payloadJson = Buffer.concat(chunks).toString('utf8');
  }

  let payload: import('./sandbox/types').CheckRunPayload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    const errorResult = { issues: [], output: null, error: 'Invalid JSON payload' };
    process.stdout.write(JSON.stringify(errorResult) + '\n');
    return process.exit(1);
  }

  if (!payload.check || !payload.prInfo) {
    const errorResult = { issues: [], output: null, error: 'Missing check or prInfo in payload' };
    process.stdout.write(JSON.stringify(errorResult) + '\n');
    return process.exit(1);
  }

  try {
    const { CheckProviderRegistry } = await import('./providers/check-provider-registry');
    const registry = CheckProviderRegistry.getInstance();

    const checkConfig = payload.check;
    const providerType = checkConfig.type || 'ai';
    const provider = registry.getProviderOrThrow(providerType);

    // Reconstruct PRInfo from serialized form
    const prInfo: PRInfo = {
      number: payload.prInfo.number,
      title: payload.prInfo.title,
      body: payload.prInfo.body,
      author: payload.prInfo.author,
      base: payload.prInfo.base,
      head: payload.prInfo.head,
      files: payload.prInfo.files.map(f => ({
        filename: f.filename,
        status: f.status as 'added' | 'removed' | 'modified' | 'renamed',
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        patch: f.patch,
      })),
      totalAdditions: payload.prInfo.totalAdditions,
      totalDeletions: payload.prInfo.totalDeletions,
      eventType: payload.prInfo.eventType as import('./types/config').EventTrigger | undefined,
      fullDiff: payload.prInfo.fullDiff,
      commitDiff: payload.prInfo.commitDiff,
      isIncremental: payload.prInfo.isIncremental,
      isIssue: payload.prInfo.isIssue,
      eventContext: payload.prInfo.eventContext,
    };

    // Build provider config
    const providerConfig: import('./providers/check-provider.interface').CheckProviderConfig = {
      type: providerType,
      prompt: checkConfig.prompt,
      exec: checkConfig.exec,
      focus: checkConfig.focus,
      schema: checkConfig.schema,
      group: checkConfig.group,
      eventContext: prInfo.eventContext,
      env: checkConfig.env,
      ai: checkConfig.ai || {},
      ai_provider: checkConfig.ai_provider,
      ai_model: checkConfig.ai_model,
      claude_code: checkConfig.claude_code,
      transform: checkConfig.transform,
      transform_js: checkConfig.transform_js,
      forEach: checkConfig.forEach,
      ...checkConfig,
    };

    // Build dependency results map if provided
    let dependencyResults: Map<string, import('./reviewer').ReviewSummary> | undefined;
    if (payload.dependencyOutputs) {
      dependencyResults = new Map();
      for (const [key, value] of Object.entries(payload.dependencyOutputs)) {
        dependencyResults.set(key, value as import('./reviewer').ReviewSummary);
      }
    }

    // Wrap execution in OTel span when telemetry is enabled
    let result: import('./reviewer').ReviewSummary;
    if (telemetryEnabled) {
      try {
        const { withActiveSpan, setSpanAttributes } = await import('./telemetry/trace-helpers');
        result = await withActiveSpan(
          `visor.sandbox.child.${checkConfig.type || 'check'}`,
          {
            'visor.check.type': providerType,
            'visor.check.exec': checkConfig.exec || '',
          },
          async () => {
            const r = await provider.execute(prInfo, providerConfig, dependencyResults);
            try {
              setSpanAttributes({
                'visor.check.output.type': typeof (r as any).output,
                'visor.check.issues_count': (r.issues || []).length,
              });
            } catch {}
            return r;
          }
        );
      } catch {
        // Fallback if span fails
        result = await provider.execute(prInfo, providerConfig, dependencyResults);
      }
    } else {
      result = await provider.execute(prInfo, providerConfig, dependencyResults);
    }

    // Build CheckRunResult
    const extResult = result as import('./reviewer').ReviewSummary & {
      output?: unknown;
      content?: string;
    };
    const checkRunResult: import('./sandbox/types').CheckRunResult = {
      issues: result.issues || [],
      output: extResult.output,
      content: extResult.content,
      debug: result.debug,
    };

    // Flush telemetry before writing result (ensures NDJSON is written)
    if (telemetryEnabled) {
      try {
        const { shutdownTelemetry } = await import('./telemetry/opentelemetry');
        await shutdownTelemetry();
      } catch {}
    }

    process.stdout.write(JSON.stringify(checkRunResult) + '\n');
  } catch (err) {
    // Flush telemetry even on error
    if (telemetryEnabled) {
      try {
        const { shutdownTelemetry } = await import('./telemetry/opentelemetry');
        await shutdownTelemetry();
      } catch {}
    }
    const errorResult = {
      issues: [],
      output: null,
      error: err instanceof Error ? err.message : String(err),
    };
    process.stdout.write(JSON.stringify(errorResult) + '\n');
    process.exit(1);
  }
}

/**
 * Handle the validate subcommand
 */
async function handleValidateCommand(argv: string[], configManager: ConfigManager): Promise<void> {
  // Parse config path from arguments
  const configPathIndex = argv.indexOf('--config');
  let configPath: string | undefined;

  if (configPathIndex !== -1 && argv[configPathIndex + 1]) {
    configPath = argv[configPathIndex + 1];
  }

  // Configure logger for validation output
  configureLoggerFromCli({
    output: 'table',
    debug: false,
    verbose: false,
    quiet: false,
  });

  console.log('🔍 Visor Configuration Validator\n');

  try {
    let config;
    if (configPath) {
      console.log(`📂 Validating configuration: ${configPath}`);
      try {
        config = await configManager.loadConfig(configPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Only fall back for schema/validation-style errors; preserve hard errors like "not found"
        if (/Missing required field|Invalid YAML|must contain a valid YAML object/i.test(msg)) {
          console.warn('⚠️  Config validation failed, using minimal defaults for CLI run');
          config = await configManager.getDefaultConfig();
          // Merge the partial user config into defaults if it parses
          try {
            const raw = fs.readFileSync(configPath, 'utf8');
            const parsed = (await import('js-yaml')).load(raw) as any;
            if (parsed && typeof parsed === 'object' && parsed.checks) {
              (config as any).checks = parsed.checks;
              (config as any).steps = parsed.checks;
            }
          } catch {}
        } else {
          throw err;
        }
      }
    } else {
      console.log('📂 Searching for configuration file...');
      config = await configManager.findAndLoadConfig();
    }

    // If we got here, validation passed
    console.log('\n✅ Configuration is valid!');
    console.log(`\n📋 Summary:`);
    console.log(`   Version: ${config.version}`);
    console.log(`   Checks: ${Object.keys(config.checks || {}).length}`);

    // List checks
    if (config.checks && Object.keys(config.checks).length > 0) {
      console.log(`\n📝 Configured checks:`);
      for (const [name, check] of Object.entries(config.checks)) {
        const checkType = check.type || 'ai';
        console.log(`   • ${name} (type: ${checkType})`);
      }
    }

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Configuration validation failed!\n');

    if (error instanceof Error) {
      console.error(`Error: ${error.message}\n`);

      // Provide helpful hints
      if (error.message.includes('not found')) {
        console.error('💡 Hint: Make sure the configuration file exists at the specified path.');
        console.error('   Default locations: .visor.yaml or .visor.yml in project root\n');
      } else if (error.message.includes('Invalid YAML')) {
        console.error('💡 Hint: Check your YAML syntax at https://www.yamllint.com/\n');
      } else if (error.message.includes('Missing required field')) {
        console.error('💡 Hint: Ensure all required fields are present in your configuration.\n');
      }
    } else {
      console.error(`Error: ${error}\n`);
    }

    process.exit(1);
  }
}

/**
 * Handle the test subcommand (Milestone 0: discovery only)
 */
async function handleTestCommand(argv: string[]): Promise<void> {
  // Minimal flag parsing: --config <path|dir|glob>, positional path, --only <name>, --bail
  const getArg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const hasFlag = (name: string): boolean => argv.includes(name);

  // Support both --config flag and positional argument for tests path
  let testsPath = getArg('--config');
  if (!testsPath) {
    // Look for first positional argument (non-flag) after the command
    // argv is [node, script, 'test', ...rest]
    const rest = argv.slice(3); // Skip node, script, and 'test' command
    const flagsWithValues = new Set([
      '--config',
      '--only',
      '--json',
      '--report',
      '--summary',
      '--max-parallel',
      '--max-suites',
      '--prompt-max-chars',
      '--progress',
    ]);
    let i = 0;
    while (i < rest.length) {
      const token = rest[i];
      if (token.startsWith('--')) {
        if (flagsWithValues.has(token))
          i += 2; // skip flag + its value
        else i += 1; // boolean flag
        continue;
      }
      if (token.startsWith('-')) {
        // Conservatively skip single-dash flag and its value if present
        i += 2;
        continue;
      }
      // First non-flag token is a positional tests path
      testsPath = token;
      break;
    }
  }
  const only = getArg('--only');
  const bail = hasFlag('--bail');
  const noMocks = hasFlag('--no-mocks');
  const listOnly = hasFlag('--list');
  const validateOnly = hasFlag('--validate');
  const progress = (getArg('--progress') as 'compact' | 'detailed' | undefined) || 'compact';
  void progress; // currently parsed but not changing output detail yet
  const jsonOut = getArg('--json'); // path or '-' for stdout
  const reportArg = getArg('--report'); // e.g. junit:path.xml
  const summaryArg = getArg('--summary'); // e.g. md:path.md
  const maxParallelRaw = getArg('--max-parallel');
  const maxSuitesRaw = getArg('--max-suites');
  const promptMaxCharsRaw = getArg('--prompt-max-chars');
  const maxParallel = maxParallelRaw ? Math.max(1, parseInt(maxParallelRaw, 10) || 1) : undefined;
  const maxParallelSuites = maxSuitesRaw ? Math.max(1, parseInt(maxSuitesRaw, 10) || 1) : undefined;
  const promptMaxChars = promptMaxCharsRaw
    ? Math.max(1, parseInt(promptMaxCharsRaw, 10) || 1)
    : undefined;

  // Configure logger for concise console output
  // Respect --debug flag if present, or VISOR_DEBUG from environment
  const debugFlag = hasFlag('--debug') || process.env.VISOR_DEBUG === 'true';
  configureLoggerFromCli({ output: 'table', debug: debugFlag, verbose: false, quiet: false });

  console.log('🧪 Visor Test Runner');
  try {
    const { discoverAndPrint, validateTestsOnly, VisorTestRunner, discoverSuites, runSuites } =
      await import('./test-runner/index');
    if (validateOnly) {
      const errors = await validateTestsOnly({ testsPath });
      process.exit(errors > 0 ? 1 : 0);
    }
    if (listOnly) {
      await discoverAndPrint({ testsPath });
      if (only) console.log(`\nFilter: --only ${only}`);
      if (bail) console.log('Mode: --bail (stop on first failure)');
      process.exit(0);
    }
    // Multi-suite discovery: if testsPath is a directory or glob, discover all suites
    let multiFiles: string[] | null = null;
    if (!testsPath) {
      // No path provided: discover from current working directory
      multiFiles = discoverSuites(process.cwd(), process.cwd());
    } else {
      const p = require('path');
      const fs = require('fs');
      const abs = p.isAbsolute(testsPath) ? testsPath : p.resolve(process.cwd(), testsPath);
      const looksLikeGlob = /[?*]/.test(testsPath);
      if (looksLikeGlob || (fs.existsSync(abs) && fs.statSync(abs).isDirectory())) {
        multiFiles = discoverSuites(testsPath, process.cwd());
        // Gracefully handle directories/globs that contain no YAML suites
        if ((looksLikeGlob || fs.existsSync(abs)) && (!multiFiles || multiFiles.length === 0)) {
          console.log(
            `Discovered 0 YAML test suite(s) under ${testsPath}. Nothing to run; exiting 0.`
          );
          process.exit(0);
        }
      }
    }

    let failures = 0;
    let runRes: any = null;
    if (multiFiles && multiFiles.length > 0) {
      console.log(
        `Discovered ${multiFiles.length} test suite(s). Running${bail ? ' (bail enabled)' : ''}...`
      );
      const agg = await runSuites(multiFiles, {
        only,
        bail,
        noMocks,
        maxParallelSuites: maxParallelSuites || Math.max(1, require('os').cpus()?.length || 2),
        maxParallel,
        promptMaxChars,
      });
      failures = agg.failedSuites;
      // Print aggregated summary with re-run hints
      const rel = (p: string) => {
        try {
          return require('path').relative(process.cwd(), p) || p;
        } catch {
          return p;
        }
      };
      const failed = agg.perSuite.filter(s => s.failures > 0);
      const passed = agg.perSuite.filter(s => s.failures === 0);
      const write = (s: string) => {
        try {
          require('fs').writeSync(2, s + '\n');
        } catch {
          console.log(s);
        }
      };
      // Jest-like aggregated summary lines
      let __totalTests = 0;
      let __failedTests = 0;
      for (const s of agg.perSuite) {
        for (const r of s.results) {
          if (Array.isArray((r as any).stages) && (r as any).stages.length > 0) {
            __totalTests += (r as any).stages.length;
            __failedTests += (r as any).stages.filter(
              (st: any) => Array.isArray(st.errors) && st.errors.length > 0
            ).length;
          } else {
            __totalTests += 1;
            if (!r.passed) __failedTests += 1;
          }
        }
      }
      const __suitesPassed = agg.totalSuites - agg.failedSuites;
      const __suitesFailed = agg.failedSuites;
      const __testsPassed = __totalTests - __failedTests;
      write('\n' + '── Global Summary '.padEnd(66, '─'));
      write(
        `  Test Suites: ${__suitesFailed} failed, ${__suitesPassed} passed, ${agg.totalSuites} total`
      );
      write(
        `  Tests:       ${__testsPassed} passed, ${__failedTests} failed, ${__totalTests} total`
      );
      if (passed.length) write(`   • Passed suites: ${passed.map(s => rel(s.file)).join(', ')}`);
      if (failed.length) {
        write('  Failures:');
        const cross = '\u001b[31m✖\u001b[0m';
        const fsSync = require('fs');
        for (const s of failed) {
          const fcases = s.results.filter((r: any) => !r.passed);
          write(`   ${rel(s.file)}`);
          // best-effort line hints
          let raw: string | undefined;
          try {
            raw = fsSync.readFileSync(s.file, 'utf8');
          } catch {}
          const findLine = (caseName: string, stageName?: string): number | undefined => {
            if (!raw) return undefined;
            const lines = raw.split(/\r?\n/);
            let caseLine: number | undefined;
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes('- name:') && lines[i].includes(caseName)) {
                caseLine = i + 1;
                break;
              }
            }
            if (!stageName) return caseLine;
            if (caseLine !== undefined) {
              for (let j = caseLine; j < lines.length; j++) {
                if (lines[j].includes('- name:') && lines[j].includes(stageName)) return j + 1;
              }
            }
            return caseLine;
          };
          for (const c of fcases) {
            if (Array.isArray(c.stages) && c.stages.length > 0) {
              const bad = c.stages.filter(
                (st: any) => Array.isArray(st.errors) && st.errors.length > 0
              );
              for (const st of bad) {
                const stageNameOnly = String(st.name || '').includes('#')
                  ? String(st.name).split('#').pop()
                  : String(st.name);
                const label = `${c.name}#${stageNameOnly}`;
                const ln = findLine(c.name, stageNameOnly);
                write(`     ${cross} ${label}${ln ? ` (${rel(s.file)}:${ln})` : ''}`);
                for (const e of st.errors || []) write(`       • ${e}`);
              }
            }
            if (
              (!c.stages || c.stages.length === 0) &&
              Array.isArray(c.errors) &&
              c.errors.length > 0
            ) {
              const ln = findLine(c.name);
              write(`     ${cross} ${c.name}${ln ? ` (${rel(s.file)}:${ln})` : ''}`);
              for (const e of c.errors) write(`       • ${e}`);
            }
          }
          write(`   Tip: visor test --config ${rel(s.file)} --only \"CASE[#STAGE]\"`);
        }
      }
      runRes = { results: agg.perSuite };
    } else {
      // Single suite path resolution
      const runner = new (VisorTestRunner as any)();
      const tpath = runner.resolveTestsPath(testsPath);
      const suite = runner.loadSuite(tpath);
      runRes = await runner.runCases(tpath, suite, {
        only,
        bail,
        noMocks,
        maxParallel,
        promptMaxChars,
        engineMode: 'state-machine',
      });
      failures = runRes.failures;
    }
    // Fallback: If for any reason the runner didn't print its own summary
    // (e.g., natural early exit in some environments), print a concise one here.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const g: any = globalThis as any;
      const already = g && g.__VISOR_SUMMARY_PRINTED__ === true;
      if (!already) {
        const fsSync = require('fs');
        const write = (s: string) => {
          try {
            fsSync.writeSync(2, s + '\n');
          } catch {
            try {
              console.log(s);
            } catch {}
          }
        };
        const results: Array<{
          name: string;
          passed: boolean;
          stages?: Array<{ name: string; errors?: string[] }>;
          errors?: string[];
        }> = (runRes as any).results || [];
        const passed = results.filter(r => r.passed).map(r => r.name);
        const failed = results.filter(r => !r.passed);
        write('\n' + '── Summary '.padEnd(66, '─'));
        write(`  Passed: ${passed.length}/${results.length}`);
        if (passed.length) write(`   • ${passed.join(', ')}`);
        write(`  Failed: ${failed.length}/${results.length}`);
        if (failed.length) {
          const maxErrs = Math.max(
            1,
            parseInt(String(process.env.VISOR_SUMMARY_ERRORS_MAX || '5'), 10) || 5
          );
          for (const f of failed) {
            write(`   • ${f.name}`);
            if (Array.isArray(f.stages) && f.stages.length > 0) {
              const bad = f.stages.filter((s: any) => s.errors && s.errors.length > 0);
              for (const st of bad) {
                write(`     - ${st.name}`);
                const errs = (st.errors || []).slice(0, maxErrs);
                for (const e of errs) write(`       • ${e}`);
                const more = (st.errors?.length || 0) - errs.length;
                if (more > 0) write(`       • … and ${more} more`);
              }
              if (bad.length === 0) {
                const names = f.stages.map((s: any) => s.name).join(', ');
                write(`     stages: ${names}`);
              }
            }
            if (
              (!f.stages || f.stages.length === 0) &&
              Array.isArray(f.errors) &&
              f.errors.length > 0
            ) {
              const errs = f.errors.slice(0, maxErrs);
              for (const e of errs) write(`     • ${e}`);
              const more = f.errors.length - errs.length;
              if (more > 0) write(`     • … and ${more} more`);
            }
          }
        }
      }
    } catch {}
    // Basic reporters (Milestone 7): write minimal JSON/JUnit/Markdown summaries
    try {
      if (jsonOut) {
        const fs = require('fs');
        const payload = { failures, results: runRes.results };
        const data = JSON.stringify(payload, null, 2);
        if (jsonOut === '-' || jsonOut === 'stdout') console.log(data);
        else {
          fs.writeFileSync(jsonOut, data, 'utf8');
          console.error(`📝 JSON report written to ${jsonOut}`);
        }
      }
    } catch {}
    try {
      if (reportArg && reportArg.startsWith('junit:')) {
        const fs = require('fs');
        const dest = reportArg.slice('junit:'.length);
        const tests = (runRes.results || []).length;
        const failed = (runRes.results || []).filter((r: any) => !r.passed).length;
        const detail = (runRes.results || [])
          .map((r: any) => {
            const errs = (r.errors || []).concat(
              ...(r.stages || []).map((s: any) => s.errors || [])
            );
            return `<testcase classname=\"visor\" name=\"${r.name}\"${errs.length > 0 ? '' : ''}>${errs
              .map((e: string) => `<failure message=\"${e.replace(/\"/g, '&quot;')}\"></failure>`)
              .join('')}</testcase>`;
          })
          .join('\n  ');
        const xml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<testsuite name=\"visor\" tests=\"${tests}\" failures=\"${failed}\">\n  ${detail}\n</testsuite>`;
        fs.writeFileSync(dest, xml, 'utf8');
        console.error(`📝 JUnit report written to ${dest}`);
      }
    } catch {}
    try {
      if (summaryArg && summaryArg.startsWith('md:')) {
        const fs = require('fs');
        const dest = summaryArg.slice('md:'.length);
        const lines = (runRes.results || []).map(
          (r: any) =>
            `- ${r.passed ? '✅' : '❌'} ${r.name}${r.stages ? ' (' + r.stages.length + ' stage' + (r.stages.length !== 1 ? 's' : '') + ')' : ''}`
        );
        const content = `# Visor Test Summary\n\n- Failures: ${failures}\n\n${lines.join('\n')}`;
        fs.writeFileSync(dest, content, 'utf8');
        console.error(`📝 Markdown summary written to ${dest}`);
      }
    } catch {}
    process.exit(failures > 0 ? 1 : 0);
  } catch (err) {
    console.error('❌ test: ' + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}

function buildChatTranscript(
  groupedResults: GroupedCheckResults,
  config: import('./types/config').VisorConfig
): string {
  const messages: string[] = [];
  const checks = config.checks || {};
  const separator = '\n\n' + '-'.repeat(60) + '\n\n';

  for (const checkResults of Object.values(groupedResults)) {
    for (const result of checkResults) {
      const checkCfg: any = (checks as any)[result.checkName] || {};
      const providerType = typeof checkCfg.type === 'string' ? checkCfg.type : '';
      const group = (checkCfg.group as string) || result.group || '';
      const schema = checkCfg.schema;
      const isChatGroup = group === 'chat';
      const isAi = providerType === 'ai';
      const isLog = providerType === 'log';
      const isSimpleSchema =
        typeof schema === 'string' ? ['plain', 'text', 'markdown'].includes(schema) : false;

      let text = extractTextFromJson(result.output);

      if (!text && isAi && typeof result.content === 'string') {
        if (isSimpleSchema || schema === undefined || schema === null) {
          text = result.content.trim();
        }
      }

      if (!text && isLog && isChatGroup && typeof result.content === 'string') {
        text = result.content.trim();
      }

      if (!text && isChatGroup && typeof result.content === 'string') {
        text = result.content.trim();
      }

      if (!text || text.trim().length === 0) continue;

      const header = result.checkName ? result.checkName : 'chat';
      messages.push(`${header}\n${text.trim()}`);
    }
  }

  return messages.join(separator);
}

/**
 * Main CLI entry point for Visor
 */
export async function main(): Promise<void> {
  // Declare debugServer at function scope so it's accessible in catch/finally blocks
  let debugServer: DebugVisualizerServer | null = null;
  let tui: TuiManager | null = null;
  let tuiConsoleRestore: (() => void) | null = null;

  try {
    // Preflight: detect obviously stale dist relative to src and warn early.
    // This avoids confusing behavior when engine routing changed but dist wasn't rebuilt.
    (function warnIfStaleDist() {
      try {
        const projectRoot = process.cwd();
        const distIndex = path.join(projectRoot, 'dist', 'index.js');
        const srcDir = path.join(projectRoot, 'src');
        const statDist = fs.existsSync(distIndex) ? fs.statSync(distIndex) : null;
        const srcNewestMtime = (function walk(dir: string): number {
          let newest = 0;
          if (!fs.existsSync(dir)) return 0;
          for (const entry of fs.readdirSync(dir)) {
            if (entry === 'debug-visualizer' || entry === 'sdk') continue;
            const full = path.join(dir, entry);
            const st = fs.statSync(full);
            if (st.isDirectory()) newest = Math.max(newest, walk(full));
            else if (/\.tsx?$/.test(entry)) newest = Math.max(newest, st.mtimeMs);
          }
          return newest;
        })(srcDir);
        if (statDist && srcNewestMtime && srcNewestMtime > statDist.mtimeMs + 1) {
          // Print once, concise but explicit.
          console.error(
            '⚠  Detected stale build: src/* is newer than dist/index.js. Run "npm run build:cli".'
          );
        }
      } catch {
        /* ignore preflight errors */
      }
    })();

    // IMPORTANT: detect subcommands before constructing CLI/commander to avoid
    // any argument parsing side-effects (e.g., extra positional args like 'test').
    // Also filter out the --cli flag if it exists (used to force CLI mode in GH Actions)
    let filteredArgv = process.argv.filter(arg => arg !== '--cli');

    // Check for --run-check mode before standard CLI parsing
    const runCheckIndex = process.argv.indexOf('--run-check');
    if (runCheckIndex !== -1) {
      const payloadArg = process.argv[runCheckIndex + 1];
      await runCheckMode(payloadArg);
      return;
    }

    // EARLY: ensure trace dir and fallback NDJSON file exist BEFORE any early exits
    try {
      const tracesDir = process.env.VISOR_TRACE_DIR || path.join(process.cwd(), 'output', 'traces');
      fs.mkdirSync(tracesDir, { recursive: true });
      let fallbackPath = process.env.VISOR_FALLBACK_TRACE_FILE;
      if (!fallbackPath) {
        const runTsEarly = new Date().toISOString().replace(/[:.]/g, '-');
        fallbackPath = path.join(tracesDir, `run-${runTsEarly}.ndjson`);
        process.env.VISOR_FALLBACK_TRACE_FILE = fallbackPath;
      }
      if (process.env.NODE_ENV === 'test') {
        try {
          console.error(
            `[e2e] VISOR_TRACE_DIR=${tracesDir} VISOR_FALLBACK_TRACE_FILE=${fallbackPath}`
          );
        } catch {}
      }
      try {
        const line = JSON.stringify({ name: 'visor.run', attributes: { started: true } }) + '\n';
        fs.appendFileSync(fallbackPath, line, 'utf8');
      } catch {}
    } catch {}

    // Check for validate subcommand (aliases: validate, lint)
    if (filteredArgv.length > 2 && ['validate', 'lint'].includes(filteredArgv[2])) {
      const configManager = new ConfigManager();
      await handleValidateCommand(filteredArgv, configManager);
      return;
    }
    // Check for mcp-server subcommand
    if (filteredArgv.length > 2 && filteredArgv[2] === 'mcp-server') {
      // Parse MCP server specific arguments
      const mcpArgs = filteredArgv.slice(3);
      const getArg = (name: string): string | undefined => {
        const i = mcpArgs.indexOf(name);
        return i >= 0 && i + 1 < mcpArgs.length ? mcpArgs[i + 1] : undefined;
      };

      const mcpOptions: import('./mcp-server').McpServerOptions = {
        configPath: getArg('--config'),
        toolName: getArg('--mcp-tool-name'),
        toolDescription: getArg('--mcp-tool-description'),
      };

      const { startMcpServer } = await import('./mcp-server');
      await startMcpServer(mcpOptions);
      return;
    }
    // Check for test subcommand
    if (filteredArgv.length > 2 && filteredArgv[2] === 'test') {
      await handleTestCommand(filteredArgv);
      return;
    }
    // Check for code-review subcommands: run the built-in code-review suite
    // Aliases: code-review | review
    if (filteredArgv.length > 2 && ['code-review', 'review'].includes(filteredArgv[2])) {
      const base = filteredArgv.slice(0, 2);
      const rest = filteredArgv.slice(3); // preserve flags like --output, --debug, etc.
      // Prefer packaged default under dist/; fall back to local defaults/ for dev
      const packaged = path.resolve(__dirname, 'defaults', 'code-review.yaml');
      const localDev = path.resolve(process.cwd(), 'defaults', 'code-review.yaml');
      const chosen = fs.existsSync(packaged) ? packaged : localDev;
      if (!fs.existsSync(chosen)) {
        console.error(
          '❌ Could not locate built-in code-review config. Expected at dist/defaults/code-review.yaml (packaged) or ./defaults/code-review.yaml (dev).'
        );
        process.exit(1);
      }
      // Let event auto-detection pick pr_updated for code-review schemas unless user overrides with --event
      filteredArgv = [...base, '--config', chosen, ...rest];
    }
    // Check for build subcommand: run the official agent-builder config
    if (filteredArgv.length > 2 && filteredArgv[2] === 'build') {
      // Transform into a standard run with our official builder config (agent-builder.yaml).
      // Require a positional target: `build <path/to/agent.yaml>`
      const base = filteredArgv.slice(0, 2);
      let rest = filteredArgv.slice(3); // preserve flags like --message
      const preferred = path.resolve(process.cwd(), 'defaults', 'agent-builder.yaml');
      const fallback = path.resolve(process.cwd(), 'defaults', 'agent-build.yaml');
      const chosen = fs.existsSync(preferred) ? preferred : fallback;

      if (rest.length === 0 || String(rest[0]).startsWith('-')) {
        console.error('Usage: visor build <path/to/agent.yaml> [--message "brief" ...]');
        process.exitCode = 1;
        return;
      }

      const targetPath = path.resolve(process.cwd(), String(rest[0]));
      process.env.VISOR_AGENT_PATH = targetPath; // builder decides mode via Liquid readfile
      rest = rest.slice(1);

      // Do not force code context globally; respect per-step ai.skip_code_context.
      // Builder YAML controls whether to include repo context.
      filteredArgv = [...base, '--config', chosen, '--event', 'manual', ...rest];
    }
    // Construct CLI and ConfigManager only after subcommand handling
    const cli = new CLI();
    const configManager = new ConfigManager();

    // Parse arguments using the CLI class
    const options = cli.parseArgs(filteredArgv);
    const explicitChecks =
      options.checks.length > 0
        ? new Set<string>(options.checks.map(check => check.toString()))
        : null;

    // Build execution context for providers
    const executionContext: import('./providers/check-provider.interface').ExecutionContext = {};

    // Set CLI message for human-input checks if provided
    if (options.message !== undefined) {
      executionContext.cliMessage = options.message;
      // Also set static property for backward compatibility
      const { HumanInputCheckProvider } = await import('./providers/human-input-check-provider');
      HumanInputCheckProvider.setCLIMessage(options.message);
    }

    // Set environment variables early for proper logging in all modules
    process.env.VISOR_OUTPUT_FORMAT = options.output;
    process.env.VISOR_DEBUG = options.debug ? 'true' : 'false';
    if (options.keepWorkspace) {
      process.env.VISOR_KEEP_WORKSPACE = 'true';
    }
    if (options.workspaceHere) {
      process.env.VISOR_WORKSPACE_PATH = process.cwd();
    } else if (options.workspacePath) {
      process.env.VISOR_WORKSPACE_PATH = options.workspacePath;
    }
    if (options.workspaceName) {
      process.env.VISOR_WORKSPACE_NAME = options.workspaceName;
    }
    if (options.workspaceProjectName) {
      process.env.VISOR_WORKSPACE_PROJECT = options.workspaceProjectName;
    }
    // Configure centralized logger
    configureLoggerFromCli({
      output: options.output,
      debug: options.debug,
      verbose: options.verbose,
      quiet: options.quiet,
    });

    // If caller provided a custom traces directory, ensure it exists ASAP
    try {
      if (process.env.VISOR_TRACE_DIR) {
        fs.mkdirSync(process.env.VISOR_TRACE_DIR, { recursive: true });
      }
    } catch {}

    // Handle help and version flags
    if (options.help) {
      console.log(cli.getHelpText());
      process.exit(0);
    }

    if (options.version) {
      console.log(cli.getVersion());
      process.exit(0);
    }

    const shouldEnableTui =
      Boolean(options.tui) &&
      Boolean(process.stdout.isTTY) &&
      Boolean(process.stderr.isTTY) &&
      !options.debugServer &&
      !options.slack &&
      process.env.NODE_ENV !== 'test';

    if (shouldEnableTui) {
      try {
        tui = new TuiManager();
        tui.start();
        tui.setRunning(true);
        tuiConsoleRestore = tui.captureConsole();
        executionContext.hooks = executionContext.hooks || {};
        executionContext.hooks.onHumanInput = async request => {
          if (!tui) throw new Error('TUI not available');
          tui.setStatus('Awaiting input...');
          try {
            const userInput = await tui.promptUser({
              prompt: request.prompt,
              placeholder: request.placeholder,
              multiline: request.multiline,
              timeout: request.timeout,
              defaultValue: request.default,
              allowEmpty: request.allowEmpty,
            });
            // Append user input to chat content
            if (userInput && userInput.trim()) {
              const currentChat = (tui as any).pendingChat || '';
              const newChat = currentChat
                ? `${currentChat}\n\n**You:** ${userInput.trim()}`
                : `**You:** ${userInput.trim()}`;
              tui.setChatContent(newChat);
            }
            return userInput;
          } finally {
            tui.setStatus('Running');
          }
        };
        // Hook to update TUI chat content when AI checks complete
        executionContext.hooks.onCheckComplete = info => {
          if (!tui) return;
          const { checkConfig, result } = info;
          // Only show AI/log checks with group=chat and criticality=info
          const isAi = checkConfig?.type === 'ai';
          const isLogChat = checkConfig?.type === 'log' && checkConfig?.group === 'chat';
          if (!isAi && !isLogChat) return;
          if (checkConfig?.criticality === 'internal') return;

          // Extract text from result
          let text: string | undefined;
          const out = result?.output as any;
          if (out && typeof out.text === 'string' && out.text.trim().length > 0) {
            text = out.text.trim();
          } else if (typeof result?.content === 'string' && result.content.trim().length > 0) {
            text = result.content.trim();
          }
          if (!text) return;

          // Append to chat content
          const currentChat = (tui as any).pendingChat || '';
          const newChat = currentChat
            ? `${currentChat}\n\n---\n\n**Assistant:** ${text}`
            : `**Assistant:** ${text}`;
          tui.setChatContent(newChat);
        };
        tui.setAbortHandler(() => {
          void (async () => {
            try {
              logger.setSink(undefined);
            } catch {}
            try {
              if (tuiConsoleRestore) {
                tuiConsoleRestore();
                tuiConsoleRestore = null;
              }
            } catch {}
            try {
              tui?.stop();
            } catch {}
            try {
              await flushNdjson();
            } catch {}
            try {
              await shutdownTelemetry();
            } catch {}
            process.exit(130);
          })();
        });
        logger.setSink((msg, _level) => tui?.appendLog(msg), {
          passthrough: false,
          errorMode: 'warn',
          onError: error => {
            const errMsg = error instanceof Error ? error.message : String(error);
            console.error(`TUI log sink failed: ${errMsg}`);
            logger.setSink(undefined);
          },
        });
      } catch (error) {
        if (tuiConsoleRestore) {
          tuiConsoleRestore();
          tuiConsoleRestore = null;
        }
        logger.setSink(undefined);
        tui?.stop();
        tui = null;
        try {
          if (executionContext.hooks?.onHumanInput) {
            delete executionContext.hooks.onHumanInput;
          }
        } catch {}
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`⚠️  Failed to start TUI, falling back to standard output: ${msg}`);
      }
    } else if (options.tui) {
      const reasons: string[] = [];
      if (!process.stdout.isTTY || !process.stderr.isTTY) reasons.push('non-interactive TTY');
      if (options.debugServer) reasons.push('--debug-server');
      if (options.slack) reasons.push('--slack');
      if (process.env.NODE_ENV === 'test') reasons.push('test mode');
      const suffix = reasons.length > 0 ? ` (${reasons.join(', ')})` : '';
      console.error(`TUI requested but disabled${suffix}.`);
    }

    // Configure logger based on output format and verbosity
    logger.configure({
      outputFormat: options.output,
      debug: options.debug,
      verbose: options.verbose,
      quiet: options.quiet,
    });

    // Print runtime banner (info level): Visor + Probe versions
    // Banner is automatically suppressed for JSON/SARIF by logger configuration
    try {
      const visorVersion =
        process.env.VISOR_VERSION || (require('../package.json')?.version ?? 'dev');
      const commitShort = process.env.VISOR_COMMIT_SHORT || '';
      let probeVersion = process.env.PROBE_VERSION || 'unknown';
      if (!process.env.PROBE_VERSION) {
        try {
          probeVersion = require('@probelabs/probe/package.json')?.version ?? 'unknown';
        } catch {
          // ignore if dependency metadata not available (tests, local)
        }
      }
      const visorPart = commitShort ? `${visorVersion} (${commitShort})` : visorVersion;
      logger.info(`Visor ${visorPart} • Probe ${probeVersion} • Node ${process.version}`);
    } catch {
      // If anything goes wrong reading versions, do not block execution
    }

    // Load configuration FIRST (before starting debug server)
    let config: import('./types/config').VisorConfig;
    if (options.configPath) {
      try {
        logger.step('Loading configuration');
        config = await configManager.loadConfig(options.configPath);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // Preserve original error behavior for not found and other hard errors
        if (/not found|ENOENT|permission denied/i.test(msg)) {
          // Show the original, helpful error and exit
          if (error instanceof Error) {
            logger.error(`❌ Error loading configuration from ${options.configPath}:`);
            logger.error(`   ${error.message}`);
          } else {
            logger.error(`❌ Error loading configuration from ${options.configPath}`);
          }
          logger.error(
            '\n🛑 Exiting: Cannot proceed when specified configuration file fails to load.'
          );
          process.exit(1);
        }
        // Otherwise, treat as validation error and fall back
        logger.warn(`⚠️  Failed to validate config ${options.configPath}: ${msg}`);
        const def = await configManager.getDefaultConfig();
        try {
          const raw = fs.readFileSync(options.configPath, 'utf8');
          const parsed = (await import('js-yaml')).load(raw) as any;
          if (parsed && typeof parsed === 'object' && parsed.checks) {
            (def as any).checks = parsed.checks;
            (def as any).steps = parsed.checks;
          }
        } catch {}
        config = def;
      }
    } else {
      // Auto-discovery mode - fallback to defaults is OK
      logger.step('Discovering configuration');
      config = await configManager
        .findAndLoadConfig()
        .catch(() => configManager.getDefaultConfig());
    }

    // Socket Mode runner: visor --slack [--config file]
    if ((options as any).slack === true) {
      const { SlackSocketRunner } = await import('./slack/socket-runner');
      const engine = new StateMachineExecutionEngine();
      const slackAny: any = (config as any).slack || {};
      const endpoint = slackAny.endpoint || '/bots/slack/support';
      const mentions = slackAny.mentions || 'direct';
      const threads = slackAny.threads || 'any';
      const allow = Array.isArray(slackAny.channel_allowlist) ? slackAny.channel_allowlist : [];
      const appToken = slackAny.app_token || process.env.SLACK_APP_TOKEN;

      // Initialize telemetry for Slack mode (normally done later for CLI runs).
      if ((config as any)?.telemetry) {
        const t = (config as any).telemetry as {
          enabled?: boolean;
          sink?: 'otlp' | 'file' | 'console';
          file?: { dir?: string; ndjson?: boolean };
          tracing?: { auto_instrumentations?: boolean; trace_report?: { enabled?: boolean } };
        };
        await initTelemetry({
          enabled: process.env.VISOR_TELEMETRY_ENABLED === 'true' || !!t?.enabled,
          sink:
            (process.env.VISOR_TELEMETRY_SINK as 'otlp' | 'file' | 'console') || t?.sink || 'file',
          file: { dir: process.env.VISOR_TRACE_DIR || t?.file?.dir, ndjson: !!t?.file?.ndjson },
          autoInstrument: !!t?.tracing?.auto_instrumentations,
          traceReport: !!t?.tracing?.trace_report?.enabled,
        });
      } else {
        await initTelemetry({
          enabled: process.env.VISOR_TELEMETRY_ENABLED === 'true',
          sink: (process.env.VISOR_TELEMETRY_SINK as 'otlp' | 'file' | 'console') || 'file',
          file: { dir: process.env.VISOR_TRACE_DIR },
        });
      }

      const runner = new SlackSocketRunner(engine, config, {
        appToken,
        endpoint,
        mentions,
        threads,
        channel_allowlist: allow,
      });
      await runner.start();
      console.log('✅ Slack Socket Mode is running. Press Ctrl+C to exit.');
      process.stdin.resume();
      return;
    }

    // Start debug server if requested (AFTER config is loaded)
    if (options.debugServer) {
      const requestedPort = options.debugPort || 3456;

      console.log(`🔍 Starting debug visualizer on port ${requestedPort}...`);

      debugServer = new DebugVisualizerServer();
      await debugServer.start(requestedPort);

      // Set config on server BEFORE opening browser
      debugServer.setConfig(config);

      // Force JSON output when debug server is active
      options.output = 'json';
      process.env.VISOR_OUTPUT_FORMAT = 'json';
      logger.configure({
        outputFormat: 'json',
        debug: options.debug,
        verbose: options.verbose,
        quiet: true, // Suppress console output when debug server is active
      });

      const boundPort = debugServer.getPort();
      console.log(`✅ Debug visualizer running at http://localhost:${boundPort}`);

      // Open browser unless VISOR_NOBROWSER is set (useful for CI/tests)
      if (process.env.VISOR_NOBROWSER !== 'true') {
        console.log(`   Opening browser...`);
        await open(`http://localhost:${boundPort}`);
      }

      console.log(`⏸️  Waiting for you to click "Start Execution" in the browser...`);
    }

    // Ensure a single NDJSON fallback file per run (for serverless/file sink)
    // Do this BEFORE initializing telemetry so custom exporters can reuse this path
    try {
      const tracesDir = process.env.VISOR_TRACE_DIR || path.join(process.cwd(), 'output', 'traces');
      fs.mkdirSync(tracesDir, { recursive: true });
      // In test runs, clear old NDJSON files in this directory to avoid flakiness
      // BUT do not delete the explicitly provided VISOR_FALLBACK_TRACE_FILE the test may be waiting on
      try {
        if (process.env.NODE_ENV === 'test') {
          const preserve = process.env.VISOR_FALLBACK_TRACE_FILE || '';
          for (const f of fs.readdirSync(tracesDir)) {
            if (!f.endsWith('.ndjson')) continue;
            const full = path.join(tracesDir, f);
            if (preserve && path.resolve(full) === path.resolve(preserve)) continue;
            try {
              fs.unlinkSync(full);
            } catch {}
          }
        }
      } catch {}
      // Respect pre-set fallback file from environment if provided (e.g., in tests/CI)
      let fallbackPath = process.env.VISOR_FALLBACK_TRACE_FILE;
      if (!fallbackPath) {
        const runTs = new Date().toISOString().replace(/[:.]/g, '-');
        fallbackPath = path.join(tracesDir, `run-${runTs}.ndjson`);
        process.env.VISOR_FALLBACK_TRACE_FILE = fallbackPath;
      }
      // Ensure the file exists eagerly with a run marker so downstream readers can detect it
      try {
        const line = JSON.stringify({ name: 'visor.run', attributes: { started: true } }) + '\n';
        fs.appendFileSync(fallbackPath, line, 'utf8');
      } catch {}
    } catch {}

    // Opportunistically create NDJSON run marker early (pre-telemetry) when a trace dir/file is configured
    try {
      (await import('./telemetry/trace-helpers'))._appendRunMarker();
    } catch {}

    // Initialize telemetry (env or config)
    if ((config as any)?.telemetry) {
      const t = (config as any).telemetry as {
        enabled?: boolean;
        sink?: 'otlp' | 'file' | 'console';
        file?: { dir?: string; ndjson?: boolean };
        tracing?: { auto_instrumentations?: boolean; trace_report?: { enabled?: boolean } };
      };
      await initTelemetry({
        // Enable if: env var is true, OR config enables it, OR debugServer is active
        enabled: process.env.VISOR_TELEMETRY_ENABLED === 'true' || !!t?.enabled || !!debugServer,
        sink:
          (process.env.VISOR_TELEMETRY_SINK as 'otlp' | 'file' | 'console') || t?.sink || 'file',
        file: { dir: process.env.VISOR_TRACE_DIR || t?.file?.dir, ndjson: !!t?.file?.ndjson },
        autoInstrument: !!t?.tracing?.auto_instrumentations,
        traceReport: !!t?.tracing?.trace_report?.enabled,
        debugServer: debugServer || undefined,
      });
    } else {
      await initTelemetry({
        // Honor env flags even when no telemetry section is present in config
        enabled: process.env.VISOR_TELEMETRY_ENABLED === 'true' || !!debugServer,
        sink: (process.env.VISOR_TELEMETRY_SINK as 'otlp' | 'file' | 'console') || 'file',
        file: { dir: process.env.VISOR_TRACE_DIR },
        debugServer: debugServer || undefined,
      });
    }

    try {
      (await import('./telemetry/trace-helpers'))._appendRunMarker();
    } catch {}

    // Determine checks to run and validate check types early
    let checksToRun = options.checks.length > 0 ? options.checks : Object.keys(config.checks || {});

    // Generic: remove checks that are meant to be scheduled via routing (on_*.run)
    // from the initial root set unless the user explicitly requested them.
    if (options.checks.length === 0) {
      const routingRunTargets = new Set<string>();
      for (const [, cfg] of Object.entries(config.checks || {})) {
        const onFinish: any = (cfg as any).on_finish || {};
        const onSuccess: any = (cfg as any).on_success || {};
        const onFail: any = (cfg as any).on_fail || {};
        const collect = (arr?: string[]) => {
          if (Array.isArray(arr))
            for (const t of arr) if (typeof t === 'string' && t) routingRunTargets.add(t);
        };
        collect(onFinish.run);
        collect(onSuccess.run);
        collect(onFail.run);
      }
      const before = checksToRun.length;
      checksToRun = checksToRun.filter(chk => !routingRunTargets.has(chk));
      if (before !== checksToRun.length) {
        logger.verbose(`Pruned ${before - checksToRun.length} routing-run target(s) from roots`);
      }
    }

    // Validate that all requested checks exist in the configuration
    const availableChecks = Object.keys(config.checks || {});
    const invalidChecks = checksToRun.filter(check => !availableChecks.includes(check));
    if (invalidChecks.length > 0) {
      logger.error(`❌ Error: No configuration found for check: ${invalidChecks[0]}`);
      process.exit(1);
    }

    // Include dependencies of requested checks
    const checksWithDependencies = new Set(checksToRun);
    const addDependencies = (checkName: string) => {
      const checkConfig = config.checks?.[checkName];
      if (checkConfig?.depends_on) {
        for (const raw of checkConfig.depends_on) {
          const parts =
            typeof raw === 'string' && raw.includes('|')
              ? raw
                  .split('|')
                  .map(s => s.trim())
                  .filter(Boolean)
              : [String(raw)];
          for (const dep of parts) {
            if (!availableChecks.includes(dep)) continue; // ignore OR tokens that are not real checks
            if (!checksWithDependencies.has(dep)) {
              checksWithDependencies.add(dep);
              addDependencies(dep); // Recursively add dependencies of dependencies
            }
          }
        }
      }
    };

    // Add all dependencies
    for (const check of checksToRun) {
      addDependencies(check);
    }

    // Update checksToRun to include dependencies
    checksToRun = Array.from(checksWithDependencies);

    // Prune internal dependencies from the root set so we only start from DAG sinks.
    // This prevents re-running dependency steps (e.g., human-input collectors) as
    // independent roots across waves. The engine will expand dependencies anyway.
    const getAllDeps = (name: string, seen = new Set<string>()): Set<string> => {
      if (seen.has(name)) return new Set();
      seen.add(name);
      const out = new Set<string>();
      const cfg = config.checks?.[name];
      const depTokens: any[] = cfg?.depends_on
        ? Array.isArray(cfg.depends_on)
          ? cfg.depends_on
          : [cfg.depends_on]
        : [];
      const expand = (tok: any): string[] =>
        typeof tok === 'string' && tok.includes('|')
          ? tok
              .split('|')
              .map(s => s.trim())
              .filter(Boolean)
          : tok != null
            ? [String(tok)]
            : [];
      for (const raw of depTokens.flatMap(expand)) {
        if (!availableChecks.includes(raw)) continue;
        out.add(raw);
        for (const d of getAllDeps(raw, seen)) out.add(d);
      }
      return out;
    };

    const rootsPruned = checksToRun.filter(chk => {
      // Keep chk only if no other selected root depends on it (directly or transitively)
      return !checksToRun.some(other => other !== chk && getAllDeps(other).has(chk));
    });
    if (rootsPruned.length > 0) checksToRun = rootsPruned;

    // Use stderr for status messages when outputting formatted results to stdout
    // Suppress all status messages when outputting JSON to avoid breaking parsers
    const logFn = (msg: string) => logger.info(msg);

    // Determine if we should include code context (diffs)
    // Skip code context when debug server is active (not needed for debugging)
    // In CLI mode (local), we do smart detection. PR mode always includes context.
    const isPRContext = false; // This is CLI mode, not GitHub Action
    let includeCodeContext = false;

    if (options.debugServer) {
      // Skip code context analysis when debug server is active
      includeCodeContext = false;
    } else if (isPRContext) {
      // ALWAYS include full context in PR/GitHub Action mode
      includeCodeContext = true;
      logFn('📝 Code context: ENABLED (PR context - always included)');
    } else if (options.codeContext === 'enabled') {
      includeCodeContext = true;
      logFn('📝 Code context: ENABLED (forced by --enable-code-context)');
    } else if (options.codeContext === 'disabled') {
      includeCodeContext = false;
      logFn('📝 Code context: DISABLED (forced by --disable-code-context)');
    } else {
      // Auto-detect based on schemas (CLI mode only)
      const hasCodeReviewSchema = checksToRun.some(
        check => config.checks?.[check]?.schema === 'code-review'
      );
      includeCodeContext = hasCodeReviewSchema;
      if (hasCodeReviewSchema)
        logFn('📝 Code context: ENABLED (code-review schema detected in local mode)');
      else logFn('📝 Code context: DISABLED (no code-review schema found in local mode)');
    }

    // Get repository info using GitRepositoryAnalyzer
    const { GitRepositoryAnalyzer } = await import('./git-repository-analyzer');
    const analyzer = new GitRepositoryAnalyzer(process.cwd());

    // Determine if we should analyze branch diff
    // Skip git diff analysis when debug server is active (not needed for debugging execution flow)
    // Auto-enable when: --analyze-branch-diff flag OR code-review schema detected
    const hasCodeReviewSchema = checksToRun.some(
      check => config.checks?.[check]?.schema === 'code-review'
    );
    const analyzeBranchDiff = options.debugServer
      ? false // Skip git diff when debug server is active
      : options.analyzeBranchDiff || hasCodeReviewSchema;

    let repositoryInfo: import('./git-repository-analyzer').GitRepositoryInfo;
    const requiresGit = includeCodeContext || analyzeBranchDiff;
    try {
      if (!options.debugServer) {
        logger.step('Analyzing repository');
      }
      repositoryInfo = await analyzer.analyzeRepository(includeCodeContext, analyzeBranchDiff);
    } catch (error) {
      if (requiresGit) {
        logger.error(
          '❌ Error analyzing git repository: ' +
            (error instanceof Error ? error.message : String(error))
        );
        logger.warn('💡 Make sure you are in a git repository or initialize one with "git init"');
        process.exit(1);
      }
      // When git is not required, create a minimal repository info
      logger.verbose('Running without git repository (code context not needed)');
      repositoryInfo = {
        title: 'Standalone Workflow Execution',
        body: 'Running workflow without git repository context',
        author: 'system',
        base: 'main',
        head: 'HEAD',
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
        isGitRepository: false,
        workingDirectory: process.cwd(),
      };
    }

    // Check if we're in a git repository (only required when code context is needed)
    if (requiresGit && !repositoryInfo.isGitRepository) {
      logger.error('❌ Error: Not a git repository. Run "git init" to initialize a repository.');
      process.exit(1);
    }

    logger.info('🔍 Visor - AI-powered code review tool');
    logger.info(`Configuration version: ${config.version}`);

    // GitHub event-bus integration is now the default when running in GitHub contexts
    try {
      const cfg = JSON.parse(JSON.stringify(config));
      const fronts = Array.isArray(cfg.frontends) ? cfg.frontends : [];
      if (!fronts.some((f: any) => f && f.name === 'github')) fronts.push({ name: 'github' });
      cfg.frontends = fronts;
      config = cfg;
    } catch {}
    logger.verbose(`Configuration source: ${options.configPath || 'default search locations'}`);

    // Check if there are any changes to analyze (only when code context is needed)
    if (includeCodeContext && repositoryInfo.files.length === 0) {
      logger.error('❌ Error: No changes to analyze. Make some file changes first.');
      process.exit(1);
    }

    // Show registered providers if in debug mode
    if (options.debug) {
      const { CheckProviderRegistry } = await import('./providers/check-provider-registry');
      const registry = CheckProviderRegistry.getInstance();
      logger.debug('Registered providers: ' + registry.getAvailableProviders().join(', '));
    }

    logger.info(`📂 Repository: ${repositoryInfo.base} branch`);
    logger.info(`📁 Files changed: ${repositoryInfo.files?.length || 0}`);
    logger.step(`Executing ${checksToRun.length} check(s)`);
    logger.verbose(`Checks: ${checksToRun.join(', ')}`);

    // Create StateMachineExecutionEngine for running checks
    const engine = new StateMachineExecutionEngine(undefined, undefined, debugServer || undefined);

    // Set execution context on engine
    engine.setExecutionContext(executionContext);

    // Build tag filter from CLI options
    const tagFilter: import('./types/config').TagFilter | undefined =
      options.tags || options.excludeTags
        ? {
            include: options.tags,
            exclude: options.excludeTags,
          }
        : undefined;

    // Convert repository info to PRInfo format
    const prInfo = analyzer.toPRInfo(repositoryInfo, includeCodeContext);

    // Store the includeCodeContext flag in prInfo for downstream use
    type EventTrigger =
      | 'pr_opened'
      | 'pr_updated'
      | 'pr_closed'
      | 'issue_opened'
      | 'issue_comment'
      | 'manual'
      | 'schedule'
      | 'webhook_received';
    const prInfoWithContext = prInfo as PRInfo & {
      includeCodeContext?: boolean;
      eventType?: EventTrigger;
    };
    prInfoWithContext.includeCodeContext = includeCodeContext;

    // Determine event type for filtering
    let eventType = options.event || 'all';

    // Auto-detect event based on schema if not explicitly set
    if (eventType === 'all' || !options.event) {
      const hasCodeReviewSchema = checksToRun.some(
        check => config.checks?.[check]?.schema === 'code-review'
      );
      if (hasCodeReviewSchema && !options.event) {
        eventType = 'pr_updated'; // Default for code-review schemas
        logger.verbose(`📋 Auto-detected event type: ${eventType} (code-review schema detected)`);
      }
    }

    // Set event type on prInfo (unless it's 'all', which means no filtering)
    if (eventType !== 'all') {
      prInfoWithContext.eventType = eventType as EventTrigger;
      logger.verbose(`🎯 Simulating event: ${eventType}`);
    } else {
      logger.verbose(
        `🎯 Event filtering: DISABLED (running all checks regardless of event triggers)`
      );
    }

    // Wait for user to click "Start" if debug server is running
    if (debugServer) {
      await debugServer.waitForStartSignal();
      // Clear spans from previous run before starting new execution
      debugServer.clearSpans();
    }

    // Execute checks with proper parameters
    // Build a pause gate that honors the debug server state between steps/iterations
    const pauseGate = debugServer
      ? (() => {
          const srv = debugServer as DebugVisualizerServer; // narrow for closure
          return async () => {
            const state = srv.getExecutionState();
            if (state === 'paused') {
              await srv.waitWhilePaused();
            }
            const state2 = srv.getExecutionState();
            if (state2 === 'stopped') throw new Error('__EXECUTION_STOP_REQUESTED__');
          };
        })()
      : async () => {};

    const executionResult = await withActiveSpan(
      'visor.run',
      { 'visor.run.checks_configured': checksToRun.length },
      async () =>
        engine.executeGroupedChecks(
          prInfo,
          checksToRun,
          options.timeout,
          config,
          options.output,
          options.debug || false,
          options.maxParallelism,
          options.failFast,
          tagFilter,
          pauseGate
        )
    );

    // Extract results and statistics from the execution result
    const { results: groupedResults, statistics: executionStatistics } = executionResult;

    const shouldFilterResults =
      explicitChecks && explicitChecks.size > 0 && !explicitChecks.has('all');

    const groupedResultsToUse: GroupedCheckResults = shouldFilterResults
      ? (Object.fromEntries(
          Object.entries(groupedResults)
            .map(([group, checkResults]) => [
              group,
              checkResults.filter(check => explicitChecks!.has(check.checkName)),
            ])
            .filter(([, checkResults]) => checkResults.length > 0)
        ) as GroupedCheckResults)
      : groupedResults;

    if (shouldFilterResults) {
      for (const [group, checkResults] of Object.entries(groupedResults)) {
        for (const check of checkResults) {
          if (check.issues && check.issues.length > 0 && !explicitChecks!.has(check.checkName)) {
            if (!groupedResultsToUse[group]) {
              groupedResultsToUse[group] = [];
            }
            const alreadyIncluded = groupedResultsToUse[group].some(
              existing => existing.checkName === check.checkName
            );
            if (!alreadyIncluded) {
              groupedResultsToUse[group].push(check);
            }
          }
        }
      }
    }

    // Get executed check names
    const executedCheckNames = Array.from(
      new Set(
        Object.entries(groupedResultsToUse).flatMap(([, checks]) =>
          checks.map(check => check.checkName)
        )
      )
    );

    // Format output based on format type
    logger.step(`Formatting results as ${options.output}`);
    let output: string;
    if (options.output === 'json') {
      output = JSON.stringify(groupedResultsToUse, null, 2);
    } else if (options.output === 'sarif') {
      // Build analysis result and format as SARIF
      const analysisResult: AnalysisResult = {
        repositoryInfo,
        reviewSummary: {
          issues: Object.values(groupedResultsToUse)
            .flatMap(checks => checks.flatMap(check => check.issues || []))
            .flat(),
        },
        executionTime: 0,
        timestamp: new Date().toISOString(),
        checksExecuted: executedCheckNames,
        executionStatistics,
        isCodeReview: includeCodeContext,
      };
      output = OutputFormatters.formatAsSarif(analysisResult);
    } else if (options.output === 'markdown') {
      // Create analysis result for markdown formatting
      const analysisResult: AnalysisResult = {
        repositoryInfo,
        reviewSummary: {
          issues: Object.values(groupedResultsToUse)
            .flatMap(checks => checks.flatMap(check => check.issues || []))
            .flat(),
        },
        executionTime: 0,
        timestamp: new Date().toISOString(),
        checksExecuted: executedCheckNames,
        executionStatistics,
        isCodeReview: includeCodeContext,
      };
      output = OutputFormatters.formatAsMarkdown(analysisResult);
    } else {
      // Create analysis result for table formatting (default)
      const analysisResult: AnalysisResult = {
        repositoryInfo,
        reviewSummary: {
          issues: Object.values(groupedResultsToUse)
            .flatMap(checks => checks.flatMap(check => check.issues || []))
            .flat(),
        },
        executionTime: 0,
        timestamp: new Date().toISOString(),
        checksExecuted: executedCheckNames,
        executionStatistics,
        isCodeReview: includeCodeContext,
      };
      output = OutputFormatters.formatAsTable(analysisResult, { showDetails: true });
    }

    // Send results to debug server if active
    if (debugServer) {
      try {
        const resultsData = JSON.parse(output);
        debugServer.setResults(resultsData);
        console.log('✅ Results sent to debug visualizer');
      } catch (parseErr) {
        console.error('Failed to parse results for debug server:', parseErr);
      }
    }

    if (tui) {
      const chatTranscript = buildChatTranscript(groupedResultsToUse, config);
      tui.setChatContent(chatTranscript);
      tui.setOutput(output);
    }

    // Emit or save output
    if (options.outputFile) {
      try {
        const outPath = path.resolve(process.cwd(), options.outputFile);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, output, 'utf8');
        logger.success(`Saved ${options.output} output to ${outPath}`);
      } catch (writeErr) {
        logger.error(
          `Failed to write output to file: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`
        );
        process.exit(1);
      }
    } else if (!debugServer && !tui) {
      // Only print to console if debug server is not active
      console.log(output);
    }

    // Summarize execution (stderr only; suppressed in JSON/SARIF unless verbose/debug)
    const allResults = Object.values(groupedResultsToUse).flatMap(checks => checks);
    const allIssues = allResults.flatMap((r: CheckResult) => r.issues || []);
    const counts = allIssues.reduce(
      (acc, issue: { severity?: string }) => {
        const sev = (issue.severity || 'info').toLowerCase();
        acc.total++;
        if (sev === 'critical') acc.critical++;
        else if (sev === 'error') acc.error++;
        else if (sev === 'warning' || sev === 'warn') acc.warning++;
        else acc.info++;
        return acc;
      },
      { total: 0, critical: 0, error: 0, warning: 0, info: 0 }
    );

    // Build execution summary for display
    // For user-facing readability, count distinct checks that produced a result
    // (ignores forEach per-item iterations and multi-wave re-executions).
    // Keep detailed per-run counts in executionStatistics for programmatic use.
    const distinctExecuted = new Set(allResults.map((r: any) => r.checkName).filter(Boolean)).size;
    const executionSummary = executionStatistics
      ? `Checks: ${executionStatistics.totalChecksConfigured} configured → ${distinctExecuted} executions`
      : `Completed ${distinctExecuted} check(s)`;

    logger.success(
      `${executionSummary}: ${counts.total} issues (${counts.critical} critical, ${counts.error} error, ${counts.warning} warning)`
    );
    logger.verbose(`Checks executed: ${executedCheckNames.join(', ')}`);

    // Check for critical issues
    const criticalCount = allResults.reduce((sum, result: CheckResult) => {
      const issues = result.issues || [];
      return (
        sum + issues.filter((issue: { severity: string }) => issue.severity === 'critical').length
      );
    }, 0);

    // Check for git repository errors or other fatal errors
    const hasRepositoryError = allResults.some((result: CheckResult) => {
      return result.content.includes('Not a git repository');
    });

    // Cleanup AI sessions before exit to prevent process hanging
    const { SessionRegistry } = await import('./session-registry');
    const sessionRegistry = SessionRegistry.getInstance();
    if (sessionRegistry.getActiveSessionIds().length > 0) {
      logger.debug(
        `🧹 Cleaning up ${sessionRegistry.getActiveSessionIds().length} active AI sessions...`
      );
      sessionRegistry.clearAllSessions();
    }

    // Force exit to prevent hanging from unclosed resources (MCP connections, etc.)
    // This is necessary because some async resources may not be properly cleaned up
    // and can keep the event loop alive indefinitely
    const exitCode = criticalCount > 0 || hasRepositoryError ? 1 : 0;
    // Ensure a trace report exists when enabled (artifact-friendly), even if no spans were recorded
    try {
      if (process.env.VISOR_TRACE_REPORT === 'true') {
        const outDir = process.env.VISOR_TRACE_DIR || path.join(process.cwd(), 'output', 'traces');
        fs.mkdirSync(outDir, { recursive: true });
        const hasReport = fs.readdirSync(outDir).some(f => f.endsWith('.report.html'));
        if (!hasReport) {
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const htmlPath = path.join(outDir, `${ts}.report.html`);
          fs.writeFileSync(
            htmlPath,
            '<!doctype html><html><head><meta charset="utf-8"/><title>Visor Trace Report</title></head><body><h2>Visor Trace Report</h2></body></html>',
            'utf8'
          );
        }
      }
    } catch {}
    // If debug server is running, keep the process alive for re-runs
    if (debugServer) {
      // Don't clear spans - let the UI display them first
      // Spans will be cleared on next execution start
      // debugServer.clearSpans();

      console.log(
        '✅ Execution completed. Debug server still running at http://localhost:' +
          debugServer.getPort()
      );
      console.log('   Press Ctrl+C to exit');

      // Flush telemetry but don't shut down
      try {
        await flushNdjson();
      } catch {}

      // Keep process alive and return without exiting
      return;
    }

    // Normal exit path (no debug server)
    try {
      await flushNdjson();
    } catch {}
    try {
      await shutdownTelemetry();
    } catch {}
    if (tui) {
      try {
        tui.setRunning(false);
      } catch {}
      try {
        logger.setSink(undefined);
      } catch {}
      try {
        if (tuiConsoleRestore) tuiConsoleRestore();
      } catch {}
      try {
        const holdMs = (() => {
          const raw = process.env.VISOR_TUI_HOLD_MS;
          if (!raw) return 60000;
          const parsed = parseInt(raw, 10);
          return Number.isFinite(parsed) ? parsed : 60000;
        })();
        await tui.waitForExit(holdMs);
      } catch {}
    }
    process.exit(exitCode);
  } catch (error) {
    // Import error classes dynamically to avoid circular dependencies
    const { ClaudeCodeSDKNotInstalledError, ClaudeCodeAPIKeyMissingError } = await import(
      './providers/claude-code-check-provider'
    ).catch(() => ({ ClaudeCodeSDKNotInstalledError: null, ClaudeCodeAPIKeyMissingError: null }));

    // Provide user-friendly error messages for known errors
    if (ClaudeCodeSDKNotInstalledError && error instanceof ClaudeCodeSDKNotInstalledError) {
      logger.error('\n❌ Error: Claude Code SDK is not installed.');
      logger.error('To use the claude-code provider, you need to install the required packages:');
      logger.error('\n  npm install @anthropic/claude-code-sdk @modelcontextprotocol/sdk');
      logger.error('\nOr if using yarn:');
      logger.error('\n  yarn add @anthropic/claude-code-sdk @modelcontextprotocol/sdk\n');
    } else if (ClaudeCodeAPIKeyMissingError && error instanceof ClaudeCodeAPIKeyMissingError) {
      logger.error('\n❌ Error: No API key found for Claude Code provider.');
      logger.error('Please set one of the following environment variables:');
      logger.error('  - CLAUDE_CODE_API_KEY');
      logger.error('  - ANTHROPIC_API_KEY');
      logger.error('\nExample:');
      logger.error('  export CLAUDE_CODE_API_KEY="your-api-key-here"\n');
    } else if (error instanceof Error && error.message.includes('No API key configured')) {
      logger.error('\n❌ Error: No API key or credentials configured for AI provider.');
      logger.error('Please set one of the following:');
      logger.error('\nFor Google Gemini:');
      logger.error('  export GOOGLE_API_KEY="your-api-key"');
      logger.error('\nFor Anthropic Claude:');
      logger.error('  export ANTHROPIC_API_KEY="your-api-key"');
      logger.error('\nFor OpenAI:');
      logger.error('  export OPENAI_API_KEY="your-api-key"');
      logger.error('\nFor AWS Bedrock:');
      logger.error('  export AWS_ACCESS_KEY_ID="your-access-key"');
      logger.error('  export AWS_SECRET_ACCESS_KEY="your-secret-key"');
      logger.error('  export AWS_REGION="us-east-1"');
      logger.error('\nOr use API key authentication for Bedrock:');
      logger.error('  export AWS_BEDROCK_API_KEY="your-api-key"\n');
    } else {
      logger.error('❌ Error: ' + (error instanceof Error ? error.message : String(error)));
    }

    // If debug server is running, keep it alive even after error
    if (debugServer) {
      // Don't clear spans - let the UI display them first
      // Spans will be cleared on next execution start
      // debugServer.clearSpans();

      console.log(
        '⚠️  Execution failed. Debug server still running at http://localhost:' +
          debugServer.getPort()
      );
      console.log('   Press Ctrl+C to exit');

      // Flush telemetry but don't shut down
      try {
        await flushNdjson();
        await shutdownTelemetry();
      } catch {}

      // Keep process alive and return without exiting
      return;
    }

    // Normal error exit path (no debug server)
    try {
      await flushNdjson();
    } catch {}
    try {
      await shutdownTelemetry();
    } catch {}
    if (tui) {
      try {
        tui.setRunning(false);
      } catch {}
      try {
        logger.setSink(undefined);
      } catch {}
      try {
        if (tuiConsoleRestore) tuiConsoleRestore();
      } catch {}
      try {
        const holdMs = (() => {
          const raw = process.env.VISOR_TUI_HOLD_MS;
          if (!raw) return 60000;
          const parsed = parseInt(raw, 10);
          return Number.isFinite(parsed) ? parsed : 60000;
        })();
        await tui.waitForExit(holdMs);
      } catch {}
    }
    process.exit(1);
  }
}

// If called directly, run main
if (require.main === module) {
  main();
}
