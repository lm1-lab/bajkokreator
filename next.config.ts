import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    unoptimized: true,
  },
  serverExternalPackages: ["pdf-lib", "@pdf-lib/fontkit", "sharp"],
  outputFileTracingIncludes: {
    "/api/stories/[id]/pdf": ["./public/fonts/**/*", "./public/demo-art/**/*"],
  },
};

export default nextConfig;
