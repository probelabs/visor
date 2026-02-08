#!/usr/bin/env node
/**
 * Visor Enterprise License Key Generator
 *
 * Usage:
 *   # Generate a new Ed25519 keypair
 *   node scripts/license-keygen.js keygen
 *
 *   # Sign a license JWT
 *   node scripts/license-keygen.js sign \
 *     --private-key ./visor-private.pem \
 *     --org "Acme Corp" \
 *     --features policy,audit \
 *     --expires 365
 *
 *   # Verify a license JWT
 *   node scripts/license-keygen.js verify \
 *     --public-key ./visor-public.pem \
 *     --token <jwt-string>
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function keygen() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  const pubFile = path.resolve('visor-public.pem');
  const privFile = path.resolve('visor-private.pem');

  fs.writeFileSync(pubFile, pubPem, 'utf8');
  fs.writeFileSync(privFile, privPem, { mode: 0o600, encoding: 'utf8' });

  console.log(`✅ Ed25519 keypair generated:`);
  console.log(`   Public key:  ${pubFile}`);
  console.log(`   Private key: ${privFile}`);
  console.log();
  console.log(`📋 Embed this public key in src/enterprise/license/validator.ts:`);
  console.log();
  console.log(`  private static PUBLIC_KEY =`);
  const lines = pubPem.trim().split('\n');
  lines.forEach((line, i) => {
    const sep = i < lines.length - 1 ? ' +' : ';';
    console.log(`    '${line}\\n'${sep}`);
  });
  console.log();
  console.log(`⚠️  Keep visor-private.pem SECRET. Add it to .gitignore.`);
}

function sign(args) {
  const privKeyPath = getArg(args, '--private-key');
  const org = getArg(args, '--org');
  const featuresStr = getArg(args, '--features') || 'policy';
  const expiresDays = parseInt(getArg(args, '--expires') || '365', 10);

  if (!privKeyPath || !org) {
    console.error('Usage: license-keygen.js sign --private-key <path> --org <name> [--features f1,f2] [--expires days]');
    process.exit(1);
  }

  const privPem = fs.readFileSync(path.resolve(privKeyPath), 'utf8');
  const privateKey = crypto.createPrivateKey(privPem);

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    org,
    features: featuresStr.split(',').map(f => f.trim()),
    exp: now + expiresDays * 86400,
    iat: now,
    sub: `visor-${crypto.randomUUID().slice(0, 8)}`,
  };

  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${header}.${body}`;
  const signature = crypto.sign(null, Buffer.from(data), privateKey);
  const token = `${data}.${signature.toString('base64url')}`;

  console.log(`✅ License JWT signed for "${org}"`);
  console.log(`   Features: ${payload.features.join(', ')}`);
  console.log(`   Expires:  ${new Date(payload.exp * 1000).toISOString().slice(0, 10)} (${expiresDays} days)`);
  console.log(`   License ID: ${payload.sub}`);
  console.log();
  console.log(`📋 Set this as VISOR_LICENSE env var or save to .visor-license:`);
  console.log();
  console.log(token);
}

function verify(args) {
  const pubKeyPath = getArg(args, '--public-key');
  const token = getArg(args, '--token');

  if (!pubKeyPath || !token) {
    console.error('Usage: license-keygen.js verify --public-key <path> --token <jwt>');
    process.exit(1);
  }

  const pubPem = fs.readFileSync(path.resolve(pubKeyPath), 'utf8');
  const publicKey = crypto.createPublicKey(pubPem);

  const parts = token.split('.');
  if (parts.length !== 3) {
    console.error('❌ Invalid JWT format');
    process.exit(1);
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());

  if (header.alg !== 'EdDSA') {
    console.error(`❌ Wrong algorithm: ${header.alg} (expected EdDSA)`);
    process.exit(1);
  }

  const data = `${headerB64}.${payloadB64}`;
  const sig = Buffer.from(signatureB64, 'base64url');
  const valid = crypto.verify(null, Buffer.from(data), publicKey, sig);

  if (!valid) {
    console.error('❌ Invalid signature');
    process.exit(1);
  }

  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
  const expired = Date.now() / 1000 > payload.exp;

  console.log(`✅ Signature valid`);
  console.log(`   Org:      ${payload.org}`);
  console.log(`   Features: ${payload.features.join(', ')}`);
  console.log(`   Issued:   ${new Date(payload.iat * 1000).toISOString().slice(0, 10)}`);
  console.log(`   Expires:  ${new Date(payload.exp * 1000).toISOString().slice(0, 10)}${expired ? ' ⚠️  EXPIRED' : ''}`);
  console.log(`   ID:       ${payload.sub}`);
}

function getArg(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx >= args.length - 1) return null;
  return args[idx + 1];
}

// Main
const command = process.argv[2];
const args = process.argv.slice(3);

switch (command) {
  case 'keygen':
    keygen();
    break;
  case 'sign':
    sign(args);
    break;
  case 'verify':
    verify(args);
    break;
  default:
    console.log(`Visor Enterprise License Key Generator

Commands:
  keygen                    Generate Ed25519 keypair
  sign   --private-key ...  Sign a license JWT
  verify --public-key ...   Verify a license JWT

Examples:
  node scripts/license-keygen.js keygen
  node scripts/license-keygen.js sign --private-key ~/.config/visor/license-private.pem --org "Acme" --features policy --expires 365
  node scripts/license-keygen.js verify --public-key visor-public.pem --token eyJ...`);
}
