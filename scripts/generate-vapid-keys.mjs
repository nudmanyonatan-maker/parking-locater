#!/usr/bin/env node
// Generates a VAPID key pair for Web Push (base64url, the format used by
// web-push and @block65/webcrypto-web-push). No dependencies.
//   npm run vapid                                                  -> prints KEY=value lines
//   node scripts/generate-vapid-keys.mjs --json | npx wrangler secret bulk   -> stores them as Worker secrets

import { createECDH } from 'node:crypto';

const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const keys = {
  VAPID_PUBLIC_KEY: ecdh.getPublicKey('base64url'),
  // Pad: getPrivateKey() drops a leading zero byte ~1/256 of the time, which breaks JWK import.
  VAPID_PRIVATE_KEY: Buffer.from(ecdh.getPrivateKey('hex').padStart(64, '0'), 'hex').toString('base64url'),
};
if (process.argv.includes('--json')) console.log(JSON.stringify(keys));
else for (const [k, v] of Object.entries(keys)) console.log(`${k}=${v}`);
