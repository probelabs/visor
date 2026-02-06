#!/usr/bin/env ts-node
/*
  Local simulator for a GitHub Actions run using Visor's engine directly.
  - No network calls
  - Loads config (project or bundled defaults)
  - Maps a minimal GitHub event (issues.opened / issue_comment) to checks
  - Executes via CheckExecutionEngine and prints a concise summary
*/
import path from 'path';
import fs from 'fs';
import { ConfigManager } from '../src/config';
import { EventMapper, GitHubEventContext } from '../src/event-mapper';
import { CheckExecutionEngine } from '../src/check-execution-engine';
import { PRInfo } from '../src/pr-analyzer';

type Args = { event: string; action?: string; debug?: boolean; env?: Record<string,string> };

function parseArgs(): Args {
  const args: Args = { event: 'issues', action: 'opened', debug: true, env: {} };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (k === '--event') args.event = a[++i];
    else if (k === '--action') args.action = a[++i];
    else if (k === '--debug') args.debug = true;
    else if (k === '--env' && a[i+1]) {
      const kv = a[++i];
      kv.split(',').forEach(pair => {
        const [k2,v2] = pair.split('=');
        if (k2 && v2 != null) (args.env as any)[k2] = v2;
      });
    }
  }
  return args;
}

async function main() {
  const { event, action, debug, env } = parseArgs();

  // 1) Load config (project if present, else bundled defaults)
  const cm = new ConfigManager();
  let config = await cm.findAndLoadConfig().catch(() => cm.getDefaultConfig());

  const mapper = new EventMapper(config);

  // 2) Build minimal GitHub event context
  const gh: GitHubEventContext = {
    event_name: event,
    action,
    repository: { owner: { login: 'local' }, name: path.basename(process.cwd()) },
    issue: event === 'issues' || event === 'issue_comment' ? {
      number: 272,
      title: 'Local simulated issue',
      body: 'This is a locally simulated issue body',
      user: { login: 'local-user' },
      labels: [],
      assignees: [],
      state: 'open',
    } : undefined,
    comment: event === 'issue_comment' ? {
      body: '/visor',
      user: { login: 'local-user' },
    } : undefined,
  };

  const mapped = mapper.mapEventToExecution(gh);
  if (!mapped.shouldExecute) {
    console.log(`No checks mapped for event=${event} action=${action}`);
    process.exit(0);
  }

  // 3) Build PRInfo-equivalent for issues (no network)
  const prInfo: PRInfo = {
    number: gh.issue?.number ?? 0,
    title: gh.issue?.title || 'local',
    body: gh.issue?.body || '',
    author: gh.issue?.user?.login || 'local-user',
    base: 'main',
    head: 'local',
    files: [],
    totalAdditions: 0,
    totalDeletions: 0,
    eventType: mapped.executionContext.eventType,
    isIssue: true,
    eventContext: gh as unknown as Record<string, unknown>,
  };

  // 4) Prepare engine and execute
  const engine = new CheckExecutionEngine();
  engine.setExecutionContext({});

  if (env) for (const [k,v] of Object.entries(env)) process.env[k] = v;

  const checksToRun = mapped.checksToRun;
  const { results } = await engine.executeGroupedChecks(
    prInfo,
    checksToRun,
    undefined,
    config,
    'table',
    !!debug
  );

  // 5) Print a compact summary like the Action does
  console.log(`\nChecks Complete`);
  for (const [group, arr] of Object.entries(results)) {
    console.log(`  Group: ${group}`);
    for (const r of arr) {
      const issues = (r.issues || []).length;
      const hasText = (r as any).content && String((r as any).content).trim().length > 0;
      console.log(`   - ${r.checkName}: ${hasText ? 'content' : 'empty'}, ${issues} issue(s)`);
    }
  }
}

main().catch(err => {
  console.error('Simulation failed:', err);
  process.exit(1);
});
