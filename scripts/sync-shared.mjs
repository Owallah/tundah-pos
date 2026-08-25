#!/usr/bin/env node
/**
 * Edge Functions run on Deno and cannot reach into src/. Rather than let two
 * copies of the Daraja client drift, the canonical file lives in src/ and is
 * mirrored here. `--check` fails CI if they diverge, which turns silent drift
 * into a red build.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const FILES = [
  ['src/lib/mpesa/daraja.ts', 'supabase/functions/_shared/daraja.ts'],
];

const BANNER = `// GENERATED FILE — do not edit.
// Canonical source: %SRC%
// Run \`npm run sync:shared\` after changing it.
`;

const check = process.argv.includes('--check');
let failed = false;

for (const [src, dest] of FILES) {
  const body = readFileSync(src, 'utf8')
    // Deno resolves relative imports with explicit extensions.
    .replace(/from '\.\.\/money\/money'/g, "from './money.ts'");
  const out = BANNER.replace('%SRC%', src) + body;

  if (check) {
    if (!existsSync(dest) || readFileSync(dest, 'utf8') !== out) {
      console.error(`OUT OF SYNC: ${dest}\n  Run: npm run sync:shared`);
      failed = true;
    }
  } else {
    writeFileSync(dest, out);
    console.log(`synced ${src} -> ${dest}`);
  }
}

if (check && !failed) console.log('Shared files are in sync.');
process.exit(failed ? 1 : 0);
