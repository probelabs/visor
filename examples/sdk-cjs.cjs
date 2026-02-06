const { loadConfig, runChecks } = require('../dist/sdk/sdk.js');

async function main() {
  // Load config from object - validation and defaults applied automatically
  const config = await loadConfig({ version: '1.0', checks: {} });
  const res = await runChecks({ config, checks: [], output: { format: 'json' } });
  console.log('Issues:', res.reviewSummary.issues?.length || 0);
}

main().catch(err => { console.error(err); process.exit(1); });
