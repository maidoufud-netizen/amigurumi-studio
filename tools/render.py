#!/usr/bin/env python3
"""
软件渲染器：把几何 JSON 画成 PNG。

为什么要有它：纯 Python + Pillow，**不用 OpenGL、不用浏览器、不联网**。
所以它不会因为 WebGL 被禁用、CDN 被墙、浏览器缓存而白屏。

几何来自 tools/emit-scene.mjs（那部分是 Node 算的，已被 62 项测试覆盖），
这里只负责"把数字画出来"。

    python tools/render.py tools/scene.json out.png [选项]

选项：
    --size 900x640     画布尺寸
    --yaw 38           水平旋转角（度）
    --pitch 16         俯仰角（度）
    --round N          高亮第 N 圈（默认 1）
    --seg 64           圆周细分段数（越大越圆，越慢）
    --ss 2             超采样倍数（抗锯齿，1 = 关）
    --no-grid          不画针目网格
    --no-ruler         不画标尺
    --bg R,G,B         背景色
"""
from __future__ import annotations

import argparse
import json
import math
from PIL import Image, ImageDraw

TAU = math.pi * 2

# ────────────────────────────── 向量工具 ──────────────────────────────


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def norm(a):
    length = math.sqrt(dot(a, a)) or 1.0
    return (a[0] / length, a[1] / length, a[2] / length)


class Camera:
    """透视相机：绕目标点的球面坐标定位，取景按包围球反算距离。"""

    def __init__(self, target, radius, fov=36.0, aspect=1.4, yaw=38.0, pitch=16.0, margin=1.14):
        vfov = math.radians(fov)
        hfov = 2 * math.atan(math.tan(vfov / 2) * aspect)
        self.dist = radius / math.sin(min(vfov, hfov) / 2) * margin
        y = math.radians(yaw)
        p = math.radians(pitch)
        direction = (math.cos(p) * math.cos(y), math.sin(p), math.cos(p) * math.sin(y))
        self.eye = tuple(target[i] + direction[i] * self.dist for i in range(3))
        self.fwd = norm(sub(target, self.eye))
        self.right = norm(cross(self.fwd, (0.0, 1.0, 0.0)))
        self.up = cross(self.right, self.fwd)
        self.fov = fov
        self.radius = radius

    def project(self, point, w, h):
        d = sub(point, self.eye)
        z = dot(d, self.fwd)
        if z <= 1e-6:
            return None
        f = (h / 2) / math.tan(math.radians(self.fov) / 2)
        return (w / 2 + dot(d, self.right) / z * f, h / 2 - dot(d, self.up) / z * f, z)


# ────────────────────────────── 着色 ──────────────────────────────

# 圈的状态 → 基色（与网页版一致，便于对照）
COLOR = {
    "past": (126, 166, 216),
    "current": (240, 166, 58),
    "future": (203, 214, 227),
}
LIGHT = norm((0.45, 0.78, 0.44))


def shade(base, intensity):
    return tuple(max(0, min(255, int(c * intensity))) for c in base)


def build_quads(scene, segments):
    """把每个曲面分段（一圈）切成若干四边形。"""
    quads = []
    for band in scene["bands"]:
        r0, y0, r1, y1 = band["r0"], band["y0"], band["r1"], band["y1"]
        for i in range(segments):
            a0 = TAU * i / segments
            a1 = TAU * (i + 1) / segments
            c0, s0 = math.cos(a0), math.sin(a0)
            c1, s1 = math.cos(a1), math.sin(a1)
            quads.append((band["round"], [
                (r0 * c0, y0, r0 * s0),
                (r0 * c1, y0, r0 * s1),
                (r1 * c1, y1, r1 * s1),
                (r1 * c0, y1, r1 * s0),
            ]))
    return quads


def scene_bounds(scene, segments=48, show_ruler=True):
    """返回 (中心, 半径)。
    中心只按**模型**算——否则标尺会把模型挤到画面一边；
    半径则覆盖模型 + 标尺，保证两者都在画面里。
    """
    model = []
    for band in scene["bands"]:
        for i in range(segments):
            ang = TAU * i / segments
            ca, sa = math.cos(ang), math.sin(ang)
            model.append((band["r0"] * ca, band["y0"], band["r0"] * sa))
            model.append((band["r1"] * ca, band["y1"], band["r1"] * sa))

    mx = [p[0] for p in model]
    my = [p[1] for p in model]
    mz = [p[2] for p in model]
    center = ((min(mx) + max(mx)) / 2, (min(my) + max(my)) / 2, (min(mz) + max(mz)) / 2)

    everything = list(model)
    if show_ruler:
        r = scene["ruler"]
        for i in range(0, len(r), 3):
            everything.append((r[i], r[i + 1], r[i + 2]))
    radius = max(math.dist(p, center) for p in everything)
    return center, radius


