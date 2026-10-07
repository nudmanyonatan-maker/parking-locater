import { defineConfig } from 'vitest/config';

// Unit + API tests run in Node. API tests use a D1 shim over node:sqlite
// (tests/helpers/d1.ts) so they need no Cloudflare account.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
