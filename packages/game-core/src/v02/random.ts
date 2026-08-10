export type RandomSource = {
  next(): number;
  integer(maxExclusive: number): number;
  pick<T>(values: readonly T[]): T;
  shuffle<T>(values: readonly T[]): T[];
};

/**
 * Small deterministic PRNG for game rules and tests.
 *
 * The string hash and Mulberry32 step intentionally use only 32-bit integer
 * operations, so the same seed produces the same sequence on Node and in a
 * browser. This is not a cryptographic random source.
 */
export function createSeededRandom(seed: string | number): RandomSource {
  let state = hashSeed(String(seed));

  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };

  const integer = (maxExclusive: number): number => {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError("maxExclusive must be a positive integer");
    }
    return Math.floor(next() * maxExclusive);
  };

  const pick = <T>(values: readonly T[]): T => {
    if (values.length === 0) throw new RangeError("Cannot pick from an empty collection");
    return values[integer(values.length)] as T;
  };

  const shuffle = <T>(values: readonly T[]): T[] => {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const swapIndex = integer(index + 1);
      [result[index], result[swapIndex]] = [result[swapIndex] as T, result[index] as T];
    }
    return result;
  };

  return { next, integer, pick, shuffle };
}

export function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}
