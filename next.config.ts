import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // resvg ships a native .node addon, which cannot be inlined into an ESM
  // server chunk; keep it as a runtime require.
  serverExternalPackages: ["@resvg/resvg-js"],
  // The renderer reads bundled woff2 files from node_modules at runtime;
  // make sure a traced/serverless build ships them with the preview route.
  outputFileTracingIncludes: {
    "/api/render/preview": ["./node_modules/@fontsource/**/*.woff2"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
