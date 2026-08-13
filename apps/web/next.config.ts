import type { NextConfig } from "next";
import path from "node:path";

// Public game assets are referenced by stable URLs from Phaser and React.
// Force browsers/CDNs to revalidate them after every deployment so replacing
// a sprite under an existing filename cannot leave a stale sheet paired with
// the latest frame metadata. Next's hashed /_next/static assets retain their
// own immutable caching policy.
const REVALIDATE_PUBLIC_ASSET = {
  key: "Cache-Control",
  value: "public, max-age=0, must-revalidate",
} as const;

const nextConfig: NextConfig = {
  devIndicators: false,
  output: "standalone",
  outputFileTracingRoot: path.join(process.cwd(), "../.."),
  transpilePackages: ["@five-days/auth", "@five-days/db", "@five-days/game-core", "@five-days/protocol"],
  async headers() {
    return ["/Asset/:path*", "/images/:path*", "/audio/:path*"].map((source) => ({
      source,
      headers: [REVALIDATE_PUBLIC_ASSET],
    }));
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
