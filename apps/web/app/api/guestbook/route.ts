import {
  createGuestbookEntry,
  deleteGuestbookEntry,
  getGuestbookEntryPasswordHash,
  listGuestbookEntries,
  updateGuestbookEntry,
} from "@five-days/db/repositories";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { apiError, getSessionState } from "@/app/auth/session";
import {
  clientIp,
  consumeRateLimit,
  hasAllowedOrigin,
  payloadError,
  rateLimited,
  readJsonLimited,
  securityNumber,
} from "@/app/security/request";

const MAX_ENTRIES = 80;
const DEFAULT_AUTHOR = "익명의 방문자";
const ADMIN_DELETE_KEY = process.env.GUESTBOOK_ADMIN_DELETE_KEY;
const scryptAsync = promisify(scrypt);
let guestbookCache: { expiresAt: number; entries: Awaited<ReturnType<typeof listGuestbookEntries>> } = { expiresAt: 0, entries: [] };

export async function GET(request: Request) {
  const decision = consumeRateLimit("guestbook-read-ip", clientIp(request), { capacity: securityNumber("READ_API_PER_MINUTE", 60), refillMs: 60_000 });
  if (!decision.allowed) return rateLimited(decision.retryAfterSeconds);
  try {
    const now = Date.now();
    if (guestbookCache.expiresAt <= now) guestbookCache = { expiresAt: now + 1_000, entries: await listGuestbookEntries(MAX_ENTRIES) };
    return Response.json({ entries: guestbookCache.entries });
  } catch {
    return Response.json({ entries: [], unavailable: true }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const access = await mutationAccess(request);
  if (access.response) return access.response;
  let payload: GuestbookPayload;
  try {
    payload = await readJsonLimited<GuestbookPayload>(request, 4096);
  } catch (error) {
    return payloadError(error) ?? apiError("INVALID_JSON", "잘못된 요청입니다.", 400);
  }
  const validated = validateEntry(payload, true);
  if (validated instanceof Response) return validated;
  const password = validPassword(payload.password);
  if (!password) return validationError("INVALID_PASSWORD", "비밀번호를 확인해 주세요.");
  try {
    const entry = await createGuestbookEntry({
      authorId: access.authorId,
      authorName: validated.authorName!,
      content: validated.content!,
      editPasswordHash: await hashPassword(password),
      positionX: validated.positionX!,
      positionY: validated.positionY!,
    });
    clearCache();
    return Response.json({ entry }, { status: 201 });
  } catch {
    return apiError("GUESTBOOK_UNAVAILABLE", "방명록 저장소를 사용할 수 없습니다.", 503);
  }
}

export async function PATCH(request: Request) {
  const access = await mutationAccess(request);
  if (access.response) return access.response;
  let payload: GuestbookPayload & { id?: unknown };
  try {
    payload = await readJsonLimited<GuestbookPayload & { id?: unknown }>(request, 4096);
  } catch (error) {
    return payloadError(error) ?? apiError("INVALID_JSON", "잘못된 요청입니다.", 400);
  }
  const id = validId(payload.id);
  if (!id) return apiError("INVALID_ID", "방명록 항목을 찾을 수 없습니다.", 400);
  const validated = validateEntry(payload, false);
  if (validated instanceof Response) return validated;
  if (Object.keys(validated).length === 0) return apiError("NO_CHANGES", "변경할 내용이 없습니다.", 400);
  try {
    const passwordError = await requireEntryPassword(id, payload.password);
    if (passwordError) return passwordError;
    const entry = await updateGuestbookEntry({ id, ...validated });
    if (!entry) return apiError("NOT_FOUND", "이미 삭제된 방명록입니다.", 404);
    clearCache();
    return Response.json({ entry });
  } catch {
    return apiError("GUESTBOOK_UNAVAILABLE", "방명록 저장소를 사용할 수 없습니다.", 503);
  }
}

export async function DELETE(request: Request) {
  const access = await mutationAccess(request);
  if (access.response) return access.response;
  let payload: { id?: unknown; password?: unknown };
  try {
    payload = await readJsonLimited<{ id?: unknown; password?: unknown }>(request, 1024);
  } catch (error) {
    return payloadError(error) ?? apiError("INVALID_JSON", "잘못된 요청입니다.", 400);
  }
  const id = validId(payload.id);
  if (!id) return apiError("INVALID_ID", "방명록 항목을 찾을 수 없습니다.", 400);
  try {
    const passwordError = isAdminDeleteKey(payload.password)
      ? null
      : await requireEntryPassword(id, payload.password);
    if (passwordError) return passwordError;
    if (!await deleteGuestbookEntry(id)) return apiError("NOT_FOUND", "이미 삭제된 방명록입니다.", 404);
    clearCache();
    return new Response(null, { status: 204 });
  } catch {
    return apiError("GUESTBOOK_UNAVAILABLE", "방명록 저장소를 사용할 수 없습니다.", 503);
  }
}

type GuestbookPayload = {
  authorName?: unknown;
  content?: unknown;
  password?: unknown;
  positionX?: unknown;
  positionY?: unknown;
};

function validateEntry(payload: GuestbookPayload, requireAll: boolean): Partial<{ authorName: string; content: string; positionX: number; positionY: number }> | Response {
  const result: Partial<{ authorName: string; content: string; positionX: number; positionY: number }> = {};
  if (requireAll || payload.authorName !== undefined) {
    const authorName = typeof payload.authorName === "string" ? payload.authorName.trim() : "";
    result.authorName = authorName || DEFAULT_AUTHOR;
    if (result.authorName.length > 24) return validationError("INVALID_AUTHOR", "이름은 24자 이하로 작성해 주세요.");
  }
  if (requireAll || payload.content !== undefined) {
    const content = typeof payload.content === "string" ? payload.content.trim() : "";
    if (content.length < 2 || content.length > 180) return validationError("INVALID_CONTENT", "메시지는 2~180자로 작성해 주세요.");
    result.content = content;
  }
  for (const key of ["positionX", "positionY"] as const) {
    if (requireAll || payload[key] !== undefined) {
      const value = Number(payload[key]);
      if (!Number.isFinite(value) || value < 0 || value > 1000) return validationError("INVALID_POSITION", "메모 위치가 올바르지 않습니다.");
      result[key] = Math.round(value);
    }
  }
  return result;
}

async function mutationAccess(request: Request): Promise<
  | { response: Response; authorId: null }
  | { response: null; authorId: string | null }
> {
  if (!hasAllowedOrigin(request)) {
    return { response: await apiError("ORIGIN_INVALID", "요청을 확인할 수 없습니다.", 403), authorId: null };
  }
  const ip = clientIp(request);
  const capacity = securityNumber("GUESTBOOK_PER_MINUTE", 5);
  const ipDecision = consumeRateLimit("guestbook-write-ip", ip, {
    capacity,
    refillMs: 60_000,
  });
  if (!ipDecision.allowed) return { response: rateLimited(ipDecision.retryAfterSeconds), authorId: null };

  const session = await getSessionState();
  if (session.status === "unavailable") {
    return { response: await apiError("SESSION_UNAVAILABLE", "세션 저장소를 사용할 수 없습니다.", 503), authorId: null };
  }
  const authorId = session.status === "authenticated" ? session.user.id : null;
  const userKey = authorId ?? `anonymous:${ip}`;
  const userDecision = consumeRateLimit("guestbook-write-user", userKey, { capacity, refillMs: 60_000 });
  return userDecision.allowed
    ? { response: null, authorId }
    : { response: rateLimited(userDecision.retryAfterSeconds), authorId: null };
}

function validId(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

function clearCache() {
  guestbookCache = { expiresAt: 0, entries: [] };
}

function validationError(code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status: 400 });
}

function validPassword(value: unknown): string | null {
  return typeof value === "string" && value.length >= 4 && value.length <= 24 ? value : null;
}

function isAdminDeleteKey(value: unknown): boolean {
  if (!ADMIN_DELETE_KEY || typeof value !== "string") return false;
  const candidate = Buffer.from(value);
  const expected = Buffer.from(ADMIN_DELETE_KEY);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = await scryptAsync(password, salt, 32) as Buffer;
  return `scrypt$${salt}$${derived.toString("hex")}`;
}

async function requireEntryPassword(id: string, value: unknown): Promise<Response | null> {
  const storedHash = await getGuestbookEntryPasswordHash(id);
  if (storedHash === undefined) return apiError("NOT_FOUND", "이미 삭제된 방명록입니다.", 404);
  if (storedHash === null) return null;
  const password = validPassword(value);
  if (!password || !await passwordMatches(password, storedHash)) {
    return apiError("PASSWORD_INVALID", "비밀번호가 일치하지 않습니다.", 403);
  }
  return null;
}

async function passwordMatches(password: string, storedHash: string): Promise<boolean> {
  const [algorithm, salt, encoded] = storedHash.split("$");
  if (algorithm !== "scrypt" || !salt || !encoded) return false;
  const expected = Buffer.from(encoded, "hex");
  if (expected.length !== 32) return false;
  const actual = await scryptAsync(password, salt, expected.length) as Buffer;
  return timingSafeEqual(actual, expected);
}
