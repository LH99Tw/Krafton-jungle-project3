import { getCsrfToken, getSessionUser } from "./auth/session";
import { GameShell } from "@/src/features/game/GameShell";
import type { GameStartOptions } from "@/src/game/domain/types";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  let user = null;
  let csrfToken = "";
  try {
    user = await getSessionUser();
    csrfToken = (await getCsrfToken()) ?? "";
  } catch {
    // If DB is offline, fall back gracefully
  }

  const viewer = user
    ? { userId: user.id, displayName: user.displayName, email: user.email, accountType: user.accountType, csrfToken }
    : { userId: "local-guest", displayName: "로컬 용사", email: "developer@localhost", accountType: "guest" as const, csrfToken: "dev-csrf" };

  return <GameShell
    viewer={viewer}
    gameServerUrl={process.env.GAME_SERVER_PUBLIC_URL || ""}
    publicPlaytestEnabled={process.env.PUBLIC_PLAYTEST_ENABLED === "true" || process.env.NODE_ENV !== "production"}
    autoStartOptions={parseAutoStartOptions(query)}
  />;
}

function parseAutoStartOptions(query: Record<string, string | string[] | undefined>): GameStartOptions | null {
  if (query.autostart !== "1") return null;
  const heroClass = ["swordsman", "archer", "mage"].includes(String(query.heroClass))
    ? query.heroClass as GameStartOptions["heroClass"]
    : "swordsman";
  const sessionMode = query.mode === "full" ? "full" : "prototype";
  const difficulty = ["easy", "normal", "hard"].includes(String(query.difficulty))
    ? query.difficulty as GameStartOptions["difficulty"]
    : "normal";
  const partyMode = query.party === "coop" ? "coop" : "solo";
  return { heroClass, sessionMode, difficulty, partyMode };
}
