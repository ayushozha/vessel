import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The marketing landing page is a static file; "/" serves it (src/proxy.ts keeps it public).
  async rewrites() {
    return { beforeFiles: [{ source: "/", destination: "/landing.html" }], afterFiles: [], fallback: [] };
  },
};

export default nextConfig;
