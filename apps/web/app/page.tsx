import { getCsrfToken, getSessionState } from "./auth/session";
import { GameShell } from "@/src/features/game/GameShell";
import type { GameStartOptions } from "@/src/game/domain/types";
import { headers } from "next/headers";
import { clientIpFromHeaders, consumeRateLimit, securityNumber } from "./security/request";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  let user = null;
  let csrfToken = "";
  let sessionUnavailable = false;
  try {
    const requestHeaders = await headers();
    const decision = consumeRateLimit("page-session-ip", clientIpFromHeaders(requestHeaders), {
      capacity: securityNumber("SESSION_PER_MINUTE", 120),
      refillMs: 60_000,
    });
    if (!decision.allowed) sessionUnavailable = true;
    else {
      const session = await getSessionState();
      sessionUnavailable = session.status === "unavailable";
      user = session.status === "authenticated" ? session.user : null;
      if (user) csrfToken = (await getCsrfToken()) ?? "";
    }
  } catch {
    sessionUnavailable = true;
  }

  // A development-only session fallback must not pretend to be authenticated:
  // without a matching CSRF cookie, subsequent mutation requests are rejected.
  const viewer = user && csrfToken
    ? { userId: user.id, displayName: user.displayName, accountType: user.accountType, csrfToken }
    : null;

  const initialScreen = null;

  return <GameShell
    viewer={viewer}
    gameServerUrl={process.env.GAME_SERVER_PUBLIC_URL || (process.env.NODE_ENV !== "production" ? "ws://localhost:2567" : "")}
    publicPlaytestEnabled={process.env.PUBLIC_PLAYTEST_ENABLED === "true" || process.env.NODE_ENV !== "production"}
    localMapEditorEnabled={process.env.NODE_ENV !== "production"}
    autoStartOptions={parseAutoStartOptions(query)}
    sessionUnavailable={sessionUnavailable}
    initialScreen={initialScreen}
  />;
}

function parseAutoStartOptions(query: Record<string, string | string[] | undefined>): GameStartOptions | null {
  const isAuto = query.autostart === "1" || query.start === "1" || query.play !== undefined || query.heroClass !== undefined || query.class !== undefined;
  if (!isAuto) return null;
  const rawClass = String(query.heroClass || query.class || query.play || "").toLowerCase();
  const heroClass: GameStartOptions["heroClass"] = ["swordsman", "archer", "mage"].includes(rawClass)
    ? (rawClass as GameStartOptions["heroClass"])
    : "swordsman";
  const sessionMode = query.mode === "full" ? "full" : "prototype";
  const difficulty: GameStartOptions["difficulty"] = query.difficulty === "hard" ? "hard" : "normal";
  const partyMode = query.party === "coop" ? "coop" : "solo";
  return { heroClass, sessionMode, difficulty, partyMode };
}
