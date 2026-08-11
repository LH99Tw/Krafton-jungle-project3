const PROFILE_BADGES = [
  { name: "검의 문장", src: "/images/ui/profile-badges/sword.png" },
  { name: "까마귀의 문장", src: "/images/ui/profile-badges/raven.png" },
  { name: "달의 문장", src: "/images/ui/profile-badges/moon.png" },
  { name: "탑의 문장", src: "/images/ui/profile-badges/tower.png" },
  { name: "늑대의 문장", src: "/images/ui/profile-badges/wolf.png" },
  { name: "성배의 문장", src: "/images/ui/profile-badges/chalice.png" },
] as const;

export function profileBadgeFor(userId: string) {
  let hash = 2_166_136_261;

  for (const character of userId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }

  return PROFILE_BADGES[(hash >>> 0) % PROFILE_BADGES.length];
}
