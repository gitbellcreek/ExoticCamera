from PIL import Image, ImageDraw

S = 2048  # supersample, then downscale

def rose(sq):
    """Draw the compass icon at SxS, then resize to `sq`."""
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    k = S / 512.0
    def p(*xy): return [v * k for v in xy]

    d.rounded_rectangle(p(0, 0, 511, 511), radius=112 * k, fill=(11, 15, 22, 255))
    d.ellipse(p(70, 70, 442, 442), outline=(38, 51, 73, 255), width=int(14 * k))
    for x1, y1, x2, y2 in [(256, 86, 256, 120), (256, 392, 256, 426), (86, 256, 120, 256), (392, 256, 426, 256)]:
        d.line(p(x1, y1, x2, y2), fill=(97, 112, 140, 255), width=int(8 * k))

    d.polygon(p(256, 108, 296, 256, 256, 236), fill=(255, 107, 107, 255))
    d.polygon(p(256, 108, 216, 256, 256, 236), fill=(216, 87, 79, 255))
    d.polygon(p(256, 404, 216, 256, 256, 276), fill=(127, 142, 168, 255))
    d.polygon(p(256, 404, 296, 256, 256, 276), fill=(95, 109, 132, 255))

    d.ellipse(p(210, 210, 302, 302), fill=(19, 26, 38, 255), outline=(143, 163, 196, 255), width=int(10 * k))
    d.ellipse(p(238, 238, 274, 274), fill=(42, 109, 240, 255))
    return im.resize((sq, sq), Image.LANCZOS)

for size in (192, 512, 180, 32):
    rose(size).save("icons/icon-%d.png" % size)
    print("icons/icon-%d.png" % size)

# maskable: same art with generous padding so a circular mask can't clip it
base = rose(410)
m = Image.new("RGBA", (512, 512), (11, 15, 22, 255))
m.paste(base, (51, 51), base)
m.save("icons/icon-maskable-512.png")
print("icons/icon-maskable-512.png")
