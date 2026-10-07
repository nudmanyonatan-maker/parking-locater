#!/usr/bin/env node
// Makes sure the PARKING_KV namespace (the saved car spot) exists in the
// Cloudflare account being deployed to. Keeps the id in wrangler.jsonc when
// that namespace is in the account (the original app's); otherwise finds or
// creates one titled "parking-locator-spot" and writes its id into
// wrangler.jsonc. Used by CI before deploying. Needs CLOUDFLARE_API_TOKEN
// (+ CLOUDFLARE_ACCOUNT_ID) or `wrangler login`.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const TITLE = process.env.KV_TITLE || 'parking-locator-spot';
const wrangler = (...args) => execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const list = () => {
  const out = wrangler('kv', 'namespace', 'list');
  return JSON.parse(out.slice(out.indexOf('['))); // skip any banner before the JSON
};

const path = new URL('../wrangler.jsonc', import.meta.url);
const config = readFileSync(path, 'utf8');
const configured = /"binding":\s*"PARKING_KV",\s*"id":\s*"([^"]*)"/.exec(config)?.[1];
if (!configured) throw new Error('PARKING_KV binding not found in wrangler.jsonc');

let namespaces = list();
let id = namespaces.find((n) => n.id === configured)?.id;
if (id) {
  console.log(`KV namespace ${id} is in this account; keeping it.`);
} else {
  const byTitle = (all) => all.find((n) => n.title === TITLE || n.title.endsWith(`-${TITLE}`))?.id;
  id = byTitle(namespaces);
  if (!id) {
    console.log(`Creating KV namespace "${TITLE}"…`);
    wrangler('kv', 'namespace', 'create', TITLE);
    namespaces = list();
    id = byTitle(namespaces);
  }
  if (!id) throw new Error(`Could not find or create KV namespace "${TITLE}"`);
  writeFileSync(path, config.replace(`"id": "${configured}"`, `"id": "${id}"`));
  console.log(`KV "${TITLE}" = ${id} (wrangler.jsonc updated)`);
}
