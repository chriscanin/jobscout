/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@jobscout/core"],
  // Enables `forbidden()` (next/navigation) so a non-allowlisted user gets a
  // genuine HTTP 403 rendered by `src/app/forbidden.tsx` (spec 08 §3 S2).
  experimental: {
    authInterrupts: true,
  },
  webpack(config) {
    // @jobscout/core is an ESM TypeScript package that uses `.js` import
    // extensions (for Node ESM resolution). When Next.js transpiles it via
    // `transpilePackages`, webpack needs to resolve `.js` → `.ts` / `.tsx`.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
