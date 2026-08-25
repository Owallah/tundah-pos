import Link from 'next/link';

export default function NotFound() {
  return (
    <main style={{
      minHeight: '100dvh', display: 'grid', placeContent: 'center', padding: 32,
      background: '#0E1A14', color: '#F2F6F0', gap: 10, textAlign: 'center',
      fontFamily: 'ui-sans-serif, system-ui, sans-serif',
    }}>
      <h1 style={{ margin: 0, fontSize: 24 }}>Not found</h1>
      <p style={{ color: '#9DB3A4', margin: 0 }}>
        That page does not exist. If you followed a receipt link, it may have
        been mistyped.
      </p>
      <Link href="/" style={{ color: '#3ECF8E' }}>Go back</Link>
    </main>
  );
}
