import { getCsrfToken, getSessionUser } from "./auth/session";
import { GameShell } from "@/src/features/game/GameShell";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getSessionUser();
  const viewer = user
    ? { userId: user.id, displayName: user.displayName, email: user.email, csrfToken: await getCsrfToken() ?? "" }
    : null;

  return <GameShell
    viewer={viewer}
    gameServerUrl={process.env.GAME_SERVER_PUBLIC_URL ?? "ws://localhost:2567"}
  />;
}
