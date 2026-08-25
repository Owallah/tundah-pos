import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,

  // TypeScript 7 removed `baseUrl`, so the `@/*` alias is declared here for
  // the bundler and in tsconfig `paths` for the type checker. Both are needed.
  webpack(config) {
    config.resolve.alias['@'] = path.join(root, 'src');
    return config;
  },
  turbopack: {
    resolveAlias: { '@': './src' },
  },

  async headers() {
    return [{
      // Receipts are personal documents. Never cache them at the edge.
      source: '/r/:token',
      headers: [
        { key: 'Cache-Control', value: 'private, no-store' },
        { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
      ],
    }];
  },
};
