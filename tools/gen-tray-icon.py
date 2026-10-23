"""生成高对比度托盘图标（白色气泡 + 深色描边 + 紫色铃铛），16–64px 都清晰。"""
import os

from PIL import Image, ImageDraw

BG = (255, 255, 255, 0)
OUTLINE = (24, 28, 40, 255)
BELL = (124, 108, 240, 255)
BELL_DARK = (88, 74, 210, 255)
AMBER = (251, 191, 36, 255)


def draw(size):
    scale = size / 64.0
    img = Image.new("RGBA", (size, size), BG)
    d = ImageDraw.Draw(img)

    def s(v):
        return v * scale

    # 气泡主体
    bx0, by0, bx1, by1 = s(6), s(10), s(58), s(46)
    radius = s(10)
    d.rounded_rectangle([bx0, by0, bx1, by1], radius=radius, fill=(255, 255, 255, 255), outline=OUTLINE, width=max(1, int(s(3.2))))
    # 气泡小尾巴
    d.polygon([(s(18), by1 - s(1)), (s(30), by1 - s(1)), (s(20), s(54))], fill=(255, 255, 255, 255), outline=OUTLINE)
    d.line([(s(19), by1), (s(21), s(53))], fill=(255, 255, 255, 255), width=max(1, int(s(3))))

    # 铃铛
    cy = s(27)
    d.ellipse([s(27), s(15), s(37), s(19)], fill=BELL_DARK)  # 顶钮
    d.pieslice([s(23), s(17), s(41), s(35)], 180, 360, fill=BELL, outline=OUTLINE, width=max(1, int(s(2.4))))
    d.rectangle([s(23), s(25), s(41), s(31)], fill=BELL, outline=None)
    d.rounded_rectangle([s(21), s(29), s(43), s(33)], radius=s(2), fill=BELL, outline=OUTLINE, width=max(1, int(s(2.2))))
    d.ellipse([s(29), s(33.5), s(35), s(37.5)], fill=BELL_DARK, outline=OUTLINE)

    # 通知点
    d.ellipse([s(42), s(6), s(57), s(21)], fill=AMBER, outline=OUTLINE, width=max(1, int(s(2.6))))
    return img


base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app", "assets")
os.makedirs(base, exist_ok=True)
draw(64).save(os.path.join(base, "tray.png"))
draw(64).save(os.path.join(base, "tray-64.png"))
draw(32).save(os.path.join(base, "tray-32.png"))
# Windows 托盘/标题栏优先使用多尺寸 ICO，兼容高 DPI（125%/150%/200%）与不同缩放
draw(256).save(
    os.path.join(base, "tray.ico"),
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("tray icons regenerated")
