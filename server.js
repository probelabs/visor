const express = require('express');
const app = express();

// Security issue: hardcoded secret
const SECRET_KEY = 'hardcoded-secret-123';

app.get('/api/data', (req, res) => {
  // Performance issue: blocking operation
  const data = fs.readFileSync('large-file.json', 'utf8');
  res.json({ data, secret: SECRET_KEY });
});

app.listen(3000);