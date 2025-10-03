import { runChecks } from '../dist/sdk/sdk.mjs';

async function main() {
  const config = { version: '1.0', checks: {} };
  const res = await runChecks({ config, checks: [], output: { format: 'json' }, debug: false });
  console.log(JSON.stringify({ totalIssues: res.reviewSummary.issues?.length || 0 }, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
