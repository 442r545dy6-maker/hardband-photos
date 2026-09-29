# Generates app icons with Pillow. Run: python3 make_icons.py
from PIL import Image, ImageDraw, ImageFont

BG = (31, 42, 54)        # dark steel blue
PIPE = (150, 160, 170)   # steel
PIPE_HI = (190, 198, 206)
BAND = (245, 130, 32)    # hardband orange
BAND_HI = (255, 176, 90)

def make(size, path, pad_frac=0.0, radius_frac=0.0):
    S = size * 4  # supersample
    im = Image.new("RGB", (S, S), BG)
    d = ImageDraw.Draw(im)
    if radius_frac:
        im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        d.rounded_rectangle([0, 0, S, S], radius=int(S * radius_frac), fill=BG)
    pad = int(S * pad_frac)
    inner = S - 2 * pad
    # Tool joint / pipe drawn horizontally
    cy = S // 2
    tj_h = int(inner * 0.36)   # tool joint OD
    tube_h = int(inner * 0.20) # tube OD
    x0 = pad + int(inner * 0.06)
    x1 = S - pad - int(inner * 0.06)
    tj_x0 = pad + int(inner * 0.22)
    tj_x1 = S - pad - int(inner * 0.22)
    # tube
    d.rectangle([x0, cy - tube_h // 2, x1, cy + tube_h // 2], fill=PIPE)
    d.rectangle([x0, cy - tube_h // 2, x1, cy - tube_h // 2 + tube_h // 5], fill=PIPE_HI)
    # tool joint
    d.rounded_rectangle([tj_x0, cy - tj_h // 2, tj_x1, cy + tj_h // 2], radius=tj_h // 8, fill=PIPE)
    d.rectangle([tj_x0 + tj_h // 8, cy - tj_h // 2, tj_x1 - tj_h // 8, cy - tj_h // 2 + tj_h // 6], fill=PIPE_HI)
    # 3 hardbands
    bw = int((tj_x1 - tj_x0) * 0.13)
    gap = int((tj_x1 - tj_x0 - 3 * bw) / 4)
    for i in range(3):
        bx = tj_x0 + gap + i * (bw + gap)
        d.rectangle([bx, cy - tj_h // 2 - int(S * 0.012), bx + bw, cy + tj_h // 2 + int(S * 0.012)], fill=BAND)
        d.rectangle([bx, cy - tj_h // 2 - int(S * 0.012), bx + bw // 3, cy + tj_h // 2 + int(S * 0.012)], fill=BAND_HI)
    im = im.resize((size, size), Image.LANCZOS)
    im.save(path, optimize=True)

make(192, "icons/icon-192.png", pad_frac=0.04)
make(512, "icons/icon-512.png", pad_frac=0.04)
make(512, "icons/icon-maskable-512.png", pad_frac=0.14)  # safe zone for Android masks
make(180, "icons/apple-touch-icon.png", pad_frac=0.04)
make(32, "icons/favicon-32.png", pad_frac=0.0)
print("icons done")
