import Image from "next/image";

export function TeamGoldHud({
  gold,
  inventoryOpen,
  onInventoryToggle,
}: {
  gold: number;
  inventoryOpen: boolean;
  onInventoryToggle: () => void;
}) {
  return (
    <section className="team-gold-reliquary" aria-label={`팀 골드 ${gold}`}>
      <Image className="team-gold-coin" src="/images/ui/hud/gold-coin.png" alt="" width={72} height={72} priority />
      <strong>{gold.toLocaleString("ko-KR")}</strong>
      <button
        type="button"
        className={`inventory-toggle ${inventoryOpen ? "is-open" : ""}`}
        aria-label="파티 인벤토리"
        aria-controls="party-inventory"
        aria-expanded={inventoryOpen}
        title="파티 인벤토리"
        onClick={onInventoryToggle}
      >
        <Image
          className="inventory-toggle-image"
          src="/images/ui/hud/inventory-bag-button.png"
          alt=""
          width={256}
          height={256}
          priority
        />
      </button>
    </section>
  );
}
