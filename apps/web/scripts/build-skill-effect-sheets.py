from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "art-sources/skill-effects"
OUTPUT_DIR = ROOT / "public/images/effects/skills"
FRAME_SIZE = 256


def remove_generated_background(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    pixels = []
    for red, green, blue, source_alpha in rgba.getdata():
        # Generated atlases alternate between green-screen and black-backed
        # cells. Preserve gold/purple/white energy while rejecting both.
        non_green = max(red, blue) - green * 0.55
        chroma_alpha = max(0, min(255, round((non_green - 18) * 5.5)))
        light_alpha = max(0, min(255, round((max(red, green, blue) - 7) * 5.4)))
        alpha = min(source_alpha, chroma_alpha, light_alpha)
        if red > 180 and green < 80 and blue < 50:
            alpha = 0
        # Remove reflected green from antialiased effect edges.
        cleaned_green = min(green, max(red, blue) + 18)
        pixels.append((red, cleaned_green, blue, alpha))
    rgba.putdata(pixels)
    alpha = rgba.getchannel("A").filter(ImageFilter.GaussianBlur(0.35))
    rgba.putalpha(alpha)
    return rgba


def grid_cells(image: Image.Image) -> list[Image.Image]:
    width, height = image.size
    cell_width = width // 3
    cell_height = height // 2
    inset = 4
    return [
        image.crop((
            column * cell_width + inset,
            row * cell_height + inset,
            (column + 1) * cell_width - inset,
            (row + 1) * cell_height - inset,
        ))
        for row in range(2)
        for column in range(3)
    ]


def swordsman_e_cells(image: Image.Image) -> list[Image.Image]:
    # This generated atlas includes a large outer margin; these are the six
    # authored square cells inside it.
    starts_x = (32, 434, 840)
    starts_y = (275, 675)
    size = 380
    return [image.crop((x, y, x + size, y + size)) for y in starts_y for x in starts_x]


def build_sheet(name: str, custom_cells=False) -> None:
    source = Image.open(SOURCE_DIR / f"{name}-atlas.png")
    cleaned = remove_generated_background(source)
    cells = swordsman_e_cells(cleaned) if custom_cells else grid_cells(cleaned)
    sheet = Image.new("RGBA", (FRAME_SIZE * 6, FRAME_SIZE), (0, 0, 0, 0))
    for index, cell in enumerate(cells):
        frame = cell.resize((FRAME_SIZE, FRAME_SIZE), Image.Resampling.LANCZOS)
        frame = ImageEnhance.Contrast(frame).enhance(1.04)
        sheet.alpha_composite(frame, (index * FRAME_SIZE, 0))
    sheet.save(OUTPUT_DIR / f"{name}-sheet.png", optimize=True)


OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
for skill_name in ("swordsman-q", "archer-q", "archer-e", "mage-q", "mage-e"):
    build_sheet(skill_name)
build_sheet("swordsman-e", custom_cells=True)
