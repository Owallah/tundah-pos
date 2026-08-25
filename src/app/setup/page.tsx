import { headers } from 'next/headers';

export const dynamic = 'force-dynamic';

/**
 * /setup — configuration health check.
 *
 * Exists because a missing environment variable in production surfaces as
 * "An error occurred in the Server Components render" plus a digest, which
 * tells you nothing. This page turns that into a list of what is actually
 * missing.
 *
 * SAFE BY CONSTRUCTION: it reports presence, length and shape only. No
 * secret value is ever rendered, logged, or included in the HTML. Adding a
 * value to this page would be a security regression — do not.
 */

interface Check {
  name: string;
  present: boolean;
  detail: string;
  critical: boolean;
  hint: string;
}

function shapeOf(value: string | undefined, expect: RegExp, label: string): string {
  if (!value) return 'not set';
  if (!expect.test(value)) return `set, but does not look like ${label}`;
  return `set (${value.length} chars)`;
}

export default async function SetupPage() {
  // Literal references — Next inlines NEXT_PUBLIC_* by static string
  // replacement, so a dynamic lookup would read as undefined in the browser
  // bundle even when the value is present.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const businessId = process.env.BUSINESS_ID;
  const etims = process.env.ETIMS_PROVIDER;
  const mpesa = process.env.MPESA_PROVIDER;

  const checks: Check[] = [
    {
      name: 'NEXT_PUBLIC_SUPABASE_URL',
      present: Boolean(url),
      detail: shapeOf(url, /^https:\/\/.+\.supabase\.co\/?$/, 'a Supabase URL'),
      critical: true,
      hint: 'Project Settings → API → Project URL. Must start with https:// and end in .supabase.co',
    },
    {
      name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      present: Boolean(anon),
      detail: shapeOf(anon, /^(eyJ|sb_publishable_)/, 'an anon/publishable key'),
      critical: true,
      hint: 'Project Settings → API → anon (or publishable) key.',
    },
    {
      name: 'SUPABASE_SERVICE_ROLE_KEY',
      present: Boolean(service),
      detail: shapeOf(service, /^(eyJ|sb_secret_)/, 'a service role/secret key'),
      critical: false,
      hint: 'Only the public receipt route needs it. Never give it a NEXT_PUBLIC_ prefix.',
    },
    {
      name: 'BUSINESS_ID',
      present: Boolean(businessId),
      detail: businessId ? 'set' : 'not set',
      critical: false,
      hint: 'Needed by the M-Pesa webhooks, not by the web app.',
    },
    {
      name: 'ETIMS_PROVIDER',
      present: true,
      detail: etims ?? 'not set (defaults to null — correct before KRA go-live)',
      critical: false,
      hint: 'null | mock | oscu',
    },
    {
      name: 'MPESA_PROVIDER',
      present: true,
      detail: mpesa ?? 'not set (defaults to ncba-paybill)',
      critical: false,
      hint: 'daraja-till | ncba-paybill | ncba-hosted',
    },
  ];

  const blocking = checks.filter((c) => c.critical && !c.present);

  // Reachability is only worth testing once the two critical vars exist.
  let reachable: string | null = null;
  if (blocking.length === 0 && url && anon) {
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/`, {
        headers: { apikey: anon },
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      });
      reachable = res.ok || res.status === 404
        ? 'Supabase responded'
        : `Supabase returned HTTP ${res.status}`;
    } catch (err) {
      reachable = `Could not reach Supabase: ${(err as Error).message}`;
    }
  }

  const host = (await headers()).get('host') ?? 'unknown';

  return (
    <main style={wrap}>
      <div style={card}>
        <h1 style={{ margin: 0, fontSize: 26 }}>Configuration check</h1>
        <p style={{ color: '#9DBCA8', margin: '6px 0 22px' }}>
          {host} · {process.env.NODE_ENV}
        </p>

        {blocking.length > 0 ? (
          <div style={{ ...banner, background: 'rgba(255,92,92,.14)', color: '#FF5C5C' }}>
            <strong>
              {blocking.length} required variable{blocking.length > 1 ? 's are' : ' is'} missing.
            </strong>
            <p style={{ margin: '6px 0 0', color: '#9DBCA8' }}>
              This is what causes the &ldquo;Server Components render&rdquo; error on
              every page. See the fix below.
            </p>
          </div>
        ) : (
          <div style={{ ...banner, background: 'rgba(63,207,142,.14)', color: '#3FCF8E' }}>
            <strong>All required variables are set.</strong>
            {reachable && (
              <p style={{ margin: '6px 0 0', color: '#9DBCA8' }}>{reachable}</p>
            )}
          </div>
        )}

        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 20 }}>
          <tbody>
            {checks.map((c) => (
              <tr key={c.name} style={{ borderBottom: '1px solid #145232' }}>
                <td style={{ padding: '12px 0', verticalAlign: 'top' }}>
                  <code style={{ fontSize: 13.5 }}>{c.name}</code>
                  {c.critical && !c.present && (
                    <div style={{ color: '#9DBCA8', fontSize: 12.5, marginTop: 4 }}>
                      {c.hint}
                    </div>
                  )}
                </td>
                <td style={{
                  padding: '12px 0', textAlign: 'right', fontSize: 13.5,
                  color: c.present ? '#3FCF8E' : c.critical ? '#FF5C5C' : '#9DBCA8',
                }}>
                  {c.detail}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {blocking.length > 0 && (
          <div style={{ marginTop: 26 }}>
            <h2 style={{ fontSize: 17, marginBottom: 10 }}>Fix on Netlify</h2>
            <ol style={{ color: '#9DBCA8', lineHeight: 1.75, paddingLeft: 20, margin: 0 }}>
              <li>Site configuration → Environment variables</li>
              <li>Add each missing variable, scope <b>All deploy contexts</b></li>
              <li>
                <b>Deploys → Trigger deploy → Clear cache and deploy site.</b>{' '}
                <code>NEXT_PUBLIC_*</code> values are baked into the bundle at
                build time — adding them without rebuilding changes nothing.
              </li>
            </ol>
          </div>
        )}

        <p style={{ color: '#5F8570', fontSize: 12.5, marginTop: 26 }}>
          This page never renders a secret value — only whether one is present
          and whether it has the expected shape.
        </p>
      </div>
    </main>
  );
}

const wrap: React.CSSProperties = {
  minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 24,
  background: '#04150c', color: '#F4F8F2',
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
};
const card: React.CSSProperties = {
  width: '100%', maxWidth: 620, padding: 32,
  background: 'rgba(7,42,24,.78)', border: '1px solid rgba(255,255,255,.08)',
  borderRadius: 20,
};
const banner: React.CSSProperties = {
  padding: '14px 18px', borderRadius: 12, fontSize: 14.5,
};
