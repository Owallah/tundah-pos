import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * A source-level guard, not a behavioural test.
 *
 * Next.js inlines NEXT_PUBLIC_* vars into the client bundle by static string
 * replacement. `process.env[name]` cannot be analysed statically, so it
 * silently yields undefined in the browser while working fine on the server.
 * That asymmetry makes it a genuinely nasty bug: it passes SSR, then throws
 * on hydration with a message that points at the env file rather than the
 * code.
 *
 * Refactoring the literals into a helper or a loop reintroduces it, and that
 * refactor looks like an improvement. Hence this test.
 */
/** Strip comments so the guard inspects code, not the prose explaining it. */
function codeOnly(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('Supabase env access', () => {
  const source = codeOnly('src/lib/supabase/clients.ts');

  it('reads public env vars as literals, never dynamically', () => {
    expect(source).toMatch(/process\.env\.NEXT_PUBLIC_SUPABASE_URL/);
    expect(source).toMatch(/process\.env\.NEXT_PUBLIC_SUPABASE_ANON_KEY/);

    // process.env[...] with anything other than a literal key.
    expect(source).not.toMatch(/process\.env\[/);
  });

  it('keeps the service role key off the NEXT_PUBLIC_ prefix', () => {
    expect(source).toMatch(/process\.env\.SUPABASE_SERVICE_ROLE_KEY/);
    expect(source).not.toMatch(/NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('refuses to build a service client in the browser', () => {
    expect(source).toMatch(/typeof window !== 'undefined'/);
  });
});

describe('middleware env access', () => {
  const source = codeOnly('src/middleware.ts');

  it('also uses literals', () => {
    expect(source).toMatch(/process\.env\.NEXT_PUBLIC_SUPABASE_URL/);
    expect(source).not.toMatch(/process\.env\[/);
  });
});
