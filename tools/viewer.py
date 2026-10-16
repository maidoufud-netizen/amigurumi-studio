#!/usr/bin/env python3
"""
原生渲染窗口：不经过浏览器，所以没有 WebGL / CDN / 缓存这些问题。

    python tools/viewer.py [--scene tools/scene.json] [--node <node路径>]

操作：
    拖动鼠标左键      旋转
    滚轮              缩放
    「第 N 圈」滑杆   逐圈高亮（蓝=已钩，琥珀=当前，灰=未钩）
    预设 / 针宽 / 针高 改完点「重新生成几何」
    「保存 PNG」      导出当前视角

几何由 tools/emit-scene.mjs（Node）生成，渲染由 tools/render.py（纯 Python）完成。
本窗口只做交互与显示。
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tkinter as tk
from tkinter import ttk

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from render import render  # noqa: E402

import json  # noqa: E402
from PIL import ImageTk  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

PRESETS = [("球 · 头/身", "ball"), ("水滴 · 身体", "teardrop"),
           ("锥 · 手/腿", "cone"), ("直筒", "cylinder")]
VIEWS = [("等轴", 38, 16), ("正面", 0, 0), ("侧面", 90, 0), ("俯视", 0, 78)]


class Viewer:
    def __init__(self, root: tk.Tk, scene_path: str, node_exe: str):
        self.root = root
        self.scene_path = scene_path
        self.node_exe = node_exe
        self.scene = self._load(scene_path)

        self.yaw, self.pitch = 38.0, 16.0
        self.zoom = 1.14
        self.current = max(1, len(self.scene["bands"]) // 2)
        self.fine = True
        self._drag = None
        self._job = None

        root.title("玩偶图解工作台 · 三维渲染窗口")
        root.configure(bg="#eef2f7")

        # ── 顶部工具栏 ──
        bar = tk.Frame(root, bg="#0f2557")
        bar.pack(fill="x")
        tk.Label(bar, text="三维渲染窗口", bg="#0f2557", fg="#ffffff",
                 font=("Microsoft YaHei UI", 11, "bold")).pack(side="left", padx=12, pady=8)
        self.info = tk.Label(bar, text="", bg="#0f2557", fg="#93c5fd",
                             font=("Microsoft YaHei UI", 9))
        self.info.pack(side="left", padx=6)
        tk.Label(bar, text="左键拖动旋转 · 滚轮缩放", bg="#0f2557", fg="#93c5fd",
                 font=("Microsoft YaHei UI", 9)).pack(side="right", padx=12)

        # ── 画布 ──
        self.W, self.H = 900, 620
        self.canvas = tk.Canvas(root, width=self.W, height=self.H,
                                highlightthickness=0, bg="#eef2f7")
        self.canvas.pack(fill="both", expand=True)
        self.photo = None
        self.item = None

        # ── 底部控制条 ──
        panel = tk.Frame(root, bg="#f7f9fc")
        panel.pack(fill="x", side="bottom")

        row1 = tk.Frame(panel, bg="#f7f9fc")
        row1.pack(fill="x", padx=12, pady=(8, 2))
        self.round_var = tk.IntVar(value=self.current)
        tk.Label(row1, text="第 N 圈", bg="#f7f9fc").pack(side="left")
        self.round_scale = tk.Scale(
            row1, from_=1, to=len(self.scene["bands"]), orient="horizontal",
            variable=self.round_var, command=self._on_round, showvalue=True,
            length=260, resolution=1, bg="#f7f9fc", highlightthickness=0,
        )
        self.round_scale.pack(side="left", padx=8)

        tk.Label(row1, text="视角", bg="#f7f9fc").pack(side="left", padx=(16, 4))
        for label, yaw, pitch in VIEWS:
            tk.Button(row1, text=label, width=5,
                      command=lambda y=yaw, p=pitch: self._set_view(y, p)).pack(side="left", padx=2)

        tk.Button(row1, text="保存 PNG", command=self.save_png).pack(side="right", padx=4)

        row2 = tk.Frame(panel, bg="#f7f9fc")
        row2.pack(fill="x", padx=12, pady=(2, 10))
        tk.Label(row2, text="形状", bg="#f7f9fc").pack(side="left")
        self.preset_var = tk.StringVar(value=self.scene.get("preset", "ball"))
        preset_box = ttk.Combobox(row2, state="readonly", width=12,
                                  values=[label for label, _ in PRESETS])
        preset_box.current([key for _, key in PRESETS].index(self.preset_var.get())
                           if self.preset_var.get() in [k for _, k in PRESETS] else 0)
        preset_box.pack(side="left", padx=6)
        self.preset_box = preset_box

        self.w_var = tk.DoubleVar(value=self.scene["gauge"]["w"])
        self.h_var = tk.DoubleVar(value=self.scene["gauge"]["h"])
        for label, var in (("针宽 w", self.w_var), ("针高 h", self.h_var)):
            tk.Label(row2, text=label, bg="#f7f9fc").pack(side="left", padx=(12, 2))
            tk.Spinbox(row2, from_=2, to=12, increment=0.5, width=5,
                       textvariable=var).pack(side="left")

        tk.Button(row2, text="重新生成几何", command=self.regen).pack(side="left", padx=12)
        self.status = tk.Label(row2, text="", bg="#f7f9fc", fg="#64748b",
                               font=("Microsoft YaHei UI", 9))
        self.status.pack(side="left", padx=6)

        # ── 事件 ──
        self.canvas.bind("<ButtonPress-1>", self._press)
        self.canvas.bind("<B1-Motion>", self._motion)
        self.canvas.bind("<ButtonRelease-1>", self._release)
        self.canvas.bind("<MouseWheel>", self._wheel)
        self.canvas.bind("<Configure>", self._resize)

        self.redraw(fine=True)

    # ────────────────────────── 数据 ──────────────────────────

    def _load(self, path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    def _emit(self, preset, w, h):
        """调用 Node 重新生成几何（几何逻辑只有一份，在 src/ 里）。"""
        script = os.path.join(HERE, "emit-scene.mjs")
        subprocess.run(
            [self.node_exe, script, preset, str(w), str(h), self.scene_path],
            cwd=ROOT, check=True, capture_output=True,
        )
        self.scene = self._load(self.scene_path)
        self.round_scale.configure(to=len(self.scene["bands"]))
        self.current = min(self.current, len(self.scene["bands"]))
        self.round_var.set(self.current)

    # ────────────────────────── 渲染 ──────────────────────────

    def redraw(self, fine=True):
        self.fine = fine
        w = max(320, self.canvas.winfo_width() or self.W)
        h = max(240, self.canvas.winfo_height() or self.H)
        # 拖动时降质量换流畅：少细分、不超采样
        seg = 96 if fine else 40
        ss = 2 if fine else 1
        img = render(
            self.scene, size=(w, h), yaw=self.yaw, pitch=self.pitch,
            current=self.round_var.get(), segments=seg, ss=ss,
            show_grid=True, show_ruler=True, margin=self.zoom,
        )
        self.photo = ImageTk.PhotoImage(img)
        if self.item is None:
            self.item = self.canvas.create_image(0, 0, anchor="nw", image=self.photo)
        else:
            self.canvas.itemconfig(self.item, image=self.photo)
            self.canvas.coords(self.item, 0, 0)

        bands = len(self.scene["bands"])
        peak = self.scene.get("peak", "?")
        height = self.scene.get("totalHeight", "?")
        self.info.config(text=f"{bands} 圈 · 峰值 {peak} 针 · 高 {height}mm")
        self.status.config(text=("精细" if fine else "拖动中（低质量）"))

    def _later(self, fine=True, delay=90):
        """合并高频事件，避免拖动时排队卡死。"""
        if self._job is not None:
            self.root.after_cancel(self._job)
        self._job = self.root.after(delay, lambda: self.redraw(fine=fine))

    # ────────────────────────── 交互 ──────────────────────────

    def _press(self, e):
        self._drag = (e.x, e.y, self.yaw, self.pitch)

    def _motion(self, e):
        if not self._drag:
            return
        x0, y0, yaw0, pitch0 = self._drag
        self.yaw = (yaw0 + (e.x - x0) * 0.6) % 360
        self.pitch = max(-85.0, min(85.0, pitch0 + (e.y - y0) * 0.5))
        self._later(fine=False, delay=40)

    def _release(self, _e):
        self._drag = None
        self._later(fine=True, delay=10)

    def _wheel(self, e):
        self.zoom = max(0.7, min(3.0, self.zoom * (0.92 if e.delta > 0 else 1.08)))
        self._later(fine=False, delay=30)

    def _resize(self, _e):
        self._later(fine=False, delay=150)

    def _on_round(self, _v):
        self._later(fine=True, delay=10)

    def _set_view(self, yaw, pitch):
        self.yaw, self.pitch = yaw, pitch
        self.redraw(fine=True)

    def regen(self):
        preset = [k for label, k in PRESETS][self.preset_box.current()]
        try:
            self._emit(preset, self.w_var.get(), self.h_var.get())
        except Exception as exc:  # noqa: BLE001
            self.status.config(text=f"生成失败：{exc}")
            return
        self.status.config(text="几何已更新")
        self.redraw(fine=True)

    def save_png(self):
        w = max(320, self.canvas.winfo_width() or self.W)
        h = max(240, self.canvas.winfo_height() or self.H)
        img = render(self.scene, size=(w, h), yaw=self.yaw, pitch=self.pitch,
                     current=self.round_var.get(), segments=96, ss=2, margin=self.zoom)
        out = os.path.join(HERE, f"preview-round{self.round_var.get()}.png")
        img.save(out)
        self.status.config(text=f"已保存 {os.path.relpath(out, ROOT)}")


def main():
    ap = argparse.ArgumentParser(description="原生三维渲染窗口（无需浏览器）")
    ap.add_argument("--scene", default=os.path.join(HERE, "scene.json"))
    ap.add_argument("--node", default=os.environ.get("DSH_NODE", "node"),
                    help="Node 可执行文件路径（用于重新生成几何）")
    args = ap.parse_args()

    if not os.path.exists(args.scene):
        print(f"找不到几何文件 {args.scene}，请先运行：\n"
              f"  node tools/emit-scene.mjs ball 5 5 tools/scene.json", file=sys.stderr)
        return 1

    root = tk.Tk()
    Viewer(root, args.scene, args.node)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
