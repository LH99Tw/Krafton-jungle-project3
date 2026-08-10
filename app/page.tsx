import { getChatGPTUser } from "./chatgpt-auth";
import { GameShell } from "@/src/features/game/GameShell";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getChatGPTUser();
  const viewer = user
    ? { userId: user.userId, displayName: user.displayName, email: user.email }
    : null;

  return <GameShell viewer={viewer} />;
}

