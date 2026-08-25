'use client';

/**
 * Global error boundary. Without this an unhandled error shows the raw Next
 * overlay in dev and a blank page in production — on a till, mid-queue.
 */
export default function GlobalError({
  error, reset,
}: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main style={{
      minHeight: '100dvh', display: 'grid', placeContent: 'center', padding: 32,
      background: '#0E1A14', color: '#F2F6F0', gap: 12,
      fontFamily: 'ui-sans-serif, system-ui, sans-serif', maxWidth: 560, margin: '0 auto',
    }}>
      <h1 style={{ margin: 0, fontSize: 24 }}>Something went wrong</h1>
      <p style={{ color: '#9DB3A4', margin: 0, lineHeight: 1.55 }}>
        No sale has been lost. Anything already completed is saved; anything
        in progress is still in the cart.
      </p>
      <pre style={{
        background: '#16261D', padding: 14, borderRadius: 10, overflowX: 'auto',
        fontSize: 12.5, color: '#9DB3A4', margin: 0,
      }}>{error.message}{error.digest ? `\n\ndigest: ${error.digest}` : ''}</pre>
      <div style={{ display: 'flex', gap: 10 }}>
        <button onClick={reset} style={btn}>Try again</button>
        <a href="/till" style={{ ...btn, textDecoration: 'none', display: 'grid', placeContent: 'center' }}>
          Back to till
        </a>
      </div>
    </main>
  );
}

const btn: React.CSSProperties = {
  minHeight: 56, padding: '0 22px', borderRadius: 10,
  background: '#1E3327', color: '#F2F6F0', border: '1px solid #2A4636',
  font: 'inherit', fontWeight: 650, cursor: 'pointer',
};
