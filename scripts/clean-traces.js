const fs = require('fs');
const path = require('path');

const roots = ['output/traces', 'dist/traces', 'dist/output/traces'];

for (const rel of roots) {
  const target = path.resolve(process.cwd(), rel);
  fs.rmSync(target, { recursive: true, force: true });
}
