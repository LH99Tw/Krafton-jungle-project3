import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  devIndicators: false,
  output: "standalone",
  outputFileTracingRoot: path.join(process.cwd(), "../.."),
  transpilePackages: ["@five-days/auth", "@five-days/db", "@five-days/protocol"],
  webpack(config, { dev }) {
    if (!dev) {
      const disabledEditor = path.resolve(process.cwd(), "src/features/game/DisabledMapEditorScreen.tsx");
      const editorSource = path.resolve(process.cwd(), "src/features/map-editor/MapEditorScreen.tsx");
      config.resolve.alias["@/src/features/map-editor/MapEditorScreen$"] = disabledEditor;
      config.resolve.alias[editorSource] = disabledEditor;
    }
    return config;
  },
};

export default nextConfig;
