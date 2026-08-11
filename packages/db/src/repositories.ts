import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "./index";
import { authSessions, gameTicketNonces, guestbookEntries, matchPlayers, matches, users } from "./schema";

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
  encryptedRefreshToken?: string | null;
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
    .select({ user: users, sessionId: authSessions.id, lastSeenAt: authSessions.lastSeenAt })
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
  const touchBefore = new Date(Date.now() - 5 * 60_000);
  if (record.lastSeenAt < touchBefore) {
    await getDb().update(authSessions).set({ lastSeenAt: new Date() })
      .where(and(eq(authSessions.id, record.sessionId), lt(authSessions.lastSeenAt, touchBefore)));
  }
  return record.user;
}

export async function revokeSession(tokenHash: string): Promise<void> {
  await getDb().update(authSessions).set({ revokedAt: new Date() }).where(eq(authSessions.tokenHash, tokenHash));
}

export async function registerGameTicket(input: {
  jti: string;
  userId: string;
  room: "global_chat" | "lobby" | "party";
  expiresAt: Date;
}): Promise<void> {
  await getDb().insert(gameTicketNonces).values(input);
}

export async function consumeGameTicketNonce(input: {
  jti: string;
  userId: string;
  room: "global_chat" | "lobby" | "party";
}): Promise<boolean> {
  const [consumed] = await getDb().update(gameTicketNonces)
    .set({ consumedAt: new Date() })
    .where(and(
      eq(gameTicketNonces.jti, input.jti),
      eq(gameTicketNonces.userId, input.userId),
      eq(gameTicketNonces.room, input.room),
      isNull(gameTicketNonces.consumedAt),
      gt(gameTicketNonces.expiresAt, new Date()),
    ))
    .returning({ jti: gameTicketNonces.jti });
  return Boolean(consumed);
}

export async function cleanupExpiredSecurityRecords(batchSize = 500): Promise<void> {
  const limit = Math.max(1, Math.min(2_000, Math.trunc(batchSize)));
  await getDb().execute(sql`
    DELETE FROM ${gameTicketNonces}
    WHERE jti IN (
      SELECT jti FROM ${gameTicketNonces}
      WHERE expires_at <= now()
      ORDER BY expires_at
      LIMIT ${limit}
    )
  `);
  await getDb().execute(sql`
    DELETE FROM ${authSessions}
    WHERE id IN (
      SELECT id FROM ${authSessions}
      WHERE expires_at <= now() OR revoked_at IS NOT NULL
      ORDER BY expires_at
      LIMIT ${limit}
    )
  `);
  await getDb().execute(sql`
    DELETE FROM ${users} AS candidate
    WHERE candidate.id IN (
      SELECT u.id FROM ${users} AS u
      WHERE u.cognito_sub LIKE 'guest:%'
        AND u.created_at < now() - interval '1 day'
        AND NOT EXISTS (SELECT 1 FROM ${authSessions} s WHERE s.user_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM ${guestbookEntries} g WHERE g.author_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM ${matchPlayers} p WHERE p.user_id = u.id)
      ORDER BY u.created_at
      LIMIT ${limit}
    )
  `);
}

export async function listGuestbookEntries(limit = 8) {
  return getDb().select({
    id: guestbookEntries.id,
    authorName: guestbookEntries.authorName,
    content: guestbookEntries.content,
    positionX: guestbookEntries.positionX,
    positionY: guestbookEntries.positionY,
    createdAt: guestbookEntries.createdAt,
    updatedAt: guestbookEntries.updatedAt,
  }).from(guestbookEntries).orderBy(desc(guestbookEntries.createdAt)).limit(limit);
}

export async function createGuestbookEntry(input: {
  authorId?: string | null;
  authorName: string;
  content: string;
  editPasswordHash: string;
  positionX: number;
  positionY: number;
}) {
  const [entry] = await getDb().insert(guestbookEntries).values(input).returning({
    id: guestbookEntries.id,
    authorName: guestbookEntries.authorName,
    content: guestbookEntries.content,
    positionX: guestbookEntries.positionX,
    positionY: guestbookEntries.positionY,
    createdAt: guestbookEntries.createdAt,
    updatedAt: guestbookEntries.updatedAt,
  });
  return entry;
}

export async function getGuestbookEntryPasswordHash(id: string): Promise<string | null | undefined> {
  const [entry] = await getDb().select({ editPasswordHash: guestbookEntries.editPasswordHash })
    .from(guestbookEntries)
    .where(eq(guestbookEntries.id, id))
    .limit(1);
  return entry?.editPasswordHash;
}

export async function updateGuestbookEntry(input: {
  id: string;
  authorName?: string;
  content?: string;
  positionX?: number;
  positionY?: number;
}) {
  const { id, ...values } = input;
  const [entry] = await getDb().update(guestbookEntries)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(guestbookEntries.id, id))
    .returning({
      id: guestbookEntries.id,
      authorName: guestbookEntries.authorName,
      content: guestbookEntries.content,
      positionX: guestbookEntries.positionX,
      positionY: guestbookEntries.positionY,
      createdAt: guestbookEntries.createdAt,
      updatedAt: guestbookEntries.updatedAt,
    });
  return entry;
}

export async function deleteGuestbookEntry(id: string): Promise<boolean> {
  const [deleted] = await getDb().delete(guestbookEntries)
    .where(eq(guestbookEntries.id, id))
    .returning({ id: guestbookEntries.id });
  return Boolean(deleted);
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
