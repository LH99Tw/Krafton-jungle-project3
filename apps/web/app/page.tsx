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

  const viewer = user
    ? { userId: user.id, displayName: user.displayName, accountType: user.accountType, csrfToken }
    : (process.env.NODE_ENV !== "production"
      ? { userId: "00000000-0000-0000-0000-000000000001", displayName: "마법사", accountType: "guest" as const, csrfToken: "dev-token" }
      : null);

  const initialScreen = (query.lab === "1" || query.screen === "lab") ? "lab" : null;

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
  const isAuto = query.autostart === "1" || query.start === "1" || query.play !== undefined || query.mage === "1" || query.heroClass !== undefined || query.class !== undefined || query.boss === "1" || query.room !== undefined || query.hidden === "1" || query.midboss === "1";
  if (!isAuto) return null;
  const rawClass = String(query.heroClass || query.class || query.play || (query.mage === "1" ? "mage" : "")).toLowerCase();
  const heroClass: GameStartOptions["heroClass"] = ["swordsman", "archer", "mage"].includes(rawClass)
    ? (rawClass as GameStartOptions["heroClass"])
    : "mage";
  const sessionMode = query.mode === "full" ? "full" : "prototype";
  const difficulty = ["easy", "normal", "hard"].includes(String(query.difficulty))
    ? query.difficulty as GameStartOptions["difficulty"]
    : "normal";
  const partyMode = query.party === "coop" ? "coop" : "solo";
  const targetRoomType = query.boss === "1" || query.room === "boss"
    ? "boss"
    : query.hidden === "1" || query.midboss === "1" || query.room === "hidden"
      ? "hidden"
      : undefined;
  return { heroClass, sessionMode, difficulty, partyMode, targetRoomType };
}