def render(scene, size=(900, 640), yaw=38.0, pitch=16.0, current=1, segments=64,
           ss=2, show_grid=True, show_ruler=True, background=(238, 242, 247), margin=1.14):
    """渲染成 PIL 图像。margin 越大相机越远（= 缩小）。"""
    w, h = size
    center, radius = scene_bounds(scene, segments=min(segments, 48), show_ruler=show_ruler)
    cam = Camera(center, radius, aspect=w / h, yaw=yaw, pitch=pitch, margin=margin)

    W, H = w * ss, h * ss
    img = Image.new("RGB", (W, H), background)
    draw = ImageDraw.Draw(img)

    # 画家算法：按视深从远到近铺四边形（不做背面剔除，凹面也正确）
    faces = []
    for round_index, poly in build_quads(scene, segments):
        projected = [cam.project(v, W, H) for v in poly]
        if any(p is None for p in projected):
            continue
        depth = sum(p[2] for p in projected) / 4
        n = norm(cross(sub(poly[1], poly[0]), sub(poly[3], poly[0])))
        lam = abs(dot(n, LIGHT))          # 取绝对值 = 双面光照，凹面不会发黑
        if current <= 0:
            key = "past"                   # 0 = 不高亮，整件按"已钩"色显示
        else:
            key = "current" if round_index == current else ("past" if round_index < current else "future")
        # 环境光给足（0.58），否则背光面会黑成一片
        faces.append((depth, [p[:2] for p in projected], shade(COLOR[key], 0.58 + 0.42 * lam)))
    faces.sort(key=lambda t: -t[0])
    for _, shape, color in faces:
        draw.polygon(shape, fill=color, outline=color)

    # 网格与标尺：叠一层半透明线，画在实体之上
    if show_grid or show_ruler:
        overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        od = ImageDraw.Draw(overlay)
        if show_grid:
            g = scene["grid"]
            for i in range(0, len(g), 6):
                a = cam.project((g[i], g[i + 1], g[i + 2]), W, H)
                b = cam.project((g[i + 3], g[i + 4], g[i + 5]), W, H)
                if a and b:
                    od.line([a[:2], b[:2]], fill=(84, 104, 130, 95), width=max(1, ss))
        if show_ruler:
            r = scene["ruler"]
            for i in range(0, len(r), 6):
                a = cam.project((r[i], r[i + 1], r[i + 2]), W, H)
                b = cam.project((r[i + 3], r[i + 4], r[i + 5]), W, H)
                if a and b:
                    od.line([a[:2], b[:2]], fill=(64, 80, 100, 210), width=max(1, ss))
        img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")

    if ss != 1:
        img = img.resize((w, h), Image.LANCZOS)
    return img


# ────────────────────────── 符号图解渲染 ──────────────────────────

CHART_STROKE = (17, 24, 39)
CHART_GUIDE = (215, 222, 232)
CHART_LABEL = (100, 116, 139)
CHART_CURRENT = (217, 119, 6)


def _draw_symbol(draw, op, x, y, s, color, width):
    """一个针法的线稿符号：sc = ×，inc = V，dec = ∧ 加一横。"""
    h = s / 2
    if op == "sc":
        draw.line([(x - h, y - h), (x + h, y + h)], fill=color, width=width)
        draw.line([(x + h, y - h), (x - h, y + h)], fill=color, width=width)
    elif op == "inc":
        draw.line([(x - h, y - h), (x, y + h)], fill=color, width=width)
        draw.line([(x, y + h), (x + h, y - h)], fill=color, width=width)
    else:  # dec
        draw.line([(x - h, y + h), (x, y - h)], fill=color, width=width)
        draw.line([(x, y - h), (x + h, y + h)], fill=color, width=width)
        draw.line([(x - h * 0.62, y + h * 0.92), (x + h * 0.62, y + h * 0.92)],
                  fill=color, width=width)


