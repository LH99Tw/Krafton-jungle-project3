type Bucket = { tokens: number; updatedAt: number; lastSeenAt: number };

type RatePolicy = {
  capacity: number;
  refillMs: number;
  maxEntries?: number;
};

type SecurityRegistry = {
  buckets: Map<string, Bucket>;
  lastCleanupAt: number;
};

const registryKey = Symbol.for("five-days.web-security-registry");
const globalSecurity = globalThis as typeof globalThis & { [registryKey]?: SecurityRegistry };
const registry = globalSecurity[registryKey] ??= { buckets: new Map(), lastCleanupAt: 0 };

export class PayloadTooLargeError extends Error {}
export class InvalidJsonError extends Error {}

export function clientIp(request: Request): string {
  return clientIpFromHeaders(request.headers);
}

export function clientIpFromHeaders(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1);
  const candidate = forwarded ?? headers.get("x-real-ip")?.trim() ?? "unknown";
  return candidate.length <= 64 && /^[0-9a-f:.]+$/iu.test(candidate) ? candidate.toLowerCase() : "unknown";
}

export function consumeRateLimit(name: string, key: string, policy: RatePolicy, now = Date.now()): {
  allowed: boolean;
  retryAfterSeconds: number;
} {
  cleanupBuckets(now, policy.maxEntries ?? 10_000);
  const bucketKey = `${name}:${key.slice(0, 160)}`;
  const existing = registry.buckets.get(bucketKey);
  const refillPerMs = policy.capacity / policy.refillMs;
  const tokens = existing
    ? Math.min(policy.capacity, existing.tokens + Math.max(0, now - existing.updatedAt) * refillPerMs)
    : policy.capacity;
  if (tokens < 1) {
    registry.buckets.set(bucketKey, { tokens, updatedAt: now, lastSeenAt: now });
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / refillPerMs / 1000)) };
  }
  registry.buckets.set(bucketKey, { tokens: tokens - 1, updatedAt: now, lastSeenAt: now });
  return { allowed: true, retryAfterSeconds: 0 };
}

export function securityNumber(name: string, fallback: number, minimum = 1, maximum = 100_000): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.trunc(value))) : fallback;
}

function cleanupBuckets(now: number, maxEntries: number): void {
  if (now - registry.lastCleanupAt < 60_000 && registry.buckets.size <= maxEntries) return;
  registry.lastCleanupAt = now;
  const staleBefore = now - 2 * 86_400_000;
  for (const [key, bucket] of registry.buckets) {
    if (bucket.lastSeenAt < staleBefore) registry.buckets.delete(key);
  }
  if (registry.buckets.size <= maxEntries) return;
  const oldest = [...registry.buckets.entries()]
    .sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt)
    .slice(0, registry.buckets.size - maxEntries);
  for (const [key] of oldest) registry.buckets.delete(key);
}

export function rateLimited(retryAfterSeconds: number): Response {
  return Response.json(
    { error: { code: "RATE_LIMITED", message: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." } },
    { status: 429, headers: { "retry-after": String(retryAfterSeconds), "cache-control": "no-store" } },
  );
}

export function allowedOrigins(): Set<string> {
  return new Set(
    (process.env.ALLOWED_ORIGINS ?? process.env.APP_ORIGIN ?? "http://localhost:3000")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function hasAllowedOrigin(request: Request, requireOrigin = process.env.NODE_ENV === "production"): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return !requireOrigin;
  return allowedOrigins().has(origin);
}

export async function readJsonLimited<T>(request: Request, maximumBytes: number): Promise<T> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) throw new PayloadTooLargeError();
  if (!request.body) throw new InvalidJsonError();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new PayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new InvalidJsonError();
  }
}

export function payloadError(error: unknown): Response | null {
  if (error instanceof PayloadTooLargeError) {
    return Response.json(
      { error: { code: "PAYLOAD_TOO_LARGE", message: "요청 본문이 너무 큽니다." } },
      { status: 413, headers: { "cache-control": "no-store" } },
    );
  }
  if (error instanceof InvalidJsonError) {
    return Response.json(
      { error: { code: "INVALID_JSON", message: "잘못된 JSON 요청입니다." } },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  return null;
}
