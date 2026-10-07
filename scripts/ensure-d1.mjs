#!/usr/bin/env node
// Finds (or creates) the "parknearme" D1 database in the Cloudflare account and
// writes its id into wrangler.jsonc. Used by CI before building; also handy
// for a first manual deploy. Needs CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID)
// or `wrangler login`.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const NAME = process.env.D1_NAME || 'parknearme';
const wrangler = (...args) => execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

function findId() {
  const list = JSON.parse(wrangler('d1', 'list', '--json'));
  return list.find((db) => db.name === NAME)?.uuid ?? null;
}

let id = findId();
if (!id) {
  console.log(`Creating D1 database "${NAME}"…`);
  wrangler('d1', 'create', NAME);
  id = findId();
}
if (!id) throw new Error(`Could not find or create D1 database "${NAME}"`);

const path = new URL('../wrangler.jsonc', import.meta.url);
const config = readFileSync(path, 'utf8');
const next = config.replace(/("database_id":\s*")[^"]*(")/, `$1${id}$2`);
if (next === config && !config.includes(id)) throw new Error('database_id not found in wrangler.jsonc');
writeFileSync(path, next);
console.log(`D1 "${NAME}" = ${id} (wrangler.jsonc updated)`);
