"""生成 WeNotice 应用图标与托盘图标（Pillow，本地离线）。"""
import os
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app", "assets")
S = 2048  # 超采样尺寸
BG_TOP = (109, 94, 248)      # #6D5EF8
BG_BOTTOM = (34, 211, 238)   # #22D3EE
WHITE = (255, 255, 255, 255)
AMBER = (251, 191, 36, 255)
DARK = (16, 18, 27, 255)
BELL = (109, 94, 248, 255)


def gradient(size, top, bottom):
    img = Image.new("RGBA", (size, size))
    px = img.load()
    for y in range(size):
        t = y / (size - 1)
        color = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,)
        for x in range(size):
            px[x, y] = color
    return img


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def bell(draw, cx, cy, scale):
    """在 (cx, cy) 处画一个实心铃铛，scale 为整体半径。"""
    r = scale * 0.62
    dome_h = scale * 0.72
    # 顶部小挂环
    draw.ellipse([cx - scale * 0.14, cy - scale * 0.98, cx + scale * 0.14, cy - scale * 0.72], fill=BELL)
    # 钟罩：半圆 + 矩形
    draw.pieslice([cx - r, cy - dome_h, cx + r, cy + dome_h * 0.35], start=180, end=360, fill=BELL)
    draw.rectangle([cx - r, cy - dome_h * 0.30, cx + r, cy + dome_h * 0.34], fill=BELL)
    # 下摆
    draw.rounded_rectangle(
        [cx - r * 1.12, cy + dome_h * 0.30, cx + r * 1.12, cy + dome_h * 0.46],
        radius=scale * 0.10,
        fill=BELL,
    )
    # 铃舌
    draw.ellipse([cx - scale * 0.17, cy + dome_h * 0.52, cx + scale * 0.17, cy + dome_h * 0.86], fill=BELL)


def main():
    os.makedirs(OUT, exist_ok=True)

    # ---------- 主图标 ----------
    base = gradient(S, BG_TOP, BG_BOTTOM)
    mask = rounded_mask(S, int(S * 0.225))
    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    icon.paste(base, (0, 0), mask)
    d = ImageDraw.Draw(icon)

    # 内层高光
    gloss = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(gloss)
    gd.ellipse([-S * 0.35, -S * 0.55, S * 0.95, S * 0.45], fill=(255, 255, 255, 30))
    icon.alpha_composite(gloss, (0, 0))

    # 白色聊天气泡（圆角矩形 + 左下角小尾巴）
    bx0, by0, bx1, by1 = S * 0.185, S * 0.235, S * 0.815, S * 0.685
    d.rounded_rectangle([bx0, by0, bx1, by1], radius=int(S * 0.105), fill=WHITE)
    tail = [
        (S * 0.30, by1 - S * 0.005),
        (S * 0.245, by1 + S * 0.105),
        (S * 0.415, by1 - S * 0.005),
    ]
    d.polygon(tail, fill=WHITE)

    # 气泡里的铃铛
    bell(d, (bx0 + bx1) / 2, (by0 + by1) / 2 + S * 0.015, S * 0.155)

    # 通知红点（气泡右上角）
    dot_cx, dot_cy, dot_r = bx1 - S * 0.005, by0 + S * 0.005, S * 0.085
    d.ellipse([dot_cx - dot_r - S * 0.022, dot_cy - dot_r - S * 0.022, dot_cx + dot_r + S * 0.022, dot_cy + dot_r + S * 0.022], fill=DARK)
    d.ellipse([dot_cx - dot_r, dot_cy - dot_r, dot_cx + dot_r, dot_cy + dot_r], fill=AMBER)

    icon = icon.resize((512, 512), Image.LANCZOS)
    icon.save(os.path.join(OUT, "icon.png"))
    icon.resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, "icon-256.png"))

    # ---------- 托盘图标（透明底，白色气泡 + 铃铛 + 琥珀点）----------
    T = 512
    tray = Image.new("RGBA", (T, T), (0, 0, 0, 0))
    td = ImageDraw.Draw(tray)
    bubble = [T * 0.10, T * 0.14, T * 0.90, T * 0.72]
    td.rounded_rectangle(bubble, radius=int(T * 0.16), fill=WHITE)
    td.polygon(
        [(T * 0.26, T * 0.70), (T * 0.19, T * 0.88), (T * 0.45, T * 0.70)],
        fill=WHITE,
    )
    bell(td, T * 0.50, T * 0.475, T * 0.205)
    dot_cx, dot_cy, dot_r = T * 0.855, T * 0.19, T * 0.115
    td.ellipse(
        [dot_cx - dot_r - T * 0.035, dot_cy - dot_r - T * 0.035, dot_cx + dot_r + T * 0.035, dot_cy + dot_r + T * 0.035],
        fill=(0, 0, 0, 0),
    )
    td.ellipse([dot_cx - dot_r, dot_cy - dot_r, dot_cx + dot_r, dot_cy + dot_r], fill=AMBER)
    tray.save(os.path.join(OUT, "tray.png"))
    tray.resize((64, 64), Image.LANCZOS).save(os.path.join(OUT, "tray-64.png"))
    tray.resize((32, 32), Image.LANCZOS).save(os.path.join(OUT, "tray-32.png"))

    # ---------- Windows ICO（打包用）----------
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    icon.save(os.path.join(OUT, "icon.ico"), sizes=sizes)
    print("icons written to", os.path.abspath(OUT))


if __name__ == "__main__":
    main()
