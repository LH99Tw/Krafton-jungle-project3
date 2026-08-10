import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb } from "./index";
import { authSessions, guestbookEntries, matchPlayers, matches, users } from "./schema";

export type UserRecord = typeof users.$inferSelect;

export async function upsertCognitoUser(input: {
  cognitoSub: string;
  email: string;
  displayName: string;
}): Promise<UserRecord> {
  const [user] = await getDb()
    .insert(users)
    .values({ ...input, displayName: input.displayName.slice(0, 60) })
    .onConflictDoUpdate({
      target: users.cognitoSub,
      set: { email: input.email, displayName: input.displayName.slice(0, 60), updatedAt: new Date() },
    })
    .returning();
  return user;
}

export async function createGuestUser(input: { displayName: string }): Promise<UserRecord> {
  const guestId = crypto.randomUUID();
  const [user] = await getDb().insert(users).values({
    cognitoSub: `guest:${guestId}`,
    email: `${guestId}@guest.invalid`,
    displayName: input.displayName,
  }).returning();
  return user;
}

export async function createSession(input: {
  userId: string;
  tokenHash: string;
  encryptedRefreshToken: string;
  expiresAt: Date;
}): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.insert(authSessions).values(input);
    const active = await tx
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(and(eq(authSessions.userId, input.userId), isNull(authSessions.revokedAt)))
      .orderBy(desc(authSessions.createdAt));
    const excess = active.slice(5).map((session) => session.id);
    for (const id of excess) {
      await tx.update(authSessions).set({ revokedAt: new Date() }).where(eq(authSessions.id, id));
    }
  });
}

export async function findSessionUser(tokenHash: string): Promise<UserRecord | null> {
  const idleCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [record] = await getDb()
    .select({ user: users, sessionId: authSessions.id })
    .from(authSessions)
    .innerJoin(users, eq(authSessions.userId, users.id))
    .where(and(
      eq(authSessions.tokenHash, tokenHash),
      isNull(authSessions.revokedAt),
      gt(authSessions.expiresAt, new Date()),
      gt(authSessions.lastSeenAt, idleCutoff),
    ))
    .limit(1);
  if (!record) return null;
  await getDb().update(authSessions).set({ lastSeenAt: new Date() }).where(eq(authSessions.id, record.sessionId));
  return record.user;
}

export async function revokeSession(tokenHash: string): Promise<void> {
  await getDb().update(authSessions).set({ revokedAt: new Date() }).where(eq(authSessions.tokenHash, tokenHash));
}

export async function listGuestbookEntries(limit = 8) {
  return getDb().select({
    id: guestbookEntries.id,
    authorName: guestbookEntries.authorName,
    content: guestbookEntries.content,
    createdAt: guestbookEntries.createdAt,
  }).from(guestbookEntries).orderBy(desc(guestbookEntries.createdAt)).limit(limit);
}

export async function createGuestbookEntry(input: { authorId: string; authorName: string; content: string }) {
  const [entry] = await getDb().insert(guestbookEntries).values(input).returning({
    id: guestbookEntries.id,
    authorName: guestbookEntries.authorName,
    content: guestbookEntries.content,
    createdAt: guestbookEntries.createdAt,
  });
  return entry;
}

export async function listUserRuns(userId: string, limit = 10) {
  return getDb().select({
    matchId: matches.id,
    state: matches.state,
    reason: matches.resultReason,
    day: matches.day,
    elapsedSeconds: matches.durationSeconds,
    heroClass: matchPlayers.heroClass,
    level: matchPlayers.level,
    teamPower: matchPlayers.teamPower,
    damage: matchPlayers.damage,
    bossDamage: matchPlayers.bossDamage,
    kills: matchPlayers.kills,
    deaths: matchPlayers.deaths,
    structuresBuilt: matchPlayers.structuresBuilt,
    createdAt: matches.startedAt,
  }).from(matchPlayers)
    .innerJoin(matches, eq(matchPlayers.matchId, matches.id))
    .where(eq(matchPlayers.userId, userId))
    .orderBy(desc(matches.startedAt))
    .limit(limit);
}

export async function createMatch(input: {
  roomId: string;
  mode: "prototype" | "full";
  difficulty: "easy" | "normal" | "hard";
  seed: string;
  protocolVersion: number;
  serverVersion: string;
}) {
  const [match] = await getDb().insert(matches).values(input).returning();
  return match;
}

export type FinalPlayerResult = {
  userId: string;
  heroClass: string;
  level: number;
  teamPower: number;
  damage: number;
  bossDamage: number;
  kills: number;
  deaths: number;
  structuresBuilt: number;
  goldSpent: number;
  gatesDestroyed: number;
  disconnected: boolean;
};

export async function finalizeMatch(input: {
  matchId: string;
  state: "victory" | "defeat" | "abandoned" | "server_error";
  reason: string;
  day: number;
  durationSeconds: number;
  players: FinalPlayerResult[];
}): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const [match] = await tx.select({ state: matches.state }).from(matches)
      .where(eq(matches.id, input.matchId)).for("update");
    if (!match || match.state !== "running") return false;

    await tx.update(matches).set({
      state: input.state,
      resultReason: input.reason.slice(0, 240),
      day: Math.max(1, Math.min(5, input.day)),
      durationSeconds: Math.max(0, Math.min(3600, Math.round(input.durationSeconds))),
      endedAt: new Date(),
    }).where(eq(matches.id, input.matchId));

    for (const player of input.players) {
      await tx.insert(matchPlayers).values({ matchId: input.matchId, ...player })
        .onConflictDoUpdate({
          target: [matchPlayers.matchId, matchPlayers.userId],
          set: { ...player, leftAt: new Date() },
        });
    }
    return true;
  });
}

export async function countUsers(): Promise<number> {
  const [row] = await getDb().select({ value: sql<number>`count(*)::int` }).from(users);
  return row?.value ?? 0;
}
