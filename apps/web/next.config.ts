import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  devIndicators: false,
  output: "standalone",
  outputFileTracingRoot: path.join(process.cwd(), "../.."),
  transpilePackages: ["@five-days/auth", "@five-days/db", "@five-days/game-core", "@five-days/protocol"],
  async headers() {
    return [{
      source: "/Asset/:path*",
      headers: [{
        key: "Cache-Control",
        value: "public, max-age=86400, stale-while-revalidate=604800",
      }],
    }];
  },
  webpack(config, { dev }) {
    if (!dev) {
      const disabledEditor = path.resolve(process.cwd(), "src/features/game/DisabledMapEditorScreen.tsx");
      const editorSource = path.resolve(process.cwd(), "src/features/map-editor/MapEditorScreen.tsx");
      const disabledSession = path.resolve(process.cwd(), "src/features/game/DisabledLocalCoreSession.ts");
      const sessionSource = path.resolve(process.cwd(), "src/features/map-editor/LocalCoreSession.ts");
      const disabledWorld = path.resolve(process.cwd(), "src/features/game/DisabledEditorCoreWorld.ts");
      const worldSource = path.resolve(process.cwd(), "src/features/map-editor/editorCoreWorld.ts");
      config.resolve.alias["@/src/features/map-editor/MapEditorScreen$"] = disabledEditor;
      config.resolve.alias[editorSource] = disabledEditor;
      config.resolve.alias["@/src/features/map-editor/LocalCoreSession$"] = disabledSession;
      config.resolve.alias[sessionSource] = disabledSession;
      config.resolve.alias["@/src/features/map-editor/editorCoreWorld$"] = disabledWorld;
      config.resolve.alias[worldSource] = disabledWorld;
    }
    return config;
  },
};

export default nextConfig;
