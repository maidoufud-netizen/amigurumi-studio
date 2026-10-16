#!/usr/bin/env python3
"""
原生三维渲染窗口（带提示词与图解）。

    python tools/viewer.py [--scene tools/scene.json] [--node <node路径>]

不经过浏览器：没有 WebGL、没有 CDN、没有缓存。软件渲染。

界面分三个页签：
    三维预览   拖动旋转 / 滚轮缩放 / 逐圈高亮
    符号图解   环形符号图（与三维用同一份角度数据）
    文字图解   6X / (X,V)×6 那套文字稿

操作流程：
    写一句提示词 → 点「解析提示词」（窗口会把解析结果回填到下面的尺寸框）
    或直接改「形状 / 直径 / 高 / 针宽 / 针高」→ 点「确定生成」
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tkinter as tk
from tkinter import ttk

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from render import render, render_chart, render_graph  # noqa: E402

from PIL import ImageTk  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

SHAPES = [("球 · 头/身", "ball"), ("蛋形 · 身体", "egg"), ("水滴", "teardrop"),
          ("锥 · 手/腿", "cone"), ("直筒", "cylinder")]
VIEWS = [("等轴", 38, 16), ("正面", 0, 0), ("侧面", 90, 0), ("俯视", 0, 78)]
EXAMPLES = ["直径6cm的圆球", "高8cm的水滴形，下面胖一点", "头围30cm的圆头",
            "细长的手臂，长10cm，粗2cm", "直径8cm高12cm的直筒"]


class App:
    def __init__(self, root: tk.Tk, scene_path: str, node_exe: str):
        self.root = root
        self.scene_path = scene_path
        self.node_exe = node_exe

        self.yaw, self.pitch, self.zoom = 38.0, 16.0, 1.14
        self.scene = None
        self.graph = None
        self.graph_path = os.path.join(HERE, "graph.json")
        self.photo3d = None
        self.photo_chart = None
        self.photo_graph = None
        self._drag = None
        self._jobs = {}

        root.title("玩偶图解工作台 · 三维渲染窗口")
        root.configure(bg="#eef2f7")

        self._build_prompt_bar()
        self._build_controls()
        self._build_tabs()
        self._build_footer()

        self.load_scene()
        self.load_graph()
        self.redraw_all()
        # 有拓扑图时先给拓扑图页签，省得手动切
        if self.graph:
            self.nb.select(self.tabgraph)

    # ────────────────────────── 拓扑图（力导向） ──────────────────────────

    def load_graph(self):
        if os.path.exists(self.graph_path):
            try:
                with open(self.graph_path, encoding="utf-8") as f:
                    self.graph = json.load(f)
            except Exception:  # noqa: BLE001
                self.graph = None

    def generate_graph(self):
        which = "octopus" if self.graph_box.current() == 0 else "sphere"
        script = os.path.join(HERE, "emit-graph.mjs")
        try:
            proc = subprocess.run(
                [self.node_exe, script, which, self.graph_path],
                cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=120,
            )
        except Exception as exc:  # noqa: BLE001
            self.status.config(text=f"调用 Node 失败：{exc}")
            return
        if proc.returncode != 0:
            self.status.config(text="拓扑图生成失败")
            self.notes.config(text=(proc.stderr or proc.stdout or "")[-400:])
            return
        self.load_graph()
        self.status.config(text="拓扑图已生成")
        self.redraw_graph(fine=True)

    def redraw_graph(self, fine=True):
        if not self.graph:
            return
        w = max(320, self.canvas_graph.winfo_width())
        h = max(240, self.canvas_graph.winfo_height())
        img = render_graph(self.graph, size=(w, h), yaw=self.yaw, pitch=self.pitch,
                           ss=2 if fine else 1, margin=self.zoom)
        self.photo_graph = ImageTk.PhotoImage(img)
        if self.item_graph is None:
            self.item_graph = self.canvas_graph.create_image(0, 0, anchor="nw", image=self.photo_graph)
        else:
            self.canvas_graph.itemconfig(self.item_graph, image=self.photo_graph)
        s = self.graph.get("summary", {})
        self.notes.config(
            text=f"拓扑图：{self.graph.get('name', '')} · "
                 f"{len(self.graph['nodes'])} 节点 / {len(self.graph['links'])} 边 · "
                 f"包围半径 {s.get('radius', 0):.1f}mm · "
                 f"{'已收敛' if self.graph.get('converged') else '未收敛'}"
                 f"（{self.graph.get('ticks', 0)} 步）　"
                 f"节点=针目，连线=耦合；橙色=分支（触手），蓝色=主体"
        )

    # ────────────────────────── 界面 ──────────────────────────

    def _build_prompt_bar(self):
        bar = tk.Frame(self.root, bg="#0f2557")
        bar.pack(fill="x")
        tk.Label(bar, text="提示词", bg="#0f2557", fg="#ffffff",
                 font=("Microsoft YaHei UI", 10, "bold")).pack(side="left", padx=(12, 6), pady=10)

        self.prompt_var = tk.StringVar()
        entry = tk.Entry(bar, textvariable=self.prompt_var, width=42,
                         font=("Microsoft YaHei UI", 10))
        entry.pack(side="left", padx=4, ipady=3)
        entry.bind("<Return>", lambda _e: self.generate(use_prompt=True))

        tk.Button(bar, text="解析提示词", command=lambda: self.generate(use_prompt=True),
                  bg="#2563eb", fg="white", relief="flat", padx=12).pack(side="left", padx=6)
        tk.Button(bar, text="确定生成", command=lambda: self.generate(use_prompt=False),
                  bg="#f59e0b", fg="#3b2606", relief="flat", padx=12,
                  font=("Microsoft YaHei UI", 10, "bold")).pack(side="left", padx=2)

        self.hint = tk.Label(bar, text="例：" + EXAMPLES[0], bg="#0f2557", fg="#93c5fd",
                             font=("Microsoft YaHei UI", 9))
        self.hint.pack(side="right", padx=12)

    def _build_controls(self):
        row = tk.Frame(self.root, bg="#f7f9fc")
        row.pack(fill="x", padx=12, pady=(8, 4))

        tk.Label(row, text="形状", bg="#f7f9fc").pack(side="left")
        self.shape_var = tk.StringVar()
        self.shape_box = ttk.Combobox(row, state="readonly", width=11,
                                      values=[label for label, _ in SHAPES], textvariable=self.shape_var)
        self.shape_box.pack(side="left", padx=(4, 14))

        def num(label, initial, lo, hi, step):
            tk.Label(row, text=label, bg="#f7f9fc").pack(side="left")
            var = tk.DoubleVar(value=initial)
            tk.Spinbox(row, from_=lo, to=hi, increment=step, width=6,
                       textvariable=var).pack(side="left", padx=(4, 12))
            return var

        # 长宽高：回转体下"长 = 宽 = 直径"，所以只需直径 + 高
        self.dia_var = num("直径 mm", 50, 4, 400, 5)
        self.hei_var = num("高 mm", 50, 4, 400, 5)
        self.w_var = num("针宽 mm", 5, 1, 20, 0.5)
        self.h_var = num("针高 mm", 5, 1, 20, 0.5)

        tk.Button(row, text="保存 PNG", command=self.save_png).pack(side="right", padx=4)

        # 拓扑图（力导向）控制
        tk.Label(row, text="│ 拓扑图", bg="#f7f9fc", fg="#94a3b8").pack(side="left", padx=(14, 2))
        self.graph_var = tk.StringVar()
        self.graph_box = ttk.Combobox(row, state="readonly", width=10,
                                      values=["章鱼（球头+8触手）", "球体（纯拓扑）"],
                                      textvariable=self.graph_var)
        self.graph_box.current(0)
        self.graph_box.pack(side="left", padx=4)
        tk.Button(row, text="生成", command=self.generate_graph, relief="flat",
                  bg="#e2e8f0", padx=10).pack(side="left", padx=2)
        self.status = tk.Label(row, text="", bg="#f7f9fc", fg="#2563eb",
                               font=("Microsoft YaHei UI", 9))
        self.status.pack(side="right", padx=10)

    def _build_tabs(self):
        self.nb = ttk.Notebook(self.root)
        self.nb.pack(fill="both", expand=True, padx=12, pady=6)

        # 三维
        self.tab3d = tk.Frame(self.nb, bg="#eef2f7")
        self.nb.add(self.tab3d, text="  三维预览  ")
        self.canvas3d = tk.Canvas(self.tab3d, highlightthickness=0, bg="#eef2f7")
        self.canvas3d.pack(fill="both", expand=True)
        self.item3d = None
        self.canvas3d.bind("<ButtonPress-1>", self._press)
        self.canvas3d.bind("<B1-Motion>", self._motion)
        self.canvas3d.bind("<ButtonRelease-1>", self._release)
        self.canvas3d.bind("<MouseWheel>", self._wheel)
        self.canvas3d.bind("<Configure>", lambda _e: self._later("3d", fine=False, delay=160))

        # 图解
        self.tabchart = tk.Frame(self.nb, bg="#ffffff")
        self.nb.add(self.tabchart, text="  符号图解  ")
        self.canvas_chart = tk.Canvas(self.tabchart, highlightthickness=0, bg="#ffffff")
        self.canvas_chart.pack(fill="both", expand=True)
        self.item_chart = None
        self.canvas_chart.bind("<Configure>", lambda _e: self._later("chart", fine=True, delay=160))

        # 文字
        self.tabtext = tk.Frame(self.nb, bg="#ffffff")
        self.nb.add(self.tabtext, text="  文字图解  ")
        self.text = tk.Text(self.tabtext, wrap="none", font=("Consolas", 10),
                            bg="#ffffff", fg="#0f172a", relief="flat")
        yscroll = tk.Scrollbar(self.tabtext, command=self.text.yview)
        self.text.configure(yscrollcommand=yscroll.set)
        yscroll.pack(side="right", fill="y")
        self.text.pack(fill="both", expand=True, padx=6, pady=6)

        # 拓扑图（力导向布局）
        self.tabgraph = tk.Frame(self.nb, bg="#f8fafc")
        self.nb.add(self.tabgraph, text="  拓扑图（力导向）  ")
        self.canvas_graph = tk.Canvas(self.tabgraph, highlightthickness=0, bg="#f8fafc")
        self.canvas_graph.pack(fill="both", expand=True)
        self.item_graph = None
        for ev, fn in (("<ButtonPress-1>", self._press), ("<B1-Motion>", self._motion),
                       ("<ButtonRelease-1>", self._release), ("<MouseWheel>", self._wheel)):
            self.canvas_graph.bind(ev, fn)
        self.canvas_graph.bind("<Configure>", lambda _e: self._later("view", fine=False, delay=200))

    def _build_footer(self):
        foot = tk.Frame(self.root, bg="#f7f9fc")
        foot.pack(fill="x", side="bottom")

        line1 = tk.Frame(foot, bg="#f7f9fc")
        line1.pack(fill="x", padx=12, pady=(4, 2))
        tk.Label(line1, text="第 N 圈", bg="#f7f9fc").pack(side="left")
        self.round_var = tk.IntVar(value=1)
        self.round_scale = tk.Scale(line1, from_=1, to=1, orient="horizontal",
                                    variable=self.round_var, command=lambda _v: self._later("both", True, 30),
                                    length=240, resolution=1, bg="#f7f9fc", highlightthickness=0)
        self.round_scale.pack(side="left", padx=6)
        tk.Label(line1, text="视角", bg="#f7f9fc").pack(side="left", padx=(12, 4))
        for label, yaw, pitch in VIEWS:
            tk.Button(line1, text=label, width=5, relief="flat", bg="#e2e8f0",
                      command=lambda y=yaw, p=pitch: self._set_view(y, p)).pack(side="left", padx=2)
        self.info = tk.Label(line1, text="", bg="#f7f9fc", fg="#334155",
                             font=("Microsoft YaHei UI", 9))
        self.info.pack(side="right", padx=8)

        line2 = tk.Frame(foot, bg="#f7f9fc")
        line2.pack(fill="x", padx=12, pady=(0, 8))
        self.notes = tk.Label(line2, text="", bg="#f7f9fc", fg="#475569", justify="left",
                              anchor="w", font=("Microsoft YaHei UI", 9))
        self.notes.pack(side="left", fill="x", expand=True)

    # ────────────────────────── 数据 ──────────────────────────

    def load_scene(self):
        if os.path.exists(self.scene_path):
            with open(self.scene_path, encoding="utf-8") as f:
                self.scene = json.load(f)
            self._apply_scene_to_ui()
        else:
            self.scene = None

    def _apply_scene_to_ui(self):
        spec = self.scene.get("spec", {})
        keys = [k for _, k in SHAPES]
        if spec.get("kind") in keys:
            self.shape_box.current(keys.index(spec["kind"]))
        self.dia_var.set(spec.get("diameter", 50))
        self.hei_var.set(spec.get("height", 50))
        self.w_var.set(self.scene["gauge"]["w"])
        self.h_var.set(self.scene["gauge"]["h"])
        rounds = len(self.scene["bands"])
        self.round_scale.configure(to=rounds)
        if self.round_var.get() > rounds:
            self.round_var.set(rounds)

    def generate(self, use_prompt: bool):
        """调用 Node 生成几何 + 图解。use_prompt=True 时以提示词为准。"""
        kind = [k for _, k in SHAPES][self.shape_box.current()]
        request = {
            "gauge": {"w": self.w_var.get(), "h": self.h_var.get()},
        }
        if use_prompt:
            text = self.prompt_var.get().strip()
            if not text:
                self.status.config(text="请先写一句提示词，或用「确定生成」按尺寸生成")
                return
            request["prompt"] = text
        else:
            request["spec"] = {
                "kind": kind,
                "diameter": self.dia_var.get(),
                "height": self.hei_var.get(),
            }

        req_path = os.path.join(HERE, "request.tmp.json")
        with open(req_path, "w", encoding="utf-8") as f:
            json.dump(request, f, ensure_ascii=False)

        script = os.path.join(HERE, "emit-scene.mjs")
        try:
            proc = subprocess.run(
                [self.node_exe, script, "@" + req_path, self.scene_path],
                cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=60,
            )
        except Exception as exc:  # noqa: BLE001
            self.status.config(text=f"调用 Node 失败：{exc}")
            return
        if proc.returncode != 0:
            self.status.config(text="生成失败，请看命令行输出")
            self.notes.config(text=(proc.stderr or proc.stdout or "")[-400:])
            return

        self.load_scene()
        self.status.config(text="已生成")
        self.redraw_all()

    # ────────────────────────── 绘制 ──────────────────────────

    def redraw_all(self):
        self.redraw_3d(fine=True)
        self.redraw_chart()
        self.redraw_text()
        self.redraw_graph(fine=True)
        if self.scene:
            s = self.scene
            self.info.config(
                text=f"{s['rounds']} 圈 · 峰值 {s['peak']} 针 · 合计 {s['totalOps']} 针 · "
                     f"高 {s['totalHeight']:.0f}mm · 偏差 {s['maxDeviation'] * 100:.1f}%"
            )
            notes = s.get("notes") or []
            self.notes.config(text="解析：" + "；".join(notes) if notes else "")

    def redraw_3d(self, fine=True):
        """三维页签现在也走拓扑 + 力导向管线（与网页版同一条）"""
        if not self.scene:
            return
        graph = self.scene.get("graph")
        if not graph:
            return
        w = max(320, self.canvas3d.winfo_width())
        h = max(240, self.canvas3d.winfo_height())
        img = render_graph(graph, size=(w, h), yaw=self.yaw, pitch=self.pitch,
                           current=self.round_var.get(), ss=2 if fine else 1,
                           margin=self.zoom)
        self.photo3d = ImageTk.PhotoImage(img)
        if self.item3d is None:
            self.item3d = self.canvas3d.create_image(0, 0, anchor="nw", image=self.photo3d)
        else:
            self.canvas3d.itemconfig(self.item3d, image=self.photo3d)

    def redraw_chart(self):
        if not self.scene:
            return
        w = max(320, self.canvas_chart.winfo_width())
        h = max(240, self.canvas_chart.winfo_height())
        size = min(w, h)
        img = render_chart(self.scene, size=(size, size), current=self.round_var.get(), ss=2)
        self.photo_chart = ImageTk.PhotoImage(img)
        cx = (w - size) // 2
        cy = (h - size) // 2
        if self.item_chart is None:
            self.item_chart = self.canvas_chart.create_image(cx, cy, anchor="nw", image=self.photo_chart)
        else:
            self.canvas_chart.itemconfig(self.item_chart, image=self.photo_chart)
            self.canvas_chart.coords(self.item_chart, cx, cy)

    def redraw_text(self):
        if not self.scene:
            return
        body = self.scene.get("pattern", "")
        v = self.scene.get("validation", {})
        tail = "\n\n" + "─" * 40 + "\n" + (v.get("text") or "")
        self.text.delete("1.0", "end")
        self.text.insert("1.0", body + tail)

    def _later(self, what, fine=True, delay=80):
        if what in self._jobs:
            self.root.after_cancel(self._jobs[what])

        def view():
            self.redraw_3d(fine)
            self.redraw_graph(fine)

        fn = {
            "3d": lambda: self.redraw_3d(fine),
            "graph": lambda: self.redraw_graph(fine),
            "chart": self.redraw_chart,
            "view": view,                     # 旋转/缩放同时刷新三维与拓扑图
            "both": lambda: (self.redraw_3d(fine), self.redraw_chart()),
        }[what]
        self._jobs[what] = self.root.after(delay, fn)

    # ────────────────────────── 交互 ──────────────────────────

    def _press(self, e):
        self._drag = (e.x, e.y, self.yaw, self.pitch)

    def _motion(self, e):
        if not self._drag:
            return
        x0, y0, yaw0, pitch0 = self._drag
        self.yaw = (yaw0 + (e.x - x0) * 0.6) % 360
        self.pitch = max(-85.0, min(85.0, pitch0 + (e.y - y0) * 0.5))
        self._later("view", fine=False, delay=40)

    def _release(self, _e):
        self._drag = None
        self._later("view", fine=True, delay=10)

    def _wheel(self, e):
        self.zoom = max(0.7, min(3.0, self.zoom * (0.92 if e.delta > 0 else 1.08)))
        self._later("view", fine=False, delay=30)

    def _set_view(self, yaw, pitch):
        self.yaw, self.pitch = yaw, pitch
        self.redraw_3d(fine=True)
        self.redraw_graph(fine=True)

    def save_png(self):
        if not self.scene:
            return
        n = self.round_var.get()
        a = os.path.join(HERE, f"preview-3d-round{n}.png")
        b = os.path.join(HERE, f"preview-chart-round{n}.png")
        if self.scene.get("graph"):
            render_graph(self.scene["graph"], size=(900, 700), yaw=self.yaw,
                         pitch=self.pitch, current=n, ss=2, margin=self.zoom).save(a)
        render_chart(self.scene, size=(900, 900), current=n, ss=2).save(b)
        self.status.config(text=f"已保存 {os.path.basename(a)} / {os.path.basename(b)}")


def main():
    ap = argparse.ArgumentParser(description="原生三维渲染窗口（无需浏览器）")
    ap.add_argument("--scene", default=os.path.join(HERE, "scene.json"))
    ap.add_argument("--node", default=os.environ.get("DSH_NODE", "node"),
                    help="Node 可执行文件路径（用于生成几何）")
    args = ap.parse_args()

    root = tk.Tk()
    root.geometry("1120x820")
    App(root, args.scene, args.node)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
