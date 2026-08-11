import os
from collections import deque
from PIL import Image

def make_transparent(file_path):
    print("Processing:", file_path)
    img = Image.open(file_path).convert("RGBA")
    width, height = img.size
    pixels = img.load()

    visited = set()
    queue = deque()

    # Border pixels
    for x in range(width):
        queue.append((x, 0))
        queue.append((x, height - 1))
    for y in range(height):
        queue.append((0, y))
        queue.append((width - 1, y))

    def is_white_bg(r, g, b):
        return r > 215 and g > 215 and b > 215

    count = 0
    while queue:
        x, y = queue.popleft()
        if (x, y) in visited:
            continue
        visited.add((x, y))

        r, g, b, a = pixels[x, y]
        if is_white_bg(r, g, b):
            pixels[x, y] = (r, g, b, 0)
            count += 1
            for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                nx, ny = x + dx, y + dy
                if 0 <= nx < width and 0 <= ny < height and (nx, ny) not in visited:
                    queue.append((nx, ny))

    img.save(file_path, "PNG")
    print(f"Made {count} / {width * height} outer white background pixels transparent in {os.path.basename(file_path)}")

make_transparent(os.path.abspath("apps/web/public/images/boss_bull.png"))
make_transparent(os.path.abspath("apps/web/public/images/boss_dragon.png"))
