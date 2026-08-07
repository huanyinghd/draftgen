(function (root, factory) {
  if (typeof define === "function" && define.amd) define([], factory);
  else if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DraftGen = factory();
})(typeof self !== "undefined" ? self : this, function () {
// draftgen/engine.js
// 浏览器端「乱线草稿」绘制引擎 —— 移植自 paint_masterpieces.py 的 Canvas 类。
// 纯前端、零依赖，直接往一个 2D canvas 上画。所有随机由可复现的种子控制。
// 对外导出：SketchEngine、FOCAL_POINTS、makeRNG

// ── 可复现随机数（mulberry32）─────────────────────────────────────────────
function makeRNG(seed) {
  let a = (seed >>> 0) || 1;
  const rng = {
    next() {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    range(lo, hi) { return lo + (hi - lo) * this.next(); },          // 类比 random.uniform
    int(lo, hi) { return Math.floor(lo + (hi - lo + 1) * this.next()); }, // 含两端，类比 randint
    pick(arr) { return arr[Math.floor(this.next() * arr.length)]; },
    choices(arr, weights) {
      let total = 0;
      for (let i = 0; i < weights.length; i++) total += weights[i];
      let r = this.next() * total;
      for (let i = 0; i < arr.length; i++) { r -= weights[i]; if (r < 0) return arr[i]; }
      return arr[arr.length - 1];
    },
  };
  return rng;
}

// 三分法四个焦点（归一化坐标 + 中文标签）
const FOCAL_POINTS = [
  [1 / 3, 1 / 3, "左上"],
  [2 / 3, 1 / 3, "右上"],
  [1 / 3, 2 / 3, "左下"],
  [2 / 3, 2 / 3, "右下"],
];

const COLORED = [[150, 60, 60], [60, 95, 150], [150, 110, 60], [90, 140, 95]];

class SketchEngine {
  constructor(w, h, opts = {}) {
    this.W = w; this.H = h;
    this.seed = opts.seed != null ? opts.seed : 42;
    this.rng = makeRNG(this.seed);
    this.focal = opts.focal || null; // [fx, fy] 像素
    this.paper = opts.paper || [246, 243, 233];
    this.canvas = document.createElement("canvas");
    this.canvas.width = w; this.canvas.height = h;
    this.ctx = this.canvas.getContext("2d");
    this._fillPaper();
  }

  _fillPaper() {
    const c = this.paper;
    this.ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    this.ctx.fillRect(0, 0, this.W, this.H);
  }

  // —— 颜色 ——
  grayVar(base = [42, 40, 46], spread = 42) {
    return base.map((ch) =>
      Math.max(0, Math.min(255, ch + Math.round(this.rng.range(-spread, spread))))
    );
  }
  _colorPick() {
    if (this.rng.next() < 0.12) return this.rng.pick(COLORED).slice();
    return this.grayVar();
  }

  // 焦点模式下 60% 概率把位置拉向焦点
  _biasedPos(x0, y0, x1, y1) {
    if (!this.focal) return [this.rng.range(x0, x1), this.rng.range(y0, y1)];
    const [fx, fy] = this.focal;
    if (this.rng.next() < 0.2) {
      const t = this.rng.range(0.08, 0.4);
      const rx = this.rng.range(x0, x1);
      const ry = this.rng.range(y0, y1);
      return [rx + (fx - rx) * t, ry + (fy - ry) * t];
    }
    return [this.rng.range(x0, x1), this.rng.range(y0, y1)];
  }

  // —— 遮罩 ——
  rectMask(x0, y0, x1, y1) { return { type: "rect", x0, y0, x1, y1 }; }
  polyMask(polys, extras = null) { return { type: "poly", polys, extras }; }
  bboxOf(polys) {
    let xs = [], ys = [];
    for (const p of polys) for (const [x, y] of p) { xs.push(x); ys.push(y); }
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  buildPeaks(peaks, baseY) {
    const polys = [];
    for (const [cx, h, w] of peaks) {
      polys.push([
        [cx - w, baseY], [cx - w * 0.3, baseY - h * 0.6], [cx, baseY - h],
        [cx + w * 0.4, baseY - h * 0.55], [cx + w, baseY],
      ]);
    }
    return polys;
  }

  _clip(mask) {
    if (!mask) return;
    const ctx = this.ctx;
    ctx.beginPath();
    if (mask.type === "rect") {
      ctx.rect(mask.x0, mask.y0, mask.x1 - mask.x0, mask.y1 - mask.y0);
    } else if (mask.type === "poly") {
      for (const poly of mask.polys) {
        ctx.moveTo(poly[0][0], poly[0][1]);
        for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
        ctx.closePath();
      }
      if (mask.extras) {
        for (const e of mask.extras) {
          const [x0, y0, x1, y1] = e;
          const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
          ctx.moveTo(cx + (x1 - x0) / 2, cy);
          ctx.ellipse(cx, cy, (x1 - x0) / 2, (y1 - y0) / 2, 0, 0, Math.PI * 2);
        }
      }
    }
    ctx.clip();
  }

  // —— 直线层 ——
  addLines(bbox, n, ang, sp, lr, wr, ar, mask = null) {
    const ctx = this.ctx;
    ctx.save(); this._clip(mask);
    ctx.lineCap = "round";
    for (let i = 0; i < n; i++) {
      const a = ang + this.rng.range(-sp, sp);
      const len = this.rng.range(lr[0], lr[1]);
      const [sx, sy] = this._biasedPos(bbox[0], bbox[1], bbox[2], bbox[3]);
      const ex = sx + Math.cos(a) * len, ey = sy + Math.sin(a) * len;
      const col = this._colorPick();
      const al = this.rng.int(ar[0], ar[1]);
      const w = this.rng.int(wr[0], wr[1]);
      ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${(al / 255).toFixed(3)})`;
      ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
    }
    ctx.restore();
  }

  // —— 圆弧层：圆 / 半圆 / 圆弧 / 弯曲线 ——
  addArcs(bbox, n, rr, wr, ar, kw, mask = null) {
    const ctx = this.ctx;
    ctx.save(); this._clip(mask);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    const kinds = ["circle", "semicircle", "arc", "curve"];
    for (let i = 0; i < n; i++) {
      const kind = this.rng.choices(kinds, kw);
      const [cx, cy] = this._biasedPos(bbox[0], bbox[1], bbox[2], bbox[3]);
      const r = this.rng.range(rr[0], rr[1]);
      const col = this._colorPick();
      const al = this.rng.int(ar[0], ar[1]);
      const w = this.rng.int(wr[0], wr[1]);
      ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${(al / 255).toFixed(3)})`;
      ctx.lineWidth = w;
      if (kind === "circle") {
        ctx.beginPath(); ctx.ellipse(cx, cy, r, r, 0, 0, Math.PI * 2); ctx.stroke();
      } else if (kind === "semicircle") {
        const st = this.rng.pick([0, Math.PI / 2, Math.PI, Math.PI * 1.5]);
        ctx.beginPath(); ctx.ellipse(cx, cy, r, r, 0, st, st + Math.PI); ctx.stroke();
      } else if (kind === "arc") {
        const st = this.rng.range(0, Math.PI * 2);
        const en = st + this.rng.range((25 * Math.PI) / 180, (320 * Math.PI) / 180);
        ctx.beginPath(); ctx.ellipse(cx, cy, r, r, 0, st, en); ctx.stroke();
      } else {
        let px = cx, py = cy;
        const nseg = this.rng.int(3, 9);
        const pts = [[px, py]];
        for (let s = 0; s < nseg; s++) {
          px += this.rng.range(-r, r); py += this.rng.range(-r, r);
          pts.push([px, py]);
        }
        ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
        for (let s = 1; s < pts.length - 1; s++) {
          const xc = (pts[s][0] + pts[s + 1][0]) / 2;
          const yc = (pts[s][1] + pts[s + 1][1]) / 2;
          ctx.quadraticCurveTo(pts[s][0], pts[s][1], xc, yc);
        }
        const last = pts[pts.length - 1];
        ctx.lineTo(last[0], last[1]);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // 焦点处「星系式随机散布」爆发：大量小团块围绕主焦点随机分布，
  // 有密有疏、大小不一、方向错落，避免变成一个实心圆斑。
  focalBurst() {
    if (!this.focal) return;
    const [fx, fy] = this.focal;
    const baseR = Math.min(this.W, this.H) / 6;
    const rnd = this.rng;
    const ctx = this.ctx;

    // 1) 生成大量随机微簇（像星团里的恒星团），远近、大小、密度都随机
    const clusters = [];
    const count = rnd.int(9, 17);
    for (let i = 0; i < count; i++) {
      const ang = rnd.range(0, Math.PI * 2);
      // 距离分布：大部分离焦点不远，但允许少量外围稀疏点（扩散更广，避免黑芯）
      const dist = rnd.range(baseR * 0.05, baseR * 1.9);
      clusters.push({
        cx: fx + Math.cos(ang) * dist,
        cy: fy + Math.sin(ang) * dist,
        cr: baseR * rnd.range(0.10, 0.42),   // 有的小而密，有的大而疏
        dens: rnd.range(0.30, 1.70),         // 有疏有密
      });
    }

    // 2) 全局线条预算：焦点处总笔画数硬性控制在 FOCAL_BUDGET 条以内。
    //    先算出各簇的「理想权重」，再按预算等比缩放，保证疏密关系不变、总量可控。
    const FOCAL_BUDGET = 2000;          // 焦点处线条总量上限
    const LINK_N = 60;                  // 簇间稀疏连接线
    const strokeBudget = Math.max(0, FOCAL_BUDGET - LINK_N);

    const weights = clusters.map(cl => cl.dens * (baseR / (cl.cr + 1)));
    const wSum = weights.reduce((a, b) => a + b, 0) || 1;

    const savedFocal = this.focal;
    this.focal = null;
    clusters.forEach((cl, i) => {
      const share = Math.floor(strokeBudget * (weights[i] / wSum));
      if (share < 6) return;
      const x0 = Math.max(0, cl.cx - cl.cr), y0 = Math.max(0, cl.cy - cl.cr);
      const x1 = Math.min(this.W, cl.cx + cl.cr), y1 = Math.min(this.H, cl.cy + cl.cr);
      // 约 2/3 直线 + 1/3 弧线，保留原有质感
      const nLines = Math.max(4, Math.round(share * 0.66));
      const nArc = Math.max(2, share - nLines);
      const baseAng = rnd.range(0, Math.PI); // 每簇不同主方向
      this.addLines([x0, y0, x1, y1], nLines, baseAng, Math.PI, [3, cl.cr * 1.6], [1, 2], [11, 50], null);
      this.addArcs([x0, y0, x1, y1], nArc, [3, cl.cr * 0.8], [1, 2], [13, 48], [2, 1, 1, 3], null);
    });
    this.focal = savedFocal;

    // 3) 稀疏连接：用很淡的线把邻近微簇轻轻串起，保持整体节奏
    const linkN = LINK_N;
    for (let i = 0; i < linkN; i++) {
      const a = rnd.pick(clusters), b = rnd.pick(clusters);
      const ax = a.cx + rnd.range(-a.cr, a.cr), ay = a.cy + rnd.range(-a.cr, a.cr);
      const bx = b.cx + rnd.range(-b.cr, b.cr), by = b.cy + rnd.range(-b.cr, b.cr);
      const col = this._colorPick();
      const al = rnd.int(8, 40);
      ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${(al / 255).toFixed(3)})`;
      ctx.lineWidth = rnd.int(1, 2);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    }
  }

  getCanvas() { return this.canvas; }
  toDataURL(type = "image/png") { return this.canvas.toDataURL(type); }
}


// draftgen/styles.js
// 10 幅经典名作的「乱线重绘」笔法 —— 移植自 paint_masterpieces.py 的 paint_* 方法。
// 每个 paintX(c) 都直接往引擎 c 上堆线 / 弧。对外导出：STYLES、paintClassic。

// ── 01 弗里德里希《雾海上的旅人》──
function paintFriedrich(c) {
  const W = c.W, H = c.H;
  const fy_fog = Math.floor(H * 0.40);
  const far = c.buildPeaks(
    [[180, 150, 120], [330, 110, 90], [520, 180, 140], [760, 130, 100], [900, 200, 150], [1040, 120, 90]],
    fy_fog + Math.floor(H * 0.18));
  const mid = c.buildPeaks(
    [[250, 260, 150], [640, 300, 170], [980, 250, 150]], fy_fog + Math.floor(H * 0.30));
  const lf = [[[0, H * 0.85], [0.10 * W, H * 0.74], [0.18 * W, H * 0.70], [0.26 * W, H * 0.76], [0.33 * W, H * 0.86], [0.30 * W, H]]];
  const crag = [[[0.30 * W, H], [0.34 * W, H * 0.78], [0.42 * W, H * 0.66], [0.50 * W, H * 0.60], [0.56 * W, H * 0.55], [0.60 * W, H * 0.60], [0.66 * W, H * 0.70], [0.72 * W, H * 0.82], [0.80 * W, H]]];
  const fx = 0.55 * W, by = H * 0.55, fh = H * 0.135, hr = Math.floor(0.020 * H);
  const sh_y = by - fh * 0.78, hcy = by - fh;
  const fig = [[fx - 0.022 * W, sh_y - 0.02 * H], [fx - 0.030 * W, sh_y + 0.03 * H], [fx - 0.026 * W, by - 0.04 * H], [fx - 0.022 * W, by], [fx + 0.022 * W, by], [fx + 0.026 * W, by - 0.04 * H], [fx + 0.030 * W, sh_y + 0.03 * H], [fx + 0.022 * W, sh_y - 0.02 * H], [fx + 0.014 * W, sh_y - 0.05 * H]];
  const fig_int = fig.map(([x, y]) => [Math.round(x), Math.round(y)]);
  c.addLines([0, 0, W, fy_fog], 300, 0.0, 0.35, [40, 480], [1, 2], [35, 110], c.rectMask(0, 0, W, fy_fog));
  c.addLines([0, 0, W, fy_fog], 200, -0.40, 0.55, [30, 350], [1, 1], [25, 80], c.rectMask(0, 0, W, fy_fog));
  c.addLines([0, fy_fog, W, H], 300, 0.0, 0.28, [60, 560], [1, 2], [35, 120], c.rectMask(0, fy_fog, W, H));
  c.addLines([0, fy_fog, W, H], 250, -0.15, 0.40, [50, 440], [1, 1], [30, 100], c.rectMask(0, fy_fog, W, H));
  c.addLines(c.bboxOf(far), 250, -1.25, 1.0, [15, 180], [1, 2], [50, 145], c.polyMask(far));
  c.addLines(c.bboxOf(far), 150, -1.30, 0.80, [10, 120], [1, 1], [40, 130], c.polyMask(far));
  c.addLines(c.bboxOf(mid), 220, -1.25, 1.0, [25, 220], [1, 2], [55, 155], c.polyMask(mid));
  c.addLines(c.bboxOf(mid), 150, -1.35, 0.75, [15, 150], [1, 2], [40, 130], c.polyMask(mid));
  c.addLines(c.bboxOf(lf), 200, 0.30, 1.1, [25, 240], [1, 2], [55, 155], c.polyMask(lf));
  c.addLines(c.bboxOf(lf), 120, 0.50, 0.80, [20, 160], [1, 1], [40, 120], c.polyMask(lf));
  c.addLines(c.bboxOf(crag), 350, 0.55, 1.2, [25, 300], [1, 3], [60, 180], c.polyMask(crag));
  c.addLines(c.bboxOf(crag), 250, 0.70, 0.90, [20, 220], [1, 2], [45, 150], c.polyMask(crag));
  const fm = c.polyMask([fig_int], [[fx - hr, hcy - hr, fx + hr, hcy + hr]]);
  c.addLines(c.bboxOf([fig_int]), 200, 1.55, 1.3, [12, 140], [1, 2], [120, 220], fm);
  c.addLines(c.bboxOf([fig_int]), 120, 1.65, 1.0, [10, 100], [1, 2], [100, 200], fm);
  c.addArcs([0, 0, W, H], 350, [8, 140], [1, 2], [40, 125], [1, 0, 0, 0]);
  c.addArcs([0, 0, W, H], 300, [10, 160], [1, 2], [40, 125], [0, 1, 0, 0]);
  c.addArcs([0, 0, W, H], 300, [15, 210], [1, 2], [40, 130], [0, 0, 1, 0]);
  c.addArcs([0, 0, W, H], 400, [20, 130], [1, 3], [45, 150], [0, 0, 0, 1]);
  c.addArcs([0, 0, W, fy_fog], 180, [20, 180], [1, 2], [35, 100], [2, 1, 1, 2], c.rectMask(0, 0, W, fy_fog));
  c.addArcs([0, fy_fog, W, H], 200, [15, 200], [1, 2], [35, 110], [1, 3, 2, 1], c.rectMask(0, fy_fog, W, H));
  c.addArcs(c.bboxOf(far.concat(mid)), 220, [12, 150], [1, 2], [50, 140], [1, 1, 2, 3], c.polyMask(far.concat(mid)));
  c.addArcs(c.bboxOf(crag), 250, [10, 130], [1, 2], [55, 160], [2, 1, 2, 3], c.polyMask(crag));
  c.addArcs(c.bboxOf([fig_int]), 100, [8, 60], [1, 2], [100, 200], [0, 0, 0, 1], fm);
}

// ── 02 范宽《溪山行旅图》──
function paintFanKuan(c) {
  const W = c.W, H = c.H;
  const sky_b = Math.floor(H * 0.18);
  c.addLines([0, 0, W, sky_b], 300, -0.1, 0.50, [40, 400], [1, 2], [35, 110], c.rectMask(0, 0, W, sky_b));
  c.addLines([0, 0, W, sky_b], 180, 0.2, 0.60, [30, 320], [1, 1], [25, 85], c.rectMask(0, 0, W, sky_b));
  let mp = c.buildPeaks([[0.52 * W, Math.floor(H * 0.55), 280]], sky_b + Math.floor(H * 0.08));
  mp = mp.concat(c.buildPeaks(
    [[0.30 * W, Math.floor(H * 0.25), 150], [0.74 * W, Math.floor(H * 0.28), 140], [0.15 * W, Math.floor(H * 0.18), 100], [0.88 * W, Math.floor(H * 0.16), 90]],
    sky_b + Math.floor(H * 0.25)));
  c.addLines(c.bboxOf(mp), 400, -1.20, 0.90, [15, 200], [1, 2], [50, 145], c.polyMask(mp));
  c.addLines(c.bboxOf(mp), 280, -1.30, 0.75, [10, 150], [1, 1], [40, 125], c.polyMask(mp));
  const wf = [[[0.48 * W, sky_b + Math.floor(H * 0.08)], [0.48 * W, sky_b + Math.floor(H * 0.42)], [0.56 * W, sky_b + Math.floor(H * 0.42)], [0.56 * W, sky_b + Math.floor(H * 0.08)]]];
  c.addLines(c.bboxOf(wf), 120, -1.56, 0.10, [30, 250], [1, 2], [35, 100], c.polyMask(wf));
  const mid_crag = [[[0.18 * W, H * 0.52], [0.38 * W, H * 0.48], [0.65 * W, H * 0.46], [0.78 * W, H * 0.50], [0.82 * W, H * 0.58], [0.10 * W, H * 0.58]]];
  c.addLines(c.bboxOf(mid_crag), 250, 0.30, 1.10, [20, 220], [1, 2], [50, 145], c.polyMask(mid_crag));
  c.addLines(c.bboxOf(mid_crag), 160, 0.50, 0.80, [15, 170], [1, 2], [40, 120], c.polyMask(mid_crag));
  const fg_rock = [[[0.05 * W, H], [0.05 * W, H * 0.65], [0.20 * W, H * 0.63], [0.28 * W, H * 0.67], [0.45 * W, H * 0.64], [0.52 * W, H * 0.68], [0.65 * W, H * 0.65], [0.78 * W, H * 0.70], [0.95 * W, H * 0.68], [0.95 * W, H]]];
  c.addLines(c.bboxOf(fg_rock), 350, 0.55, 1.15, [20, 280], [1, 3], [55, 170], c.polyMask(fg_rock));
  c.addLines(c.bboxOf(fg_rock), 240, 0.70, 0.85, [15, 200], [1, 2], [40, 140], c.polyMask(fg_rock));
  const tx = 0.58 * W, ty = H * 0.72;
  const trav = [[[tx - 0.012 * W, ty - 0.04 * H], [tx - 0.008 * W, ty], [tx + 0.008 * W, ty], [tx + 0.012 * W, ty - 0.04 * H]]];
  const mule = [[[tx + 0.025 * W, ty - 0.02 * H], [tx + 0.018 * W, ty + 0.01 * H], [tx + 0.035 * W, ty + 0.01 * H], [tx + 0.032 * W, ty - 0.02 * H]]];
  for (const shape of [trav, mule]) {
    const s_int = shape.map((p) => p.map(([x, y]) => [Math.round(x), Math.round(y)]));
    c.addLines(c.bboxOf(s_int), 80, 1.55, 1.20, [8, 80], [1, 2], [100, 200], c.polyMask(s_int));
  }
  c.addArcs([0, 0, W, H], 300, [10, 150], [1, 2], [40, 125], [1, 0, 0, 0]);
  c.addArcs([0, 0, W, H], 250, [12, 170], [1, 2], [40, 125], [0, 1, 0, 0]);
  c.addArcs([0, 0, W, H], 250, [18, 200], [1, 2], [40, 130], [0, 0, 1, 0]);
  c.addArcs([0, 0, W, H], 350, [22, 120], [1, 3], [45, 150], [0, 0, 0, 1]);
  c.addArcs([0, 0, W, sky_b], 150, [18, 160], [1, 2], [35, 100], [2, 1, 1, 2], c.rectMask(0, 0, W, sky_b));
  c.addArcs(c.bboxOf(mp.concat(mid_crag)), 220, [10, 130], [1, 2], [50, 140], [1, 1, 2, 3], c.polyMask(mp.concat(mid_crag)));
  c.addArcs(c.bboxOf(fg_rock), 220, [10, 120], [1, 2], [55, 160], [2, 1, 2, 3], c.polyMask(fg_rock));
}

// ── 03 葛饰北斋《神奈川冲浪里》──
function paintHokusaiWave(c) {
  const W = c.W, H = c.H;
  const sky_b = Math.floor(H * 0.22);
  c.addLines([0, 0, W, sky_b], 280, 0.0, 0.30, [50, 440], [1, 2], [35, 105], c.rectMask(0, 0, W, sky_b));
  c.addLines([0, 0, W, sky_b], 150, -0.30, 0.50, [30, 350], [1, 1], [25, 80], c.rectMask(0, 0, W, sky_b));
  const fuji = c.buildPeaks([[0.58 * W, 140, 60]], sky_b + Math.floor(H * 0.15));
  c.addLines(c.bboxOf(fuji), 150, -1.40, 0.80, [15, 140], [1, 2], [50, 145], c.polyMask(fuji));
  c.addLines(c.bboxOf(fuji), 100, -1.50, 0.60, [10, 100], [1, 1], [40, 120], c.polyMask(fuji));
  const wave_body = [[[0.02 * W, H * 0.24], [0.15 * W, H * 0.18], [0.32 * W, H * 0.20], [0.45 * W, H * 0.26], [0.50 * W, H * 0.32], [0.48 * W, H * 0.42], [0.35 * W, H * 0.48], [0.20 * W, H * 0.52], [0.02 * W, H * 0.50]]];
  c.addLines(c.bboxOf(wave_body), 380, 0.10, 1.40, [20, 280], [1, 3], [55, 170], c.polyMask(wave_body));
  c.addLines(c.bboxOf(wave_body), 270, -0.40, 1.10, [15, 220], [1, 2], [40, 140], c.polyMask(wave_body));
  const claw = [];
  for (const [ox, oy, hh] of [[0.18 * W, H * 0.22, 90], [0.28 * W, H * 0.20, 100], [0.38 * W, H * 0.24, 80], [0.44 * W, H * 0.28, 70]]) {
    claw.push([[ox - 15, oy], [ox - 8, oy - hh], [ox + 8, oy - hh * 0.7], [ox + 20, oy - hh * 0.4], [ox + 30, oy], [ox + 15, oy]]);
  }
  c.addLines(c.bboxOf(claw), 200, 0.0, 1.50, [10, 120], [1, 2], [55, 155], c.polyMask(claw));
  const sw = [[[0.55 * W, H * 0.50], [0.65 * W, H * 0.45], [0.75 * W, H * 0.44], [0.85 * W, H * 0.48], [0.95 * W, H * 0.55]]];
  const sw2 = [[[0.60 * W, H * 0.58], [0.72 * W, H * 0.55], [0.82 * W, H * 0.56], [0.95 * W, H * 0.62]]];
  c.addLines(c.bboxOf(sw.concat(sw2)), 180, 0.05, 1.20, [15, 180], [1, 2], [45, 135], c.polyMask(sw.concat(sw2)));
  const wat = c.rectMask(0, Math.floor(H * 0.52), W, H);
  c.addLines([0, Math.floor(H * 0.52), W, H], 280, 0.0, 0.25, [60, 500], [1, 2], [35, 115], wat);
  c.addLines([0, Math.floor(H * 0.52), W, H], 200, -0.12, 0.35, [40, 400], [1, 1], [30, 100], wat);
  for (const [bx, by] of [[0.35 * W, H * 0.48], [0.42 * W, H * 0.44]]) {
    const boat = [[[bx - 0.025 * W, by - 0.01 * H], [bx + 0.025 * W, by - 0.01 * H], [bx + 0.030 * W, by + 0.01 * H], [bx - 0.030 * W, by + 0.01 * H]]];
    const bi = boat.map((p) => p.map(([x, y]) => [Math.round(x), Math.round(y)]));
    c.addLines(c.bboxOf(bi), 70, 0.0, 0.25, [12, 80], [1, 2], [80, 175], c.polyMask(bi));
  }
  c.addArcs([0, 0, W, H], 280, [10, 140], [1, 2], [40, 125], [1, 0, 0, 0]);
  c.addArcs([0, 0, W, H], 220, [12, 160], [1, 2], [40, 125], [0, 1, 0, 0]);
  c.addArcs([0, 0, W, H], 240, [18, 190], [1, 2], [40, 130], [0, 0, 1, 0]);
  c.addArcs([0, 0, W, H], 320, [20, 110], [1, 3], [45, 150], [0, 0, 0, 1]);
  c.addArcs([0, 0, W, sky_b], 130, [15, 150], [1, 2], [35, 100], [2, 1, 1, 2], c.rectMask(0, 0, W, sky_b));
  c.addArcs([0, Math.floor(H * 0.52), W, H], 150, [12, 100], [1, 2], [35, 110], [1, 3, 2, 1], wat);
  c.addArcs(c.bboxOf(wave_body.concat(claw)), 200, [10, 100], [1, 2], [50, 145], [2, 1, 2, 3], c.polyMask(wave_body.concat(claw)));
}

// ── 04 梵高《星空》──
function paintVanGoghStarry(c) {
  const W = c.W, H = c.H;
  const sky_b = Math.floor(H * 0.62);
  c.addLines([0, 0, W, sky_b], 400, 0.0, 0.70, [30, 500], [1, 2], [35, 120], c.rectMask(0, 0, W, sky_b));
  c.addLines([0, 0, W, sky_b], 300, -0.20, 0.80, [25, 400], [1, 1], [25, 90], c.rectMask(0, 0, W, sky_b));
  const stars = [];
  for (const [sx, sy, sr] of [[0.35 * W, 0.18 * H, 50], [0.65 * W, 0.30 * H, 40], [0.22 * W, 0.40 * H, 35], [0.52 * W, 0.12 * H, 55], [0.78 * W, 0.22 * H, 30], [0.15 * W, 0.25 * H, 28]]) {
    stars.push([[sx - sr, sy - sr], [sx + sr, sy - sr], [sx + sr, sy + sr], [sx - sr, sy + sr]]);
  }
  const mr = 70;
  stars.push([[0.30 * W - mr, 0.25 * H - mr], [0.30 * W + mr, 0.25 * H - mr], [0.30 * W + mr, 0.25 * H + mr], [0.30 * W - mr, 0.25 * H + mr]]);
  c.addArcs([0, 0, W, sky_b], 250, [15, 80], [1, 2], [35, 110], [2, 1, 1, 4], c.rectMask(0, 0, W, sky_b));
  c.addArcs([0, 0, W, sky_b], 250, [30, 120], [1, 2], [40, 130], [1, 0, 2, 3], c.rectMask(0, 0, W, sky_b));
  const cypress = [[[0.08 * W, H], [0.06 * W, sky_b - 20], [0.12 * W, sky_b - 80], [0.14 * W, sky_b - 130], [0.12 * W, sky_b - 60], [0.16 * W, sky_b - 20], [0.18 * W, H * 0.70], [0.20 * W, H]]];
  c.addLines(c.bboxOf(cypress), 280, -1.40, 0.60, [15, 200], [1, 3], [60, 180], c.polyMask(cypress));
  c.addLines(c.bboxOf(cypress), 180, -1.50, 0.50, [10, 150], [1, 2], [45, 145], c.polyMask(cypress));
  const hills = [[[0.05 * W, sky_b], [0.15 * W, sky_b + 20], [0.28 * W, sky_b + 10], [0.40 * W, sky_b + 30], [0.55 * W, sky_b + 15], [0.68 * W, sky_b + 35], [0.80 * W, sky_b + 20], [0.90 * W, sky_b + 40], [0.95 * W, sky_b + 30], [0.95 * W, H], [0.05 * W, H]]];
  c.addLines(c.bboxOf(hills), 300, 0.10, 1.00, [15, 200], [1, 2], [45, 140], c.polyMask(hills));
  const vil = [];
  for (let i = 0; i < 8; i++) {
    const vx = 0.25 * W + i * 0.06 * W, vy = H * 0.78;
    const vh = Math.round(c.rng.range(25, 55)), vw = Math.round(c.rng.range(18, 35));
    vil.push([[vx - vw, vy - vh], [vx + vw, vy - vh], [vx + vw, vy], [vx - vw, vy]]);
  }
  c.addLines(c.bboxOf(vil), 250, -1.56, 0.15, [15, 100], [1, 2], [60, 165], c.polyMask(vil));
  const spire = [[[0.52 * W, H * 0.84], [0.50 * W, H * 0.68], [0.54 * W, H * 0.68], [0.56 * W, H * 0.84]]];
  c.addLines(c.bboxOf(spire), 90, -1.56, 0.10, [12, 80], [1, 2], [70, 175], c.polyMask(spire));
  c.addArcs([0, 0, W, H], 280, [10, 140], [1, 2], [40, 125], [1, 0, 0, 0]);
  c.addArcs([0, 0, W, H], 220, [12, 160], [1, 2], [40, 125], [0, 1, 0, 0]);
  c.addArcs([0, 0, W, H], 240, [18, 190], [1, 2], [40, 130], [0, 0, 1, 0]);
  c.addArcs([0, 0, W, H], 320, [20, 110], [1, 3], [45, 150], [0, 0, 0, 1]);
  c.addArcs(c.bboxOf(cypress), 120, [8, 80], [1, 2], [55, 160], [0, 0, 1, 4], c.polyMask(cypress));
  c.addArcs(c.bboxOf(hills.concat(vil)), 180, [10, 90], [1, 2], [50, 140], [1, 1, 2, 2], c.polyMask(hills.concat(vil)));
}

// ── 05 透纳《暴风雪中的汽船》──
function paintTurnerSnowstorm(c) {
  const W = c.W, H = c.H;
  c.addLines([0, 0, W, H], 500, -0.55, 0.80, [40, 550], [1, 3], [35, 130], c.rectMask(0, 0, W, H));
  c.addLines([0, 0, W, H], 400, 0.35, 0.90, [30, 480], [1, 2], [25, 110], c.rectMask(0, 0, W, H));
  c.addLines([0, 0, W, H], 350, -0.20, 1.00, [25, 420], [1, 2], [30, 120], c.rectMask(0, 0, W, H));
  const ship = [[[0.42 * W, H * 0.40], [0.58 * W, H * 0.34], [0.62 * W, H * 0.42], [0.46 * W, H * 0.48]]];
  c.addLines(c.bboxOf(ship), 200, 0.80, 0.50, [15, 180], [1, 3], [70, 185], c.polyMask(ship));
  c.addLines(c.bboxOf(ship), 120, 0.65, 0.60, [10, 130], [1, 2], [55, 155], c.polyMask(ship));
  const funnel = [[[0.50 * W, H * 0.22], [0.49 * W, H * 0.38], [0.53 * W, H * 0.38], [0.52 * W, H * 0.22]]];
  c.addLines(c.bboxOf(funnel), 120, -1.56, 0.15, [15, 150], [1, 2], [65, 170], c.polyMask(funnel));
  const steam = [[[0.48 * W, H * 0.15], [0.45 * W, H * 0.22], [0.50 * W, H * 0.18], [0.55 * W, H * 0.22], [0.52 * W, H * 0.15]]];
  c.addLines(c.bboxOf(steam), 150, -0.30, 0.90, [20, 160], [1, 2], [35, 100], c.polyMask(steam));
  const sea_b = Math.floor(H * 0.52);
  c.addLines([0, sea_b, W, H], 350, 0.0, 0.35, [40, 500], [1, 3], [40, 125], c.rectMask(0, sea_b, W, H));
  c.addLines([0, sea_b, W, H], 250, -0.10, 0.45, [35, 420], [1, 2], [30, 110], c.rectMask(0, sea_b, W, H));
  c.addArcs([0, 0, W, H], 350, [10, 150], [1, 2], [40, 130], [1, 1, 2, 3]);
  c.addArcs([0, 0, W, H], 300, [15, 180], [1, 2], [40, 135], [1, 0, 1, 3]);
  c.addArcs([0, 0, W, H], 300, [20, 160], [1, 3], [50, 150], [0, 0, 0, 1]);
  c.addArcs([0, sea_b, W, H], 150, [12, 100], [1, 2], [35, 110], [1, 3, 2, 1], c.rectMask(0, sea_b, W, H));
  c.addArcs(c.bboxOf(ship.concat(steam)), 150, [8, 80], [1, 2], [45, 140], [0, 0, 1, 3], c.polyMask(ship.concat(steam)));
}

// ── 06 郭熙《早春图》──
function paintGuoXi(c) {
  const W = c.W, H = c.H;
  const sky_b = Math.floor(H * 0.15);
  c.addLines([0, 0, W, sky_b], 250, 0.0, 0.40, [40, 380], [1, 2], [35, 105], c.rectMask(0, 0, W, sky_b));
  const main_pks = c.buildPeaks(
    [[0.50 * W, 300, 200], [0.32 * W, 240, 160], [0.68 * W, 220, 150]], sky_b + Math.floor(H * 0.12));
  c.addLines(c.bboxOf(main_pks), 380, -1.20, 0.95, [15, 220], [1, 2], [50, 145], c.polyMask(main_pks));
  c.addLines(c.bboxOf(main_pks), 260, -1.30, 0.70, [10, 160], [1, 1], [40, 125], c.polyMask(main_pks));
  const side_pks = c.buildPeaks(
    [[0.15 * W, 160, 100], [0.85 * W, 150, 90], [0.95 * W, 120, 70]], sky_b + Math.floor(H * 0.25));
  c.addLines(c.bboxOf(side_pks), 250, -1.15, 0.90, [12, 170], [1, 2], [45, 135], c.polyMask(side_pks));
  c.addLines(c.bboxOf(side_pks), 160, -1.25, 0.65, [8, 120], [1, 1], [35, 115], c.polyMask(side_pks));
  const mist_y = Math.floor(H * 0.42), mist_h = Math.floor(H * 0.12);
  c.addLines([0, mist_y, W, mist_y + mist_h], 300, 0.0, 0.22, [60, 520], [1, 2], [25, 90], c.rectMask(0, mist_y, W, mist_y + mist_h));
  c.addLines([0, mist_y, W, mist_y + mist_h], 200, -0.10, 0.30, [40, 440], [1, 1], [20, 75], c.rectMask(0, mist_y, W, mist_y + mist_h));
  const mid_mtn = c.buildPeaks(
    [[0.30 * W, 180, 120], [0.55 * W, 200, 140], [0.78 * W, 160, 110]], mist_y + Math.floor(H * 0.08));
  c.addLines(c.bboxOf(mid_mtn), 280, -1.20, 0.85, [12, 180], [1, 2], [50, 140], c.polyMask(mid_mtn));
  const fg_base = Math.floor(H * 0.65);
  const fg = [[[0.02 * W, H], [0.02 * W, fg_base], [0.15 * W, fg_base - 30], [0.25 * W, fg_base], [0.35 * W, fg_base - 20], [0.48 * W, fg_base], [0.55 * W, fg_base - 40], [0.68 * W, fg_base], [0.82 * W, fg_base - 25], [0.95 * W, fg_base], [0.95 * W, H]]];
  c.addLines(c.bboxOf(fg), 350, 0.40, 1.10, [15, 260], [1, 3], [55, 165], c.polyMask(fg));
  c.addLines(c.bboxOf(fg), 240, 0.60, 0.85, [12, 200], [1, 2], [40, 140], c.polyMask(fg));
  const tx = 0.38 * W, ty = fg_base - 60;
  const fig = [[[tx - 8, ty - 30], [tx - 5, ty], [tx + 5, ty], [tx + 8, ty - 30]]];
  const fi = fig.map((p) => p.map(([x, y]) => [Math.round(x), Math.round(y)]));
  c.addLines(c.bboxOf(fi), 60, -1.55, 0.20, [8, 60], [1, 2], [80, 170], c.polyMask(fi));
  c.addArcs([0, 0, W, H], 280, [10, 140], [1, 2], [40, 125], [1, 0, 0, 0]);
  c.addArcs([0, 0, W, H], 220, [12, 160], [1, 2], [40, 125], [0, 1, 0, 0]);
  c.addArcs([0, 0, W, H], 240, [18, 190], [1, 2], [40, 130], [0, 0, 1, 0]);
  c.addArcs([0, 0, W, H], 300, [20, 110], [1, 3], [45, 150], [0, 0, 0, 1]);
  c.addArcs([0, mist_y, W, mist_y + mist_h], 140, [12, 140], [1, 2], [25, 85], [1, 3, 2, 1], c.rectMask(0, mist_y, W, mist_y + mist_h));
  c.addArcs(c.bboxOf(main_pks.concat(mid_mtn)), 200, [8, 120], [1, 2], [50, 140], [1, 1, 2, 3], c.polyMask(main_pks.concat(mid_mtn)));
  c.addArcs(c.bboxOf(fg), 180, [8, 100], [1, 2], [50, 150], [2, 1, 2, 3], c.polyMask(fg));
}

// ── 07 莫奈《日出·印象》──
function paintMonetSunrise(c) {
  const W = c.W, H = c.H;
  const sky_b = Math.floor(H * 0.48);
  c.addLines([0, 0, W, sky_b], 350, 0.0, 0.40, [40, 480], [1, 2], [30, 110], c.rectMask(0, 0, W, sky_b));
  c.addLines([0, 0, W, sky_b], 220, -0.20, 0.50, [30, 400], [1, 1], [25, 85], c.rectMask(0, 0, W, sky_b));
  const sx = 0.65 * W, sy = H * 0.32, sr = 35;
  const sun = [[[sx - sr, sy - sr], [sx + sr, sy - sr], [sx + sr, sy + sr], [sx - sr, sy + sr]]];
  c.addLines(c.bboxOf(sun), 120, 0.0, 2.00, [8, 70], [1, 2], [80, 200], c.polyMask(sun));
  const sun_ref = [[[sx - 20, sy + sr], [sx + 20, sy + sr], [sx + 25, H * 0.80], [sx - 25, H * 0.80]]];
  c.addLines(c.bboxOf(sun_ref), 180, -1.56, 0.10, [15, 250], [1, 2], [40, 130], c.polyMask(sun_ref));
  const masts = [];
  for (const mx of [0.15 * W, 0.22 * W, 0.30 * W, 0.40 * W, 0.48 * W]) {
    const mh = Math.round(c.rng.range(60, 130));
    masts.push([[mx - 4, sky_b - 10], [mx + 4, sky_b - 10], [mx + 4, sky_b - 10 - mh], [mx - 4, sky_b - 10 - mh]]);
  }
  c.addLines(c.bboxOf(masts), 180, -1.56, 0.10, [12, 140], [1, 2], [60, 165], c.polyMask(masts));
  const wat_b = Math.floor(H * 0.50);
  c.addLines([0, wat_b, W, H], 400, 0.0, 0.15, [60, 540], [1, 2], [30, 120], c.rectMask(0, wat_b, W, H));
  c.addLines([0, wat_b, W, H], 280, -0.08, 0.20, [40, 460], [1, 1], [25, 95], c.rectMask(0, wat_b, W, H));
  const boats = [];
  for (const [bx, by] of [[0.60 * W, H * 0.68], [0.72 * W, H * 0.62], [0.35 * W, H * 0.72]]) {
    boats.push([[bx - 18, by - 6], [bx + 18, by - 6], [bx + 14, by + 6], [bx - 14, by + 6]]);
  }
  c.addLines(c.bboxOf(boats), 160, 0.0, 0.20, [10, 90], [1, 2], [70, 170], c.polyMask(boats));
  c.addArcs([0, 0, W, H], 260, [10, 140], [1, 2], [40, 125], [1, 0, 0, 0]);
  c.addArcs([0, 0, W, H], 200, [12, 160], [1, 2], [40, 125], [0, 1, 0, 0]);
  c.addArcs([0, 0, W, H], 220, [18, 190], [1, 2], [40, 130], [0, 0, 1, 0]);
  c.addArcs([0, 0, W, H], 280, [20, 110], [1, 3], [45, 150], [0, 0, 0, 1]);
  c.addArcs([0, wat_b, W, H], 160, [12, 120], [1, 2], [30, 105], [1, 3, 2, 1], c.rectMask(0, wat_b, W, H));
  c.addArcs([0, 0, W, sky_b], 130, [14, 130], [1, 2], [30, 95], [2, 1, 1, 2], c.rectMask(0, 0, W, sky_b));
}

// ── 08 李唐《万壑松风图》──
function paintLiTang(c) {
  const W = c.W, H = c.H;
  const sky_b = Math.floor(H * 0.15);
  c.addLines([0, 0, W, sky_b], 220, 0.0, 0.45, [40, 380], [1, 2], [30, 100], c.rectMask(0, 0, W, sky_b));
  const far_pks = c.buildPeaks(
    [[0.35 * W, 220, 150], [0.55 * W, 280, 180], [0.75 * W, 200, 130], [0.15 * W, 160, 100], [0.88 * W, 150, 90]],
    sky_b + Math.floor(H * 0.10));
  c.addLines(c.bboxOf(far_pks), 380, -1.20, 0.95, [15, 220], [1, 2], [48, 145], c.polyMask(far_pks));
  c.addLines(c.bboxOf(far_pks), 270, -1.30, 0.70, [10, 160], [1, 1], [38, 125], c.polyMask(far_pks));
  const mid_pks = c.buildPeaks(
    [[0.25 * W, 180, 120], [0.50 * W, 240, 150], [0.70 * W, 170, 110], [0.82 * W, 140, 90]],
    sky_b + Math.floor(H * 0.25));
  c.addLines(c.bboxOf(mid_pks), 320, -1.20, 0.90, [12, 200], [1, 2], [48, 140], c.polyMask(mid_pks));
  c.addLines(c.bboxOf(mid_pks), 200, -1.30, 0.65, [8, 140], [1, 1], [35, 120], c.polyMask(mid_pks));
  const wf = [[[0.52 * W, sky_b + Math.floor(H * 0.10)], [0.48 * W, sky_b + Math.floor(H * 0.35)], [0.54 * W, sky_b + Math.floor(H * 0.35)], [0.58 * W, sky_b + Math.floor(H * 0.10)]]];
  c.addLines(c.bboxOf(wf), 100, -1.55, 0.10, [20, 200], [1, 2], [30, 95], c.polyMask(wf));
  const pine_base = Math.floor(H * 0.55);
  const pine_polys = [];
  for (let i = 0; i < 25; i++) {
    const px = c.rng.range(0.05 * W, 0.95 * W);
    const ph = Math.round(c.rng.range(80, 220)), pw = Math.round(c.rng.range(12, 35));
    const py = c.rng.range(pine_base - 40, H);
    pine_polys.push([[px - pw, py], [px + pw, py], [px + pw * 0.5, py - ph], [px - pw * 0.5, py - ph]]);
  }
  c.addLines(c.bboxOf(pine_polys), 400, -1.40, 0.50, [12, 200], [1, 3], [55, 175], c.polyMask(pine_polys));
  c.addLines(c.bboxOf(pine_polys), 300, -1.45, 0.40, [8, 140], [1, 2], [40, 145], c.polyMask(pine_polys));
  const fg_rock = [[[0.02 * W, H], [0.02 * W, H * 0.62], [0.18 * W, H * 0.60], [0.30 * W, H * 0.65], [0.40 * W, H * 0.62], [0.55 * W, H * 0.66], [0.72 * W, H * 0.63], [0.85 * W, H * 0.67], [0.95 * W, H * 0.64], [0.95 * W, H]]];
  c.addLines(c.bboxOf(fg_rock), 300, 0.40, 1.05, [15, 240], [1, 3], [50, 160], c.polyMask(fg_rock));
  c.addLines(c.bboxOf(fg_rock), 200, 0.55, 0.80, [10, 180], [1, 2], [38, 130], c.polyMask(fg_rock));
  c.addArcs([0, 0, W, H], 280, [10, 140], [1, 2], [40, 125], [1, 0, 0, 0]);
  c.addArcs([0, 0, W, H], 220, [12, 160], [1, 2], [40, 125], [0, 1, 0, 0]);
  c.addArcs([0, 0, W, H], 240, [18, 190], [1, 2], [40, 130], [0, 0, 1, 0]);
  c.addArcs([0, 0, W, H], 300, [20, 110], [1, 3], [45, 150], [0, 0, 0, 1]);
  c.addArcs(c.bboxOf(far_pks.concat(mid_pks)), 180, [8, 120], [1, 2], [48, 140], [1, 1, 2, 3], c.polyMask(far_pks.concat(mid_pks)));
  c.addArcs(c.bboxOf(pine_polys.concat(fg_rock)), 220, [8, 100], [1, 2], [50, 150], [2, 1, 2, 3], c.polyMask(pine_polys.concat(fg_rock)));
}

// ── 09 歌川广重《大桥骤雨》──
function paintHiroshigeBridge(c) {
  const W = c.W, H = c.H;
  const sky_b = Math.floor(H * 0.35);
  c.addLines([0, 0, W, sky_b], 350, 0.0, 0.40, [30, 460], [1, 3], [40, 125], c.rectMask(0, 0, W, sky_b));
  c.addLines([0, sky_b, W, H], 300, -1.56, 0.05, [40, 180], [1, 1], [30, 100], c.rectMask(0, sky_b, W, H));
  c.addLines([0, sky_b, W, H], 250, -1.54, 0.08, [30, 150], [1, 1], [25, 90], c.rectMask(0, sky_b, W, H));
  const bridge = [[[0.05 * W, H * 0.42], [0.30 * W, H * 0.35], [0.65 * W, H * 0.38], [0.88 * W, H * 0.44], [0.85 * W, H * 0.30], [0.62 * W, H * 0.24], [0.28 * W, H * 0.22], [0.02 * W, H * 0.30]]];
  c.addLines(c.bboxOf(bridge), 300, -0.15, 0.30, [30, 300], [1, 3], [50, 160], c.polyMask(bridge));
  c.addLines(c.bboxOf(bridge), 200, -0.10, 0.25, [20, 240], [1, 2], [40, 135], c.polyMask(bridge));
  for (const bx of [0.15 * W, 0.30 * W, 0.50 * W, 0.72 * W]) {
    const col = [[[bx - 6, H * 0.30], [bx + 6, H * 0.30], [bx + 6, H * 0.48], [bx - 6, H * 0.48]]];
    c.addLines(c.bboxOf(col), 60, -1.55, 0.10, [15, 150], [1, 2], [55, 155], c.polyMask(col));
  }
  for (const [px, py] of [[0.20 * W, H * 0.28], [0.40 * W, H * 0.30], [0.55 * W, H * 0.32], [0.72 * W, H * 0.36], [0.80 * W, H * 0.38]]) {
    const person = [[[px - 6, py - 4], [px + 6, py - 4], [px + 6, py + 20], [px - 6, py + 20]]];
    const umbrella = [[[px - 18, py - 8], [px + 18, py - 8], [px + 15, py - 2], [px - 15, py - 2]]];
    const pi = person.concat(umbrella).map((p) => p.map(([x, y]) => [Math.round(x), Math.round(y)]));
    c.addLines(c.bboxOf(pi), 50, -1.55, 0.20, [8, 60], [1, 2], [70, 165], c.polyMask(pi));
  }
  const wat_b = Math.floor(H * 0.55);
  c.addLines([0, wat_b, W, H], 300, 0.0, 0.20, [50, 520], [1, 2], [30, 115], c.rectMask(0, wat_b, W, H));
  c.addLines([0, wat_b, W, H], 220, -0.06, 0.25, [40, 440], [1, 1], [25, 90], c.rectMask(0, wat_b, W, H));
  const bld = [];
  for (const bx of [0.15, 0.28, 0.42, 0.58, 0.70, 0.85]) {
    bld.push([[bx * W - 25, wat_b - 10], [bx * W + 25, wat_b - 10], [bx * W + 22, wat_b - 80], [bx * W - 22, wat_b - 80]]);
  }
  c.addLines(c.bboxOf(bld), 200, -1.56, 0.10, [10, 100], [1, 2], [55, 150], c.polyMask(bld));
  c.addArcs([0, 0, W, H], 260, [10, 140], [1, 2], [40, 125], [1, 0, 0, 0]);
  c.addArcs([0, 0, W, H], 200, [12, 160], [1, 2], [40, 125], [0, 1, 0, 0]);
  c.addArcs([0, 0, W, H], 220, [18, 190], [1, 2], [40, 130], [0, 0, 1, 0]);
  c.addArcs([0, 0, W, H], 280, [20, 110], [1, 3], [45, 150], [0, 0, 0, 1]);
  c.addArcs(c.bboxOf(bridge), 150, [8, 80], [1, 2], [45, 140], [2, 1, 1, 3], c.polyMask(bridge));
  c.addArcs([0, wat_b, W, H], 140, [10, 110], [1, 2], [30, 100], [1, 3, 2, 1], c.rectMask(0, wat_b, W, H));
}

// ── 10 塞尚《圣维克多山》──
function paintCezanneMountain(c) {
  const W = c.W, H = c.H;
  const sky_b = Math.floor(H * 0.48);
  c.addLines([0, 0, W, sky_b], 350, 0.0, 0.50, [40, 480], [1, 2], [30, 110], c.rectMask(0, 0, W, sky_b));
  c.addLines([0, 0, W, sky_b], 220, -0.25, 0.55, [30, 380], [1, 1], [25, 80], c.rectMask(0, 0, W, sky_b));
  const mtn = c.buildPeaks([[0.48 * W, 280, 200]], sky_b + Math.floor(H * 0.02));
  c.addLines(c.bboxOf(mtn), 380, -1.20, 0.90, [15, 250], [1, 3], [48, 150], c.polyMask(mtn));
  c.addLines(c.bboxOf(mtn), 270, -1.30, 0.65, [10, 190], [1, 2], [38, 130], c.polyMask(mtn));
  const slope_blocks = [];
  for (let i = 0; i < 8; i++) {
    const bx = 0.25 * W + i * 0.06 * W, by = sky_b + Math.round(c.rng.range(80, 180));
    const bw = Math.round(c.rng.range(30, 70)), bh = Math.round(c.rng.range(25, 60));
    slope_blocks.push([[bx, by], [bx + bw, by], [bx + bw * 0.8, by + bh], [bx - bw * 0.2, by + bh]]);
  }
  c.addLines(c.bboxOf(slope_blocks), 220, -1.10, 0.70, [8, 120], [1, 2], [45, 135], c.polyMask(slope_blocks));
  const viaduct = [[[0.18 * W, H * 0.52], [0.82 * W, H * 0.50], [0.82 * W, H * 0.48], [0.18 * W, H * 0.50]]];
  c.addLines(c.bboxOf(viaduct), 150, 0.0, 0.08, [30, 600], [1, 2], [35, 110], c.polyMask(viaduct));
  const fg = Math.floor(H * 0.58);
  const fg_patches = [];
  for (let i = 0; i < 15; i++) {
    const px = c.rng.range(0.03 * W, 0.97 * W), py = c.rng.range(fg, H - 20);
    const pw = Math.round(c.rng.range(40, 120)), ph = Math.round(c.rng.range(25, 80));
    fg_patches.push([[px, py], [px + pw, py], [px + pw * 0.7, py + ph], [px - pw * 0.3, py + ph]]);
  }
  c.addLines(c.bboxOf(fg_patches), 350, 0.30, 0.90, [12, 200], [1, 3], [45, 150], c.polyMask(fg_patches));
  c.addLines(c.bboxOf(fg_patches), 240, 0.45, 0.70, [8, 150], [1, 2], [35, 125], c.polyMask(fg_patches));
  const trees = [];
  for (let i = 0; i < 20; i++) {
    const tx = c.rng.range(0.05 * W, 0.93 * W), ty = c.rng.range(fg - 30, H - 30);
    const th = Math.round(c.rng.range(40, 130)), tw = Math.round(c.rng.range(15, 40));
    trees.push([[tx - tw, ty], [tx + tw, ty], [tx + tw * 0.5, ty - th], [tx - tw * 0.5, ty - th]]);
  }
  c.addLines(c.bboxOf(trees), 280, -1.42, 0.45, [10, 160], [1, 2], [50, 155], c.polyMask(trees));
  c.addArcs([0, 0, W, H], 280, [10, 140], [1, 2], [40, 125], [1, 0, 0, 0]);
  c.addArcs([0, 0, W, H], 220, [12, 160], [1, 2], [40, 125], [0, 1, 0, 0]);
  c.addArcs([0, 0, W, H], 240, [18, 190], [1, 2], [40, 130], [0, 0, 1, 0]);
  c.addArcs([0, 0, W, H], 300, [20, 110], [1, 3], [45, 150], [0, 0, 0, 1]);
  c.addArcs(c.bboxOf(mtn.concat(slope_blocks)), 160, [8, 120], [1, 2], [48, 140], [1, 1, 2, 3], c.polyMask(mtn.concat(slope_blocks)));
  c.addArcs(c.bboxOf(fg_patches.concat(trees)), 200, [8, 100], [1, 2], [48, 145], [2, 1, 2, 3], c.polyMask(fg_patches.concat(trees)));
}

// ── 风格登记表 ──
const STYLES = [
  { key: "01_friedrich", artist: "Caspar David Friedrich", title: "Wanderer Above the Sea of Fog", isHoriz: false, paint: paintFriedrich },
  { key: "02_fan_kuan", artist: "Fan Kuan", title: "Travelers Among Mountains and Streams", isHoriz: false, paint: paintFanKuan },
  { key: "03_hokusai", artist: "Katsushika Hokusai", title: "The Great Wave off Kanagawa", isHoriz: true, paint: paintHokusaiWave },
  { key: "04_van_gogh", artist: "Vincent van Gogh", title: "The Starry Night", isHoriz: false, paint: paintVanGoghStarry },
  { key: "05_turner", artist: "J.M.W. Turner", title: "Snow Storm - Steam-Boat", isHoriz: true, paint: paintTurnerSnowstorm },
  { key: "06_guo_xi", artist: "Guo Xi", title: "Early Spring", isHoriz: false, paint: paintGuoXi },
  { key: "07_monet", artist: "Claude Monet", title: "Impression, Sunrise", isHoriz: true, paint: paintMonetSunrise },
  { key: "08_li_tang", artist: "Li Tang", title: "Wind in Pines Among Myriad Valleys", isHoriz: false, paint: paintLiTang },
  { key: "09_hiroshige", artist: "Utagawa Hiroshige", title: "Sudden Shower over Bridge", isHoriz: false, paint: paintHiroshigeBridge },
  { key: "10_cezanne", artist: "Paul Cezanne", title: "Mont Sainte-Victoire", isHoriz: true, paint: paintCezanneMountain },
];

// 用经典笔法打底
function paintClassic(c, styleKey) {
  const s = STYLES.find((x) => x.key === styleKey);
  if (!s) throw new Error("unknown style: " + styleKey);
  s.paint(c);
}


// draftgen/random.js
// 随机场景生成器 —— 移植自 random_sketch_generator.py。
// 对外导出：generateRandomScene、generateOne、listStyles、STYLE_KEYS、randomSeed


let DENSITY = 1; // 1 / 2 / 3：整体线条数量放大倍数

// ── 密度原语（按 DENSITY 放大 n）──
function dense_lines(c, bbox, n, ang, sp, lr, wr, ar, mask = null) {
  c.addLines(bbox, Math.round(n * DENSITY), ang, sp, lr, wr, ar, mask);
}
function dense_arcs(c, bbox, n, rr, wr, ar, kw, mask = null) {
  c.addArcs(bbox, Math.round(n * DENSITY), rr, wr, ar, kw, mask);
}

// 全画布乱涂层：+extra_lines 线 + extra_arcs 弧
function _global_pile(c, W, H, extra_lines = 10000, extra_arcs = 3000) {
  const full = [0, 0, W, H];
  const full_mask = c.rectMask(0, 0, W, H);
  dense_lines(c, full, extra_lines, 0.0, Math.PI, [8, 110], [1, 2], [35, 140], full_mask);
  dense_arcs(c, full, extra_arcs, [4, 60], [1, 2], [45, 150], [3, 1, 2, 4], full_mask);
}

// 把画面切 3 条横向带，每条带不同排线方向
function _band_regions(W, H) {
  return [
    [[0, 0, W, Math.floor(H * 0.42)], 0.0],
    [[0, Math.floor(H * 0.42), W, Math.floor(H * 0.72)], 1.57],
    [[0, Math.floor(H * 0.72), W, H], 0.6],
  ];
}

// 给一组区域做密集交叉排线 + 圆弧（每个区域 5000+ 线 + 弧）
function dense_overlay(c, W, H, bands) {
  const full = [0, 0, W, H];
  for (const [bbox, ang] of bands) {
    const mask = c.rectMask(bbox[0], bbox[1], bbox[2], bbox[3]);
    dense_lines(c, full, 3200, ang, 0.45, [8, 90], [1, 2], [40, 150], mask);
    dense_lines(c, full, 3200, ang + 1.2, 0.50, [8, 90], [1, 2], [40, 150], mask);
    dense_arcs(c, full, 1800, [5, 70], [1, 2], [50, 160], [2, 1, 1, 3], mask);
  }
}

// 经典笔法打底 + 密集线法重绘 + 全画布乱涂层
function paint_classic(c, styleKey, W, H) {
  paintClassic(c, styleKey);
  dense_overlay(c, W, H, _band_regions(W, H));
  _global_pile(c, W, H);
}

// 从零随机构建一张风景草稿
function buildRandomSceneDense(c, W, H) {
  const rnd = c.rng;
  const full = [0, 0, W, H];
  const sky_ratio = rnd.range(0.32, 0.62);
  const horizon = Math.floor(H * sky_ratio);

  // 天空
  const sky_mask = c.rectMask(0, 0, W, horizon);
  dense_lines(c, full, 6000, 0.0, 0.40, [30, 260], [1, 2], [28, 90], sky_mask);
  dense_lines(c, full, 3000, 0.5, 0.40, [30, 260], [1, 2], [28, 90], sky_mask);
  dense_arcs(c, full, 2000, [20, 90], [1, 2], [30, 90], [1, 1, 1, 0], sky_mask);

  // 太阳 / 月亮
  if (rnd.next() < 0.55) {
    const cx = rnd.range(W * 0.15, W * 0.85);
    const cy = rnd.range(H * 0.08, horizon * 0.7);
    const r = rnd.range(40, 110);
    const smask = c.rectMask(cx - r, cy - r, cx + r, cy + r);
    dense_arcs(c, [cx - r, cy - r, cx + r, cy + r], 1500, [r * 0.3, r * 0.95], [1, 2], [40, 120], [1, 0, 0, 0], smask);
    dense_arcs(c, [cx - r, cy - r, cx + r, cy + r], 1000, [r * 0.2, r * 0.7], [1, 2], [45, 130], [0, 1, 0, 0], smask);
  }

  // 云
  if (rnd.next() < 0.70) {
    for (let i = 0; i < rnd.int(2, 5); i++) {
      const cx = rnd.range(W * 0.1, W * 0.9);
      const cy = rnd.range(H * 0.05, horizon * 0.6);
      const cw = rnd.range(120, 320);
      const ch = cw * rnd.range(0.2, 0.35);
      const cmask = c.rectMask(cx - cw, cy - ch, cx + cw, cy + ch);
      dense_arcs(c, [cx - cw, cy - ch, cx + cw, cy + ch], 1200, [30, 90], [1, 2], [30, 90], [1, 1, 1, 0], cmask);
    }
  }

  // 山脉：远 / 中 / 近
  function addRange(base_y, count, hmin, hmax, wmin, wmax) {
    const peaks = [];
    for (let i = 0; i < count; i++) peaks.push([rnd.range(W * 0.05, W * 0.95), rnd.range(hmin, hmax), rnd.range(wmin, wmax)]);
    const polys = c.buildPeaks(peaks, base_y);
    const mask = c.polyMask(polys);
    dense_lines(c, full, 6000, 1.57, 0.6, [20, 120], [1, 2], [40, 120], mask);
    dense_lines(c, full, 2500, 0.8, 0.6, [20, 120], [1, 2], [40, 120], mask);
    dense_arcs(c, full, 2000, [8, 90], [1, 2], [45, 135], [1, 1, 2, 3], mask);
    return polys;
  }
  addRange(horizon, rnd.int(2, 4), H * 0.12, H * 0.22, W * 0.12, W * 0.22);
  addRange(Math.floor(horizon + H * 0.06), rnd.int(2, 4), H * 0.16, H * 0.30, W * 0.14, W * 0.26);
  addRange(Math.floor(horizon + H * 0.16), rnd.int(1, 3), H * 0.18, H * 0.32, W * 0.16, W * 0.30);

  // 水面
  const has_water = rnd.next() < 0.50;
  let ground_top = Math.floor(horizon + H * 0.05);
  if (has_water) {
    const wmask = c.rectMask(0, ground_top, W, H);
    dense_lines(c, full, 6000, 0.0, 0.12, [60, 300], [1, 2], [25, 80], wmask);
    dense_lines(c, full, 2500, 0.15, 0.12, [60, 300], [1, 2], [25, 80], wmask);
    dense_arcs(c, full, 1800, [10, 70], [1, 2], [30, 90], [1, 1, 1, 0], wmask);
    ground_top = Math.floor(horizon + H * 0.20);
  }

  // 前景地面
  const gmask = c.rectMask(0, ground_top, W, H);
  dense_lines(c, full, 6500, rnd.range(-0.2, 0.2), 0.5, [30, 200], [1, 3], [40, 130], gmask);

  // 树
  if (rnd.next() < 0.75) {
    for (let i = 0; i < rnd.int(2, 6); i++) {
      const tx = rnd.range(W * 0.05, W * 0.95);
      const ty = rnd.range(ground_top + H * 0.05, H * 0.95);
      const th = rnd.range(H * 0.08, H * 0.20);
      const tw = th * rnd.range(0.1, 0.2);
      const tmask = c.rectMask(tx - tw * 3, ty - th * 1.4, tx + tw * 3, ty + 5);
      dense_lines(c, full, 2800, -1.57, 0.18, [Math.floor(th * 0.3), Math.floor(th * 0.5)], [1, 2], [60, 150], tmask);
      dense_arcs(c, [tx - tw * 3, ty - th * 1.4, tx + tw * 3, ty - th * 0.4], 3000, [tw, tw * 2.2], [1, 2], [45, 135], [1, 1, 1, 1], tmask);
    }
  }

  // 建筑
  if (rnd.next() < 0.40) {
    for (let i = 0; i < rnd.int(1, 4); i++) {
      const bx = rnd.range(W * 0.1, W * 0.9);
      const by = rnd.range(ground_top + H * 0.05, H * 0.8);
      const bw = rnd.range(W * 0.04, W * 0.10);
      const bh = rnd.range(H * 0.06, H * 0.18);
      const polys = [[[bx, by], [bx, by - bh], [bx + bw, by - bh], [bx + bw, by]]];
      const bmask = c.polyMask(polys);
      dense_lines(c, c.bboxOf(polys), 5500, 0.0, 0.5, [20, Math.floor(bh)], [1, 2], [50, 140], bmask);
    }
  }

  // 道路
  if (rnd.next() < 0.45) {
    const rx = rnd.range(W * 0.2, W * 0.8);
    const polys = [[[rx - 20, H], [rx + 20, H], [rx + W * 0.08, ground_top], [rx - W * 0.08, ground_top]]];
    const rmask = c.polyMask(polys);
    dense_lines(c, c.bboxOf(polys), 5500, 1.57, 0.4, [20, 160], [1, 2], [40, 120], rmask);
  }

  // 鸟群
  if (rnd.next() < 0.60) {
    for (let i = 0; i < rnd.int(3, 9); i++) {
      const bx = rnd.range(W * 0.1, W * 0.9);
      const by = rnd.range(H * 0.1, horizon * 0.8);
      const bs = rnd.range(15, 35);
      dense_arcs(c, [bx - bs, by - bs * 0.4, bx + bs, by + bs * 0.4], 600, [bs, bs], [1, 2], [60, 150], [0, 0, 1, 0]);
    }
  }

  _global_pile(c, W, H, 10000, 3000);
}

// ── 对外核心接口 ──
function generateRandomScene(opts = {}) {
  const { seed = null, focalIdx = null, orientation = null, styleKey = null, density = 1 } = opts;
  DENSITY = Math.max(1, Math.min(3, Math.floor(density)));
  const sKeys = STYLES.map((s) => s.key);
  const useSeed = seed != null ? seed : Math.floor(Math.random() * 999999);

  let style = styleKey;
  let isHoriz;
  if (sKeys.includes(style)) {
    isHoriz = STYLES.find((s) => s.key === style).isHoriz;
  } else if (style === "random_scene") {
    isHoriz = (orientation || (Math.random() < 0.5 ? "horiz" : "vert")) === "horiz";
  } else if (Math.random() < 0.8) {
    style = sKeys[Math.floor(Math.random() * sKeys.length)];
    isHoriz = STYLES.find((s) => s.key === style).isHoriz;
  } else {
    style = "random_scene";
    isHoriz = (orientation || (Math.random() < 0.5 ? "horiz" : "vert")) === "horiz";
  }

  const [w, h] = isHoriz ? [1450, 1050] : [1100, 1450];
  const fIdx = focalIdx != null ? focalIdx : Math.floor(Math.random() * FOCAL_POINTS.length);
  const [fx_frac, fy_frac, focal_label] = FOCAL_POINTS[fIdx];
  const focal = [Math.floor(w * fx_frac), Math.floor(h * fy_frac)];

  const c = new SketchEngine(w, h, { seed: useSeed, focal });
  if (style === "random_scene") buildRandomSceneDense(c, w, h);
  else paint_classic(c, style, w, h);
  c.focalBurst();

  const meta = { seed: useSeed, focalIdx: fIdx, focal: focal_label, style, w, h, density: DENSITY };
  return { canvas: c.getCanvas(), meta, engine: c };
}

function generateOne(opts = {}) {
  const { canvas, meta } = generateRandomScene(opts);
  meta.dataURL = canvas.toDataURL("image/png");
  return { canvas, meta, dataURL: meta.dataURL };
}

function listStyles() {
  return STYLES.map((s) => ({ key: s.key, artist: s.artist, title: s.title }));
}

const STYLE_KEYS = STYLES.map((s) => s.key);
function randomSeed() { return Math.floor(Math.random() * 999999) + 1; }


// draftgen/compose.js
// A4 场景构图助手 —— 移植自 a4_scene_draft.html 的「结构草稿」部分（无需服务器）。
// 提供：FORMATS、ENV、drawGuides（往已有 ctx 画辅助线）、composeScene（生成整张构图草稿）。
// 对外导出：FORMATS、ENV、drawGuides、composeScene


const FORMATS = {
  a4p: [1240, 1754], a4l: [1754, 1240],
  sq: [1200, 1200], r169: [1600, 900], r34: [1080, 1440],
};

const COL = { paper: "#f4efe2", ink: "#3a3a38", inkSoft: "#8a857a", inkFaint: "#b9b3a4" };
const GUIDE = {
  thirds: "rgba(192,57,43,0.6)", golden: "rgba(212,175,55,0.85)", diag: "rgba(41,110,143,0.8)",
  cross: "rgba(120,120,120,0.8)", frame: "rgba(46,125,50,0.8)", persp: "rgba(142,68,173,0.85)", grid3d: "rgba(32,150,140,0.6)",
};

const ENV = {
  day: { sky1: "#cfe6f2", sky2: "#eef4f7", ground: "rgba(150,135,108,0.26)", water: "rgba(120,160,185,0.30)", orb: "#f4d35e", orbType: "sun", ox: 0.78, oy: 0.16, or: 34 },
  dusk: { sky1: "#f6b27a", sky2: "#fce4cf", ground: "rgba(150,110,85,0.30)", water: "rgba(190,140,120,0.32)", orb: "#ff9e5e", orbType: "sun", ox: 0.70, oy: 0.30, or: 46 },
  night: { sky1: "#27374f", sky2: "#46566f", ground: "rgba(70,82,100,0.32)", water: "rgba(40,60,90,0.4)", orb: "#eef0d8", orbType: "moon", ox: 0.24, oy: 0.14, or: 26 },
  fog: { sky1: "#dfe3e3", sky2: "#eef1f1", ground: "rgba(170,170,165,0.26)", water: "rgba(170,180,185,0.3)", orb: "#e8ebeb", orbType: "sun", ox: 0.50, oy: 0.18, or: 30 },
  snow: { sky1: "#dfe9f0", sky2: "#f3f7fa", ground: "rgba(220,228,235,0.45)", water: "rgba(190,205,215,0.35)", orb: "#eaf2f8", orbType: "sun", ox: 0.76, oy: 0.16, or: 32 },
};

const SCENES = ["landscape", "seascape", "lake", "village", "figure", "desert", "forest", "city"];
const SCENE_SUBJ = { landscape: "tree", seascape: "lighthouse", lake: "boat", village: "house", figure: "figure", desert: "cactus", forest: "tree", city: "house" };

// 往一个已有的 2D context 上画构图辅助线
function drawGuides(ctx, W, H, guides = {}, persp = {}) {
  const fp = () => [[W / 3, H / 3], [2 * W / 3, H / 3], [W / 3, 2 * H / 3], [2 * W / 3, 2 * H / 3]];
  const line = (x1, y1, x2, y2, c, w = 1) => { ctx.strokeStyle = c; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
  const dot = (x, y, c, r = 5) => { ctx.fillStyle = c || COL.ink; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); };

  if (guides.thirds) {
    ctx.setLineDash([6, 6]);
    [W / 3, 2 * W / 3].forEach((x) => line(x, 0, x, H, GUIDE.thirds, 1));
    [H / 3, 2 * H / 3].forEach((y) => line(0, y, W, y, GUIDE.thirds, 1));
    ctx.setLineDash([]);
    fp().forEach((p) => { ctx.beginPath(); ctx.arc(p[0], p[1], 10, 0, Math.PI * 2); ctx.lineWidth = 1.5; ctx.strokeStyle = GUIDE.thirds; ctx.stroke(); });
  }
  if (guides.golden) {
    const gx1 = W * 0.382, gx2 = W * 0.618, gy1 = H * 0.382, gy2 = H * 0.618;
    line(gx1, 0, gx1, H, GUIDE.golden, 1); line(gx2, 0, gx2, H, GUIDE.golden, 1);
    line(0, gy1, W, gy1, GUIDE.golden, 1); line(0, gy2, W, gy2, GUIDE.golden, 1);
    ctx.strokeStyle = GUIDE.golden; ctx.lineWidth = 1.4; ctx.beginPath();
    const turns = 3.2, maxR = Math.min(W, H) * 0.46, cx = W * 0.382, cy = H * 0.618;
    let first = true;
    for (let a = 0; a < turns * 2 * Math.PI; a += 0.1) { const r = maxR * (a / (turns * 2 * Math.PI)); const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r; first ? (ctx.moveTo(px, py), first = false) : ctx.lineTo(px, py); }
    ctx.stroke();
  }
  if (guides.diag) {
    line(0, 0, W, H, GUIDE.diag, 1); line(W, 0, 0, H, GUIDE.diag, 1);
    ctx.strokeStyle = GUIDE.diag; ctx.lineWidth = 1; const r = Math.min(W, H) * 0.16;
    [[0, 0, 0, Math.PI / 2], [W, 0, -Math.PI / 2, 0], [0, H, Math.PI / 2, Math.PI], [W, H, Math.PI, Math.PI * 1.5]].forEach((c) => { ctx.beginPath(); ctx.arc(c[0], c[1], r, c[2], c[3]); ctx.stroke(); });
  }
  if (guides.cross) { line(W / 2, 0, W / 2, H, GUIDE.cross, 1); line(0, H / 2, W, H / 2, GUIDE.cross, 1); dot(W / 2, H / 2, GUIDE.cross, 5); }
  if (guides.frame) { const m = Math.min(W, H) * 0.06; ctx.strokeStyle = GUIDE.frame; ctx.lineWidth = 1.2; ctx.setLineDash([4, 4]); ctx.strokeRect(m, m, W - 2 * m, H - 2 * m); ctx.setLineDash([]); }
  if (persp && persp.on) {
    const hy = H * 0.5;
    if (persp.mode === "one") {
      const vpX = persp.pos === "left" ? W * 0.28 : persp.pos === "right" ? W * 0.72 : W * 0.5;
      line(0, hy, W, hy, GUIDE.persp, 1);
      [[0, 0], [W, 0], [0, H], [W, H], [W / 3, 0], [2 * W / 3, 0], [0, H / 3], [0, 2 * H / 3], [W, H / 3], [W, 2 * H / 3]].forEach((q) => line(vpX, hy, q[0], q[1], GUIDE.persp, 1));
      dot(vpX, hy, GUIDE.persp, 6);
    } else {
      const vpL = [W * 0.15, hy], vpR = [W * 0.85, hy];
      line(0, hy, W, hy, GUIDE.persp, 1);
      [[0, 0], [0, H], [W / 2, 0], [W / 2, H], [0, H / 3], [0, 2 * H / 3]].forEach((q) => line(vpL[0], vpL[1], q[0], q[1], GUIDE.persp, 1));
      [[W, 0], [W, H], [W / 2, 0], [W / 2, H], [W, H / 3], [W, 2 * H / 3]].forEach((q) => line(vpR[0], vpR[1], q[0], q[1], GUIDE.persp, 1));
      dot(vpL[0], vpL[1], GUIDE.persp, 6); dot(vpR[0], vpR[1], GUIDE.persp, 6);
    }
  }
}

// 生成一整张构图草稿（纸 + 天空/地面 + 主体 + 辅助线）
function composeScene(opts = {}) {
  const state = {
    format: opts.format || "a4p",
    focal: opts.focal || "auto",
    scene: opts.scene || "auto",
    env: opts.env || "day",
    subjStyle: opts.subjStyle || "2d",
    obj3d: opts.obj3d || "cube",
    scale: opts.scale != null ? opts.scale : 1.0,
    guides: Object.assign({ thirds: true, golden: false, diag: false, cross: false, frame: false, grid3d: false }, opts.guides || {}),
    persp: Object.assign({ on: false, mode: "one", pos: "center" }, opts.persp || {}),
  };

  const [W, H] = FORMATS[state.format] || FORMATS.a4p;
  const rnd = state.seed != null ? makeRNG(state.seed) : null;
  const R = () => (rnd ? rnd.next() : Math.random());
  const rand = (a, b) => a + (b - a) * R();
  const pick = (a) => a[Math.floor(R() * a.length)];

  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");

  // —— 基础笔触 ——
  const line = (x1, y1, x2, y2, c, w = 1) => { ctx.strokeStyle = c; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
  const dot = (x, y, c, r = 5) => { ctx.fillStyle = c || COL.ink; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); };
  const sketchLine = (x1, y1, x2, y2, o = {}) => {
    const segs = o.segs || 8, jit = o.jit != null ? o.jit : 2.2, col = o.color || COL.ink, w = o.width || 1.4;
    ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(x1, y1);
    for (let i = 1; i <= segs; i++) { const t = i / segs; ctx.lineTo(x1 + (x2 - x1) * t + rand(-jit, jit), y1 + (y2 - y1) * t + rand(-jit, jit)); }
    ctx.stroke();
  };
  const sketchPoly = (pts, o = {}) => {
    ctx.strokeStyle = o.color || COL.ink; ctx.lineWidth = o.width || 1.4; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    if (o.close) ctx.closePath();
    if (o.fill) { ctx.fillStyle = o.fill; ctx.fill(); }
    ctx.stroke();
  };
  const ellipse = (cx, cy, rx, ry, fill) => {
    ctx.beginPath(); for (let a = 0; a <= Math.PI * 2 + 0.1; a += 0.2) { const px = cx + Math.cos(a) * rx, py = cy + Math.sin(a) * ry; a === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py); }
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    ctx.strokeStyle = COL.ink; ctx.lineWidth = 1.6; ctx.stroke();
  };
  const focalPoints = () => [[W / 3, H / 3], [2 * W / 3, H / 3], [W / 3, 2 * H / 3], [2 * W / 3, 2 * H / 3]];

  // —— 背景 ——
  const softCircle = (cx, cy, r, color) => { const g = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r); g.addColorStop(0, color); g.addColorStop(1, "rgba(255,255,255,0)"); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); };
  const drawMoon = (cx, cy, r, c) => { dot(cx, cy, c, r); ctx.fillStyle = "rgba(0,0,0,0.12)"; [[-r * 0.3, -r * 0.2, r * 0.18], [r * 0.3, r * 0.1, r * 0.12], [0, r * 0.35, r * 0.1]].forEach((d) => { ctx.beginPath(); ctx.arc(cx + d[0], cy + d[1], d[2], 0, Math.PI * 2); ctx.fill(); }); };
  const drawStars = (hy) => { ctx.fillStyle = "rgba(255,255,255,0.85)"; for (let i = 0; i < 90; i++) { const x = rand(0, W), y = rand(0, hy * 0.92); ctx.fillRect(x, y, rand(1, 2.2), rand(1, 2.2)); } };
  const drawClouds = (hy, n) => { for (let i = 0; i < n; i++) { const cx = rand(W * 0.08, W * 0.92), cy = rand(H * 0.05, hy * 0.65), w = rand(60, 160); sketchCurve(cx - w, cy, cx + w, cy, rand(-8, -18), { color: COL.inkFaint, width: 1, segs: 18 }); sketchCurve(cx - w * 0.6, cy - 6, cx + w * 0.6, cy - 6, rand(-6, -12), { color: COL.inkFaint, width: 1, segs: 14 }); } };
  const drawSnow = (hy) => { ctx.fillStyle = "rgba(255,255,255,0.9)"; for (let i = 0; i < 120; i++) { ctx.beginPath(); ctx.arc(rand(0, W), rand(0, H), rand(1, 2.6), 0, Math.PI * 2); ctx.fill(); } };
  const sketchCurve = (x1, y1, x2, y2, sag, o = {}) => { const steps = 22; ctx.strokeStyle = o.color || COL.ink; ctx.lineWidth = o.width || 1.4; ctx.lineCap = "round"; ctx.beginPath(); for (let i = 0; i <= steps; i++) { const t = i / steps; const x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t + Math.sin(t * Math.PI) * sag; i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); } ctx.stroke(); };
  const drawSky = (env, hy) => {
    const e = ENV[env];
    const g = ctx.createLinearGradient(0, 0, 0, hy); g.addColorStop(0, e.sky1); g.addColorStop(1, e.sky2);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, hy);
    const ox = W * e.ox, oy = hy * e.oy;
    if (e.orbType === "sun") softCircle(ox, oy, e.or * 2.4, e.orb); else drawMoon(ox, oy, e.or, e.orb);
    if (env === "night") drawStars(hy);
    else if (env === "snow") drawSnow(hy);
    else drawClouds(hy, env === "fog" ? 3 : 5);
    if (env === "fog" || env === "snow") { ctx.fillStyle = "rgba(255,255,255,0.18)"; ctx.fillRect(0, 0, W, H); }
  };
  const drawMountains = (hy, layer, color) => {
    const baseY = hy + layer * 26, amp = layer === 0 ? H * 0.10 : H * 0.16, step = layer === 0 ? W / 4 : W / 3;
    const pp = [[-20, baseY]]; let x = -20;
    while (x < W + 20) { const nx = x + step; const peak = baseY - rand(amp * 0.4, amp); pp.push([(x + nx) / 2, peak]); pp.push([nx, baseY - rand(0, amp * 0.3)]); x = nx; }
    pp.push([W + 20, baseY]); sketchPoly(pp, { color, width: 1.4, fill: color.replace("1)", "0.16)") });
  };
  const drawGround = (hy, color) => { ctx.fillStyle = color; ctx.fillRect(0, hy, W, H - hy); for (let i = 0; i < 40; i++) { const y = rand(hy + 10, H - 10), x = rand(0, W), len = rand(20, 80); sketchLine(x, y, x + len, y + rand(-4, 4), { color: COL.inkFaint, width: 0.8, jit: 1.2, segs: 4 }); } };
  const drawWater = (hy, color) => { ctx.fillStyle = color; ctx.fillRect(0, hy, W, H - hy); for (let i = 0; i < 26; i++) { const y = rand(hy + 12, H - 12), x = rand(0, W * 0.9), len = rand(30, 120); sketchLine(x, y, x + len, y, { color: "rgba(120,160,185,0.5)", width: 0.9, jit: 1, segs: 5 }); } };
  const drawDunes = (hy, color) => { ctx.fillStyle = color; ctx.fillRect(0, hy, W, H - hy); for (let k = 0; k < 3; k++) { const y = hy + (H - hy) * (0.2 + k * 0.25); sketchCurve(-20, y, W + 20, y + rand(-20, 20), rand(-30, -60), { color: COL.inkSoft, width: 1.4, segs: 30 }); } };
  const drawSceneBG = (scene, hy) => {
    const e = ENV[state.env];
    if (scene === "seascape" || scene === "lake") drawWater(hy, e.water);
    else if (scene === "desert") drawDunes(hy, e.ground);
    else if (scene === "city") drawSkyBuildings(hy);
    else { drawMountains(hy, 0, "rgba(120,130,140,1)"); drawGround(hy, e.ground); if (["landscape", "village", "figure", "forest"].includes(scene)) drawMountains(hy, 1, "rgba(90,100,95,1)"); }
    if (scene === "forest") for (let i = 0; i < 5; i++) { const fx = rand(W * 0.1, W * 0.9); const fy = hy + rand(20, H * 0.18); drawTree(fx, fy, rand(0.4, 0.7)); }
  };
  const drawSkyBuildings = (hy) => {
    const e = ENV[state.env]; let x = -10;
    while (x < W + 10) { const bw = rand(46, 100), bh = rand(H * 0.12, H * 0.30), top = hy - bh; sketchPoly([[x, hy], [x, top], [x + bw, top], [x + bw, hy]], { color: COL.ink, width: 1.4, fill: e.night ? "rgba(40,50,70,0.5)" : "rgba(120,125,135,0.35)" }); for (let wy = top + 12; wy < hy - 10; wy += 18) for (let wx = x + 8; wx < x + bw - 8; wx += 16) { ctx.fillStyle = e.night ? "rgba(255,225,150,0.6)" : "rgba(255,250,235,0.6)"; ctx.fillRect(wx, wy, 7, 9); } x += bw + rand(8, 20); }
  };

  // —— 主体 ——
  const drawTree = (x, y, s) => { sketchLine(x, y, x + rand(-4, 4), y - 90 * s, { color: COL.ink, width: 3, jit: 1.6, segs: 6 }); for (let k = 0; k < 3; k++) { const cy = y - (70 + k * 26) * s, r = (55 - k * 10) * s; ctx.strokeStyle = COL.ink; ctx.lineWidth = 1.6; ctx.beginPath(); for (let a = 0; a <= Math.PI * 2 + 0.3; a += 0.35) { const rr = r + rand(-5, 5); const px = x + Math.cos(a) * rr, py = cy + Math.sin(a) * rr * 0.9; a === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py); } ctx.stroke(); } };
  const drawLighthouse = (x, y, s) => { const topY = y - 150 * s, w = 26 * s; sketchPoly([[x - w, y], [x - w * 0.6, topY], [x + w * 0.6, topY], [x + w, y]], { color: COL.ink, width: 2, fill: "rgba(200,80,70,0.25)" }); sketchPoly([[x - w * 0.7, topY], [x - w * 0.9, topY - 28 * s], [x + w * 0.9, topY - 28 * s], [x + w * 0.7, topY]], { color: COL.ink, width: 1.6, fill: "rgba(240,200,80,0.6)" }); ctx.strokeStyle = "rgba(240,200,80,0.4)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, topY - 14 * s, 40 * s, -0.4, 0.4); ctx.stroke(); };
  const drawBoat = (x, y, s) => { const w = 70 * s, h = 24 * s; sketchPoly([[x - w, y], [x - w * 0.7, y + h], [x + w * 0.7, y + h], [x + w, y]], { color: COL.ink, width: 2, fill: "rgba(90,70,50,0.5)" }); sketchLine(x, y, x, y - 80 * s, { color: COL.ink, width: 2, segs: 5 }); sketchPoly([[x, y - 78 * s], [x, y - 10 * s], [x + 46 * s, y - 30 * s]], { color: COL.ink, width: 1.4, fill: "rgba(255,255,255,0.7)" }); };
  const drawHouse = (x, y, s) => { const w = 80 * s, h = 60 * s; sketchPoly([[x - w, y], [x - w, y - h], [x + w, y - h], [x + w, y]], { color: COL.ink, width: 2, fill: "rgba(190,150,110,0.35)" }); sketchPoly([[x - w - 10, y - h], [x, y - h - 44 * s], [x + w + 10, y - h]], { color: COL.ink, width: 2, fill: "rgba(150,80,60,0.4)" }); sketchPoly([[x - 12, y], [x - 12, y - 34 * s], [x + 12, y - 34 * s], [x + 12, y]], { color: COL.ink, width: 1.4 }); };
  const drawFigure = (x, y, s) => { const hh = 130 * s; ctx.strokeStyle = COL.ink; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.arc(x, y - hh, 14 * s, 0, Math.PI * 2); ctx.stroke(); sketchLine(x, y - hh + 14 * s, x, y - hh * 0.4, { color: COL.ink, width: 3, segs: 4 }); sketchLine(x, y - hh * 0.4, x - 16 * s, y, { color: COL.ink, width: 3, segs: 3 }); sketchLine(x, y - hh * 0.4, x + 16 * s, y, { color: COL.ink, width: 3, segs: 3 }); sketchLine(x, y - hh * 0.8, x - 22 * s, y - hh * 0.5, { color: COL.ink, width: 2, segs: 3 }); sketchLine(x, y - hh * 0.8, x + 22 * s, y - hh * 0.55, { color: COL.ink, width: 2, segs: 3 }); };
  const drawCactus = (x, y, s) => { sketchLine(x, y, x, y - 110 * s, { color: COL.ink, width: 8, jit: 1, segs: 8 }); sketchLine(x, y - 70 * s, x - 34 * s, y - 70 * s, { color: COL.ink, width: 6, jit: 1, segs: 5 }); sketchLine(x - 34 * s, y - 70 * s, x - 34 * s, y - 100 * s, { color: COL.ink, width: 6, jit: 1, segs: 5 }); sketchLine(x, y - 85 * s, x + 34 * s, y - 85 * s, { color: COL.ink, width: 6, jit: 1, segs: 5 }); sketchLine(x + 34 * s, y - 85 * s, x + 34 * s, y - 120 * s, { color: COL.ink, width: 6, jit: 1, segs: 5 }); };
  const SUBJ2D = { tree: drawTree, lighthouse: drawLighthouse, boat: drawBoat, house: drawHouse, figure: drawFigure, cactus: drawCactus };
  const draw3D = (type, x, baseY, s) => {
    const ox = 46 * s, oy = -32 * s;
    if (type === "cube") { const w = 90 * s, h = 110 * s, x0 = x - w / 2, x1 = x + w / 2, y0 = baseY - h, y1 = baseY; sketchPoly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], { color: COL.ink, width: 1.6, fill: "rgba(225,225,220,0.92)" }); sketchPoly([[x0, y0], [x0 + ox, y0 + oy], [x1 + ox, y0 + oy], [x1, y0]], { color: COL.ink, width: 1.6, fill: "rgba(245,245,240,0.96)" }); sketchPoly([[x1, y0], [x1 + ox, y0 + oy], [x1 + ox, y1 + oy], [x1, y1]], { color: COL.ink, width: 1.6, fill: "rgba(190,190,185,0.92)" }); }
    else if (type === "pyramid") { const w = 120 * s, h = 130 * s, x0 = x - w / 2, x1 = x + w / 2, ax = x, ay = baseY - h, ax2 = ax + ox, ay2 = ay + oy; sketchPoly([[x0, baseY], [x1, baseY], [ax, ay]], { color: COL.ink, width: 1.6, fill: "rgba(220,215,205,0.92)" }); sketchPoly([[x1, baseY], [x1 + ox, baseY + oy], [ax2, ay2], [ax, ay]], { color: COL.ink, width: 1.6, fill: "rgba(185,180,170,0.92)" }); sketchLine(ax, ay, ax2, ay2, { color: COL.ink, width: 1.6 }); }
    else if (type === "cylinder") { const w = 80 * s, h = 120 * s; sketchLine(x - w / 2, baseY, x - w / 2, baseY - h, { color: COL.ink, width: 1.6, segs: 6 }); sketchLine(x + w / 2, baseY, x + w / 2, baseY - h, { color: COL.ink, width: 1.6, segs: 6 }); ellipse(x, baseY, w, 18 * s); ellipse(x, baseY - h, w, 18 * s, "rgba(240,240,235,0.95)"); }
    else if (type === "sphere") { const r = 70 * s; ctx.save(); const g = ctx.createRadialGradient(x - r * 0.3, baseY - r * 0.3, r * 0.2, x, baseY - r, r); g.addColorStop(0, "#f2f0ea"); g.addColorStop(1, "#b9b4a8"); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, baseY - r, r, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = COL.ink; ctx.lineWidth = 1.6; ctx.stroke(); ctx.restore(); }
  };

  // —— 引导线 / 配重 ——
  const drawLeadingLine = (subj, color) => { const sx = subj.x, sy = subj.y; const startX = (R() < 0.5) ? rand(0, W * 0.25) : rand(W * 0.75, W); const startY = H - 4; const steps = 22; ctx.strokeStyle = color; ctx.lineWidth = 2.4; ctx.beginPath(); for (let i = 0; i <= steps; i++) { const t = i / steps; const x = startX + (sx - startX) * t + Math.sin(t * Math.PI * 2) * 40 * (1 - t); const y = startY + (sy - startY) * t; i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); } ctx.stroke(); };
  const drawCounterweight = (subj, scene, style) => { const fp = focalPoints(); let far = fp[0], dmax = -1; fp.forEach((p) => { const d = Math.hypot(p[0] - subj.x, p[1] - subj.y); if (d > dmax) { dmax = d; far = p; } }); const x = far[0] + rand(-30, 30), y = far[1] + rand(-20, 20); if (style === "3d") draw3D("cube", x, y, 0.5); else if (scene === "seascape") drawBoat(x, y, 0.5); else if (scene === "village") drawHouse(x, y, 0.5); else drawTree(x, y, 0.5 * 0.8 + 0.2); };

  // —— 渲染 ——
  const lastIdx = state.focal === "auto" ? Math.floor(R() * 4) : +state.focal;
  const lastScene = state.scene === "auto" ? pick(SCENES) : state.scene;
  const fp = focalPoints(); const [sx, sy] = fp[lastIdx];
  const hy = (sy < H / 2) ? Math.round(2 * H / 3) : Math.round(H / 3);

  ctx.fillStyle = COL.paper; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(0,0,0,0.012)"; for (let i = 0; i < 1400; i++) ctx.fillRect(rand(0, W), rand(0, H), 1.4, 1.4);

  if (state.subjStyle === "3d") {
    drawSky(state.env, hy); drawGround(hy, ENV[state.env].ground);
    const subj = { x: sx, y: sy + 50 }; draw3D(state.obj3d, sx, sy + 50, state.scale); drawCounterweight(subj, lastScene, "3d");
  } else {
    drawSky(state.env, hy); drawSceneBG(lastScene, hy);
    const subj = { x: sx, y: sy + (sy < H / 2 ? 60 : 40) };
    if (!["lake", "seascape"].includes(lastScene)) drawLeadingLine(subj, (lastScene === "lake" || lastScene === "seascape") ? "rgba(120,160,185,0.6)" : "rgba(150,135,108,0.6)");
    SUBJ2D[SCENE_SUBJ[lastScene]](sx, subj.y, state.scale);
    drawCounterweight(subj, lastScene, "2d");
  }

  drawGuides(ctx, W, H, state.guides, state.persp);

  return { canvas, meta: { format: state.format, focal: lastIdx, scene: lastScene, env: state.env, w: W, h: H } };
}

const DraftGen = { version: "1.0.0", SketchEngine, FOCAL_POINTS, makeRNG, STYLES, paintClassic, generateRandomScene, generateOne, listStyles, STYLE_KEYS, randomSeed, FORMATS, ENV, drawGuides, composeScene };
  return DraftGen;
});
