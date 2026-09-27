"""Generate the toast logo and the app-identity icon from the shipped app icon.

Two outputs, for two different Windows behaviours:

* ``assets/toast-logo.png`` — the toast body's ``appLogoOverride`` image. Only
  used when the user points ``iconPath`` at it; the plugin's default is to show
  no body logo at all, because the notification already carries the app name and
  the circle is redundant.

* ``assets/app.ico`` — the **app identity** icon. Windows renders the small icon
  in a toast's header (next to the app name) from the shortcut's ``IconLocation``.
  That slot is ~16 logical pixels, and Windows will **not** downsample a large
  PNG for it: given a 96x96 PNG it falls back to a generic document glyph. A
  multi-resolution .ico with real 16/20/24/32 frames is what makes it sharp.

The source is the application's own 1024x1024 ``resources/icon.png``. Fully
transparent margins are trimmed and the result is squared so the artwork is
centred and fills a circular mask without clipping the whale's fins.

Run from the plugin root:

    <bundled python> tools/make-icon.py
"""

from __future__ import annotations

import pathlib
import sys

from PIL import Image

PLUGIN_ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE_CANDIDATES = [
    pathlib.Path(r"D:\Programs\DeepSeek Harness\resources\icon.png"),
    PLUGIN_ROOT / "assets" / "icon-source.png",
]

PNG_OUTPUT = PLUGIN_ROOT / "assets" / "toast-logo.png"
PNG_SIZE = 96

ICO_OUTPUT = PLUGIN_ROOT / "assets" / "app.ico"
ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]

INSET = 0.06

def find_source() -> pathlib.Path:
    """Return the first readable source icon.

    Raises:
        SystemExit: when no candidate exists.
    """
    for candidate in SOURCE_CANDIDATES:
        if candidate.is_file():
            return candidate
    sys.exit(f"no source icon found; looked in: {', '.join(str(c) for c in SOURCE_CANDIDATES)}")

def load_squared(source: pathlib.Path) -> Image.Image:
    """Load the source, trim transparent margins, and pad to a square canvas.

    Args:
        source: Path to the source PNG.

    Returns:
        A square RGBA image whose artwork is centred.
    """
    with Image.open(source) as raw:
        image = raw.convert("RGBA")
        bbox = image.getchannel("A").getbbox()
        if bbox:
            image = image.crop(bbox)
        side = max(image.size)
        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        canvas.paste(image, ((side - image.width) // 2, (side - image.height) // 2))
        return canvas

def write_png(squared: Image.Image) -> None:
    """Write the body-logo PNG.

    Args:
        squared: The squared source image.
    """
    inner = max(1, round(squared.width * (1 - 2 * INSET)))
    resized = squared.resize((inner, inner), Image.LANCZOS)
    final = Image.new("RGBA", (PNG_SIZE, PNG_SIZE), (0, 0, 0, 0))
    offset = (PNG_SIZE - inner) // 2
    final.paste(resized, (offset, offset))
    PNG_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    final.save(PNG_OUTPUT, format="PNG", optimize=True)
    print(f"png  : {PNG_OUTPUT.name} ({PNG_SIZE}x{PNG_SIZE}, {PNG_OUTPUT.stat().st_size} bytes)")

def write_ico(squared: Image.Image) -> None:
    """Write the multi-resolution identity icon.

    Each frame is resized straight from the 1024px source rather than from the
    256px frame, so the 16px glyph is a genuine downsample and stays legible.

    Args:
        squared: The squared source image.
    """
    frames = [squared.resize((size, size), Image.LANCZOS) for size in ICO_SIZES]
    ICO_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    frames[-1].save(
        ICO_OUTPUT,
        format="ICO",
        sizes=[(size, size) for size in ICO_SIZES],
        append_images=frames[:-1],
    )
    print(f"ico  : {ICO_OUTPUT.name} ({', '.join(str(s) for s in ICO_SIZES)}, {ICO_OUTPUT.stat().st_size} bytes)")

def main() -> None:
    """Build both icons."""
    source = find_source()
    squared = load_squared(source)
    with Image.open(source) as raw:
        print(f"source: {source} ({raw.size[0]}x{raw.size[1]}) -> squared {squared.width}x{squared.height}")
    write_png(squared)
    write_ico(squared)

if __name__ == "__main__":
    main()
