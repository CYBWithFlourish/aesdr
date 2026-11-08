import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The workspace packages ship CommonJS builds that the app imports directly.
  transpilePackages: ["@aesdr/sdk", "@aesdr/client"],
};

export default nextConfig;
