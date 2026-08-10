import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(process.cwd(), "../.."),
  transpilePackages: ["@five-days/auth", "@five-days/db", "@five-days/protocol"],
};

export default nextConfig;
