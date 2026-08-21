/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  /**
   * Standalone output, for the self-hosted edition.
   *
   * Produces a `.next/standalone` tree carrying its own minimal `node_modules`,
   * so the runtime image does not need the ~900 MB dependency tree the build
   * needed. It changes nothing about a Vercel deployment, which ignores this
   * field, so `main` keeps deploying exactly as it does today.
   */
  output: 'standalone',
  turbopack: {
    root: import.meta.dirname,
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'microphone=(self), camera=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
