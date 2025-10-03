const { runChecks } = require('../dist/sdk/sdk.js');

async function main() {
  const config = { version: '1.0', checks: {} };
  const res = await runChecks({ config, checks: [], output: { format: 'json' } });
  console.log('Issues:', res.reviewSummary.issues?.length || 0);
}

main().catch(err => { console.error(err); process.exit(1); });
