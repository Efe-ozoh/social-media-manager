import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // resvg and sharp both ship native .node addons, which cannot be inlined
  // into an ESM server chunk; keep them as runtime requires.
  serverExternalPackages: ["@resvg/resvg-js", "sharp"],
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
