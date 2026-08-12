import Image from "next/image";

export function InventoryHudButton({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="inventory-hud-button">
      <button
        type="button"
        className={`inventory-toggle ${open ? "is-open" : ""}`}
        aria-label="파티 인벤토리"
        aria-controls="party-inventory"
        aria-expanded={open}
        title="파티 인벤토리"
        onClick={onToggle}
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
    </div>
  );
}
