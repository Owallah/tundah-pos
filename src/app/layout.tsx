import type { Metadata, Viewport } from 'next';
import '../styles/brand.css';
import '../styles/till.css';

export const metadata: Metadata = {
  title: 'Tundah Taamu Delights — POS',
  description: 'Point of sale for Tundah Taamu Delights',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/logo.png', apple: '/logo.png' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  // A cashier tapping quickly must not accidentally pinch-zoom the till.
  userScalable: false,
  themeColor: '#05572f',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
