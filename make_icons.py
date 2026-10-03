# Builds the app icons from Dusty's photo of a hardbanded tool joint. Needs Pillow.
#   python3 make_icons.py                    -> rebuild every icon from icons/source.jpg
#   python3 make_icons.py --from crop.png    -> first replace icons/source.jpg with a new square crop
#                                               (EXIF orientation applied, stored as a 1024 px high-quality JPEG)
# icons/source.jpg is the approved square crop (1024 x 1024) of the original iPad photo (IMG_1270), centred on the
# hardband band. Every icon is the whole crop, edge to edge (the maskable one too: full-bleed, no added border).
# After rebuilding, bump VERSION in sw.js and APP_VERSION in app.js so phones download the new icons.
import sys
from PIL import Image, ImageFilter, ImageOps

SRC = "icons/source.jpg"
OUT = [
    ("icons/icon-192.png", 192),           # manifest.webmanifest, purpose "any"
    ("icons/icon-512.png", 512),           # manifest.webmanifest, purpose "any"
    ("icons/icon-maskable-512.png", 512),  # manifest.webmanifest, purpose "maskable" (full-bleed photo)
    ("icons/apple-touch-icon.png", 180),   # index.html <link rel="apple-touch-icon"> (iOS home screen), opaque
    ("icons/favicon-32.png", 32),          # index.html <link rel="icon">
]

def refresh_source(path):
    im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    w, h = im.size
    s = min(w, h)
    im = im.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s))
    if s > 1024:
        im = im.resize((1024, 1024), Image.LANCZOS)
    im.save(SRC, quality=95, subsampling=0, optimize=True)
    print("wrote", SRC, im.size)

def render(src, size):
    im = src.resize((size, size), Image.LANCZOS)
    if size <= 192:  # a light sharpen keeps the band's edges crisp on the small sizes
        im = im.filter(ImageFilter.UnsharpMask(radius=0.8, percent=60, threshold=2))
    return im.convert("RGB")  # opaque: no alpha channel anywhere

if __name__ == "__main__":
    if "--from" in sys.argv:
        refresh_source(sys.argv[sys.argv.index("--from") + 1])
    src = Image.open(SRC).convert("RGB")
    assert src.width == src.height, "icons/source.jpg must be square"
    for path, size in OUT:
        render(src, size).save(path, optimize=True)
        print("wrote", path, size)