def render_chart(scene, size=(560, 620), current=0, ss=2, background=(255, 255, 255)):
    """把 scene['chart'] 画成符号图解。

    chart 里的半径与角度来自 src/chart.js 的 layoutChart()——
    与三维网格、文字图解同一份数据，所以三者不可能对不上。
    """
    fw, fh = size
    W, H = fw * ss, fh * ss
    img = Image.new("RGB", (W, H), background)
    draw = ImageDraw.Draw(img)

    chart = scene.get("chart")
    if not chart:
        draw.text((20 * ss, 20 * ss), "没有图解数据（该图解不可钩）", fill=(185, 28, 28))
        return img.resize((fw, fh), Image.LANCZOS)

    max_r = chart["maxR"]
    pad = 44.0
    scale = min(fw, fh) / (2 * max_r + 2 * pad)
    cx, cy = fw / 2, fh / 2

    def project(r, angle):
        a = angle - math.pi / 2          # 角度 0 放在正上方（起针位）
        return ((cx + r * math.cos(a) * scale) * ss, (cy + r * math.sin(a) * scale) * ss)

    # 圈引导线：圆心是画布中心，不是 project(r,0)（那是圆的顶点，不是圆心！）
    cx_px, cy_px = cx * ss, cy * ss
    for ring in chart["rings"]:
        rr = ring["r"] * scale * ss
        draw.ellipse([cx_px - rr, cy_px - rr, cx_px + rr, cy_px + rr],
                     outline=CHART_GUIDE, width=max(1, ss // 2 + 1))

    # 符号：加针的两个针目在 layout 里已合成一个 V，所以这里一个 glyph 画一个符号。
    # 符号大小必须**随画布一起放大**（只按 chart 单位算），否则大图上只有一堆小点；
    # 同时留上限，避免相邻符号糊成一片。
    cell = float(chart.get("cell", 7.2))
    sym = max(3.5, min(13.0, 0.62 * cell * scale)) * ss
    lw = max(1, int(round(0.16 * scale * ss)) + (ss - 1))
    for ring in chart["rings"]:
        color = CHART_CURRENT if (current and ring["n"] == current) else CHART_STROKE
        for glyph in ring["glyphs"]:
            x, y = project(ring["r"], glyph["angle"])
            _draw_symbol(draw, glyph["op"], x, y, sym, color, lw)

    # 圈号-针数：沿正上方排一列，加白底避免压住符号
    # （分隔符用 "-"：默认位图字体没有 "·" 字形，会渲染成缺字）
    for ring in chart["rings"]:
        x, y = project(ring["r"], 0.0)
        text = f"{ring['n']}-{ring['total']}"
        tx, ty = x + 5 * ss, y - 6 * ss
        box = draw.textbbox((tx, ty), text)
        draw.rectangle([box[0] - 2 * ss, box[1] - ss, box[2] + 2 * ss, box[3] + ss], fill=background)
        draw.text((tx, ty), text, fill=CHART_LABEL)

    return img.resize((fw, fh), Image.LANCZOS) if ss != 1 else img


def main():
    ap = argparse.ArgumentParser(description="把几何 JSON 渲染成 PNG（软件渲染，无需浏览器）")
    ap.add_argument("scene", help="emit-scene.mjs 产出的 JSON")
    ap.add_argument("out", help="输出 PNG 路径")
    ap.add_argument("--size", default="900x640")
    ap.add_argument("--yaw", type=float, default=38.0)
    ap.add_argument("--pitch", type=float, default=16.0)
    ap.add_argument("--round", type=int, default=1)
    ap.add_argument("--seg", type=int, default=64)
    ap.add_argument("--ss", type=int, default=2)
    ap.add_argument("--no-grid", action="store_true")
    ap.add_argument("--no-ruler", action="store_true")
    ap.add_argument("--bg", default="238,242,247")
    ap.add_argument("--chart", action="store_true",
                    help="改为渲染符号图解（而不是三维实体）")
    args = ap.parse_args()

    with open(args.scene, encoding="utf-8") as f:
        scene = json.load(f)

    w, h = (int(x) for x in args.size.lower().split("x"))
    bg = tuple(int(x) for x in args.bg.split(","))

    if args.chart:
        img = render_chart(scene, size=(w, h), current=args.round, ss=args.ss,
                           background=bg)
        img.save(args.out)
        rounds = len(scene.get("chart", {}).get("rings", []))
        print(f"已渲染图解 {args.out}  {w}x{h}  {rounds} 圈  第 {args.round} 圈高亮")
        return

    img = render(
        scene, size=(w, h), yaw=args.yaw, pitch=args.pitch, current=args.round,
        segments=args.seg, ss=args.ss, show_grid=not args.no_grid,
        show_ruler=not args.no_ruler, background=bg,
    )
    img.save(args.out)
    print(f"已渲染 {args.out}  {w}x{h}  第 {args.round}/{len(scene['bands'])} 圈高亮  "
          f"yaw={args.yaw} pitch={args.pitch}")


if __name__ == "__main__":
    main()
