// Hero lines, variant E (locked). One 16 s loop on a 1280 x 800 stage:
// ribbon -> lanes and TrueRange bands -> score card (Harbor then Meridian) -> ribbon.
// Every state is a y(x) function per line; transitions are eased lerps of y.
import { clamp, eio, eout, lerp, mix, rng, smoothPath, ssm, sstep, svgEl, type Pt } from "../lib/motion";

export type HeroFund = {
  name: string;
  score: number;
  val: string;
  rep: string;
  res: string;
  lo: string;
  hi: string;
  lw: number;
  hw: number;
  v: number;
  r: number;
  col: string;
};

export const LOOP = 16;
const X0 = 111, X1 = 1089, CY = 368;
const GREEN = "#14a86a", RED = "#e5484d", SL = "#5b7287";
const N = 54, W = (2 * Math.PI) / LOOP;
const DV = 46, YH = 232, YM = 498, XL = 300, XB0 = 410, XE = 700, XF0 = 712, XF1 = 980, S0 = 84, SB = 44, BH = 52;
const TL = {
  unb: [1.2, 3.0], arc: [3.3, 3.9, 4.3, 4.9], tight: [4.9, 6.2], nu: [7.3, 8.9], ze: [7.7, 9.1], xf: [10.8, 11.6],
  zR: [12.7, 13.6], nuR: [12.8, 14.2], bR: [13.0, 13.8], muR: [13.3, 14.7], lblIn: [2.6, 3.2], lblOut: [7.2, 7.6],
  scIn: [5.9, 6.4], scOut: [7.1, 7.5], bandOut: [7.2, 7.8],
} as const;
type Span = readonly number[];
const up = (t: number, [a, b]: Span) => eio((t - a) / (b - a));
const dn = (t: number, [a, b]: Span) => 1 - eio((t - a) / (b - a));

const ramp = ["#c6d3de", "#a9bccb", "#86a0b5", "#4f88b3", "#0a7fc0", "#0aa0f0", "#64c5fd", "#9fdcff"];
const sigAt: Record<number, string> = { 13: GREEN, 41: RED };
function rampAt(u: number) {
  const f = u * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(f));
  return mix(ramp[i], ramp[i + 1], f - i);
}

type Line = {
  i: number; u: number; c: number; harbor: boolean; s: number; col: string; sig: boolean; sw: number; op: number; st: number;
  ph: number; wv: number; kk: number; rank: number; o: number; f: number; uC: number; aC: number;
  p?: SVGPathElement; stops?: SVGStopElement[];
};

function makeLines(): Line[] {
  const swap = new Set([25, 28]);
  const RC = rng(23);
  const L: Line[] = [];
  for (let i = 0; i < N; i++) {
    const u = i / (N - 1), c = u - 0.5, top = i < 27;
    const harbor = swap.has(i) ? !top : top;
    L.push({
      i, u, c, harbor, s: harbor ? -1 : 1, col: sigAt[i] || rampAt(Math.sin(u * Math.PI * 2.2 + 0.4) * 0.5 + 0.5), sig: !!sigAt[i],
      sw: [2, 3, 2, 4, 3, 2, 3][i % 7], op: sigAt[i] ? 1 : 0.5 + 0.35 * (1 - Math.abs(c) * 1.2), st: (i / (N - 1)) * 0.4,
      ph: RC() * 6.28, wv: RC() < 0.5 ? -1 : 1, kk: (2 * Math.PI) / (760 + RC() * 200), rank: 0, o: 0, f: 0, uC: 0, aC: 0,
    });
  }
  let a = 0, b = 0;
  L.forEach((l) => { l.rank = l.harbor ? a++ : b++; });
  L.forEach((l) => {
    l.o = (l.rank / 26 - 0.5) * 2;
    const f = l.harbor ? (26 - l.rank) / 26 : l.rank / 26;
    l.f = f;
    l.uC = 9 + Math.pow(f, 1.25) * 275;
    l.aC = 2 + f * 9;
  });
  return L;
}

function ribbon(l: Line, x: number, t: number) {
  const k1 = (2 * Math.PI) / 760, k2 = (2 * Math.PI) / 430;
  const a = 150 * (0.55 + 0.45 * Math.cos(l.c * 2.6 + k1 * x * 0.9 + W * t));
  return CY + a * Math.sin(k1 * x + l.c * 3.1 + W * t) + l.c * 210 * Math.cos(k2 * x - W * t * 2 + 0.8) * 0.8 + l.c * 190;
}
const CARD = { x0: 290, x1: 620, cy: CY, hh: 108 }, CLR = 20, RISE = 150, DFAR = 300;
const cbase = (l: Line, x: number, t: number) => CARD.cy + l.s * (l.uC + l.aC * Math.sin(l.kk * x + l.ph + W * t * l.wv));
function Hp(x: number) {
  const H = CARD.hh + CLR;
  let s;
  if (x < CARD.x0) s = ssm(CARD.x0 - RISE, CARD.x0, x);
  else if (x > CARD.x1) s = 1 - ssm(CARD.x1, CARD.x1 + RISE, x);
  else s = 1;
  return H * s;
}
const beta = (t: number) => up(t, TL.tight) * dn(t, TL.bR);
const mu = (l: Line, t: number) => up(t - l.st, TL.unb) * dn(t - l.st, TL.muR);
const nu = (l: Line, t: number) => up(t - l.st * 0.6, TL.nu) * dn(t - l.st * 0.6, TL.nuR);
const zeta = (t: number) => up(t, TL.ze) * dn(t, TL.zR);
function Y(l: Line, x: number, t: number, b: number, mm: number, nn: number, ze: number) {
  const R = ribbon(l, x, t);
  const w = mm * (1 - ssm(XF0, XF1, x));
  const S = S0 - (S0 - SB) * b * ssm(XB0, XB0 + 130, x);
  const SP = 130 + l.i * (500 / (N - 1)) + 9 * Math.sin(x / 90 + l.ph + W * t * l.wv) * (1 - ssm(X0, XL - 40, x));
  const Ls = lerp(SP, (l.harbor ? YH : YM) + l.o * S + l.s * DV * ssm(XE + 4, XE + 140, x), ssm(X0 + 10, XL, x));
  let y = lerp(R, Ls, w);
  if (nn > 0) y = lerp(y, cbase(l, x, t), nn);
  if (ze > 0) {
    const u = Math.max(l.s * (y - CARD.cy), 3);
    y = CARD.cy + l.s * (u + ze * Hp(x) * (1 - sstep(0, DFAR, u)));
  }
  return y;
}

const SWN = 7, SWS = 0.03, SWD = 0.22, SWIN = SWD + (SWN - 1) * SWS;

export type HeroScene = { draw: (t: number) => void };

// Builds the scene into the given SVG groups and card element. Returns a draw(t) for t in [0, LOOP).
export function buildHeroE(
  g: SVGGElement,
  ov: SVGGElement,
  defs: SVGDefsElement,
  cardEl: HTMLDivElement,
  FD: [HeroFund, HeroFund],
): HeroScene {
  const L = makeLines();
  const bandG = svgEl("g", {}, g);
  const bandH = svgEl("path", { fill: GREEN }, bandG);
  const bandM = svgEl("path", { fill: RED }, bandG);
  const edges = [GREEN, GREEN, RED, RED].map((c) => svgEl("path", { fill: "none", stroke: c, "stroke-width": 1.5 }, bandG));
  const order = [...L].sort((a, b) => Number(a.sig) - Number(b.sig));
  order.forEach((l) => {
    const lg = svgEl("linearGradient", { id: "hlg" + l.i, gradientUnits: "userSpaceOnUse", x1: X0, x2: X1, y1: 0, y2: 0 }, defs);
    l.stops = [0, 1, 2, 3].map(() => svgEl("stop", {}, lg));
    l.p = svgEl(
      "path",
      { fill: "none", stroke: `url(#hlg${l.i})`, "stroke-width": l.sw, "stroke-opacity": l.op, "stroke-linecap": "round", "stroke-linejoin": "round" },
      g,
    );
  });
  const cH = svgEl("path", { fill: "none", stroke: GREEN, "stroke-width": 3, "stroke-linecap": "butt", pathLength: 1000 }, g);
  const cM = svgEl("path", { fill: "none", stroke: RED, "stroke-width": 3, "stroke-linecap": "butt", pathLength: 1000 }, g);
  const arc = svgEl("path", { fill: "none", stroke: RED, "stroke-width": 3, "stroke-linecap": "round" }, g);
  const txt = (s: string, x: number, y: number, o: Record<string, string | number> = {}) => {
    const e = svgEl("text", Object.assign({ x, y, class: "hm", "font-size": 10.5, "letter-spacing": 0.6, fill: SL }, o), ov);
    e.textContent = s;
    return e;
  };
  const ring = svgEl("circle", { r: 4.5, fill: "#f5f5f5", stroke: RED, "stroke-width": 2 }, ov);
  const tHl = txt(FD[0].name.toUpperCase(), XL + 8, YH - S0 - 16);
  const tMl = txt(FD[1].name.toUpperCase(), XL + 8, YM - S0 - 16);
  const tCap = txt("1 loan : 1 lane", X0 + 16, 643 - 16);
  const tPl = txt("already pledged", 0, 0, { fill: RED, "font-weight": 500 });
  const big = { "font-size": 14, "font-weight": 600, "text-anchor": "end", "letter-spacing": 0.2 };
  const tH = txt(`${FD[0].name} ${FD[0].score}`, XE, YH - BH - 10, { ...big, fill: GREEN });
  const tM = txt(`${FD[1].name} ${FD[1].score}`, XE, YM - BH - 10, { ...big, fill: RED });
  const tVH = txt("TrueVal", 530, YH + BH + 30, { fill: GREEN }), tVM = txt("TrueVal", 530, YM + BH + 30, { fill: RED });
  const tRH = txt("TrueRange", 610, YH + BH + 30), tRM = txt("TrueRange", 610, YM + BH + 30);
  const ldrV = ([[YH, GREEN], [YM, RED]] as const).map(([y, c]) =>
    svgEl("path", { d: `M540 ${y + BH + 18}V${y}`, fill: "none", stroke: c, "stroke-width": 1.5 }, ov),
  );
  const ldrR = [YH, YM].map((y) => svgEl("path", { d: `M630 ${y + BH + 18}V${y + BH}`, fill: "none", stroke: SL, "stroke-width": 1.5 }, ov));
  const endT = ([[YH, GREEN], [YM, RED]] as const).map(([y, c]) =>
    svgEl("path", { d: `M${XE} ${y - BH}V${y + BH}`, fill: "none", stroke: c, "stroke-width": 2 }, ov),
  );
  const pick = L.find((l) => l.harbor && l.rank === 25)!;

  // Card: static structure, only values swap (sequenced, never overlapping).
  FD.forEach((f) => {
    const a = [f.lw, f.hw, f.v, f.r], mn = Math.min(...a), mx = Math.max(...a), p = (mx - mn) * 0.3;
    const n = (v: number) => (v - (mn - p)) / (mx - mn + 2 * p);
    Object.assign(f, { nl: n(f.lw), nh: n(f.hw), nv: n(f.v), nr: n(f.r) });
  });
  const sw = (k: number, fn: (f: HeroFund) => string | number, cls = "", st: (f: HeroFund) => string = () => "") =>
    `<span class="sw ${cls}" data-k="${k}"><span class="a" style="${st(FD[0])}">${fn(FD[0])}</span><span class="b" style="${st(FD[1])}">${fn(FD[1])}</span></span>`;
  const col = (f: HeroFund) => `color:${f.col}`;
  cardEl.innerHTML = `<div class="in"><div class="face"><div class="bar"></div>
<div class="hd lbl">${sw(0, (f) => f.name.toUpperCase(), "l")}<span class="dim r">FIXTURE · TESTNET</span></div>
<div class="body"><div class="c1"><div class="lbl dim">TRUENAV SCORE</div><div class="big">${sw(1, (f) => f.score, "l", col)}<small>/100</small></div></div>
<div class="c2"><div class="lbl dim">TRUEVAL</div><div class="mid mono">${sw(2, (f) => f.val, "l")}</div><div class="lbl dim">reported ${sw(3, (f) => f.rep, "l dim")}</div></div></div>
<div class="rng"><div class="lbl dim rh"><span>TRUERANGE</span>${sw(4, (f) => f.res, "ra res", col)}</div>
<div class="track"><div class="fill"></div><div class="tv"></div><div class="rp"></div></div>
<div class="lbl dim ends">${sw(5, (f) => f.lo, "l")}<span class="lg">&#9671; reported &nbsp;&#9615; TrueVal</span>${sw(6, (f) => f.hi, "ra")}</div></div></div></div>`;
  const swEls = [...cardEl.querySelectorAll<HTMLElement>(".sw")].map((e) => ({
    a: e.querySelector<HTMLElement>(".a")!,
    b: e.querySelector<HTMLElement>(".b")!,
  }));
  const cBar = cardEl.querySelector<HTMLElement>(".bar")!;
  const cFill = cardEl.querySelector<HTMLElement>(".fill")!;
  const cTv = cardEl.querySelector<HTMLElement>(".tv")!;
  const cRp = cardEl.querySelector<HTMLElement>(".rp")!;
  type Norm = HeroFund & { nl: number; nh: number; nv: number; nr: number };
  const H = FD[0] as Norm, M = FD[1] as Norm;

  function setCard(tt: number) {
    swEls.forEach((e, k) => {
      const o = eio((tt - k * SWS) / SWD), i = eio((tt - k * SWS - SWD - 0.02) / SWD);
      e.a.style.opacity = String(1 - o);
      e.a.style.transform = `translateY(${(-6 * o).toFixed(2)}px)`;
      e.b.style.opacity = String(i);
      e.b.style.transform = `translateY(${(6 * (1 - i)).toFixed(2)}px)`;
    });
    const m = eio((tt - 0.08) / (SWIN + SWD - 0.1)), c = mix(H.col, M.col, m);
    cBar.style.background = c;
    cFill.style.background = c;
    cTv.style.background = c;
    cFill.style.left = lerp(H.nl, M.nl, m) * 100 + "%";
    cFill.style.width = (lerp(H.nh, M.nh, m) - lerp(H.nl, M.nl, m)) * 100 + "%";
    cTv.style.left = lerp(H.nv, M.nv, m) * 100 + "%";
    cRp.style.left = lerp(H.nr, M.nr, m) * 100 + "%";
  }

  function draw(t: number) {
    const b = beta(t), ze = zeta(t);
    const sw_t = t - TL.xf[0], m = eio(clamp(sw_t / (SWIN + SWD)));
    const bandVis = 1 - ssm(TL.bandOut[0], TL.bandOut[1], t);
    L.forEach((l) => {
      const mm = mu(l, t), nn = nu(l, t);
      const pts: Pt[] = [];
      for (let x = X0 - 24; x <= X1 + 24; x += 8) pts.push([x, Y(l, x, t, b, mm, nn, ze)]);
      l.p!.setAttribute("d", smoothPath(pts));
      const lane = l.harbor ? GREEN : RED, mis = l.harbor ? m : 1 - m;
      const tau = b * (1 - ze * mis * 0.65);
      const tc = mix(l.col, lane, tau);
      const px = [[XB0, XB0 + 130, XE, XF1], [X0, X0 + 8, X1 - 8, X1]];
      const pp = px[0].map((v, k) => lerp(v, px[1][k], ze));
      [l.col, tc, tc, l.col].forEach((c, k) => {
        const s = l.stops![k];
        s.setAttribute("stop-color", c);
        s.setAttribute("offset", ((pp[k] - X0) / (X1 - X0)).toFixed(4));
      });
    });
    const bo = b * bandVis;
    ([[bandH, 0, YH], [bandM, 2, YM]] as const).forEach(([p, ei, yc]) => {
      const top: Pt[] = [], bot: Pt[] = [];
      for (let x = XB0 + 20; x <= XE; x += 6) {
        const h = BH * ssm(XB0 + 20, XB0 + 150, x);
        top.push([x, yc - h]);
        bot.push([x, yc + h]);
      }
      p.setAttribute("d", smoothPath(top) + "L" + bot[bot.length - 1].join(" ") + smoothPath(bot.slice().reverse()).replace("M", "L"));
      p.setAttribute("fill-opacity", String(0.14 * bo));
      edges[ei].setAttribute("d", smoothPath(top));
      edges[ei + 1].setAttribute("d", smoothPath(bot));
      edges[ei].setAttribute("stroke-opacity", String(0.5 * bo));
      edges[ei + 1].setAttribute("stroke-opacity", String(0.5 * bo));
    });
    ([[cH, YH], [cM, YM]] as const).forEach(([c, yc]) => {
      const pts: Pt[] = [];
      for (let x = XB0 + 20; x <= XE; x += 6) pts.push([x, yc]);
      c.setAttribute("d", smoothPath(pts));
      c.setAttribute("stroke-opacity", String(bo));
      c.setAttribute("stroke-dasharray", "1000 1000");
      c.setAttribute("stroke-dashoffset", String(1000 * (1 - eout((b - 0.15) / 0.8))));
    });
    // Duplicate pledge arc. It informs only.
    const XA = 330, y0 = pick.o * S0 + YH, yE = YM - S0 - 5;
    const A = TL.arc, pr = eout((t - A[0]) / (A[1] - A[0])) * (1 - eio((t - A[2]) / (A[3] - A[2])));
    const P0 = [XA, y0], P1 = [XA + 60, y0], P2 = [XA + 85, yE], P3 = [XA + 150, yE];
    const B = (u: number): Pt => {
      const a = 1 - u;
      return [
        a * a * a * P0[0] + 3 * a * a * u * P1[0] + 3 * a * u * u * P2[0] + u * u * u * P3[0],
        a * a * a * P0[1] + 3 * a * a * u * P1[1] + 3 * a * u * u * P2[1] + u * u * u * P3[1],
      ];
    };
    const tp: Pt[] = [];
    for (let k = 0; k <= 28; k++) tp.push(B((pr * k) / 28));
    arc.setAttribute("d", pr > 0.004 ? smoothPath(tp) : "M0 0");
    const fl = t > A[1] && t < A[2] ? 0.8 + 0.2 * Math.sin((t - A[1]) * 26) : 1;
    arc.setAttribute("stroke-opacity", String(pr > 0.004 ? fl : 0));
    const tip = B(pr);
    ring.setAttribute("cx", String(tip[0]));
    ring.setAttribute("cy", String(tip[1]));
    ring.setAttribute("opacity", String(pr > 0.03 ? fl : 0));
    tPl.setAttribute("x", String(tip[0] + 12));
    tPl.setAttribute("y", String(tip[1] - 14));
    tPl.setAttribute("opacity", String(ssm(A[1] - 0.2, A[1] + 0.1, t) * (1 - ssm(A[2], A[2] + 0.3, t))));
    const lo = ssm(TL.lblIn[0], TL.lblIn[1], t) * (1 - ssm(TL.lblOut[0], TL.lblOut[1], t));
    [tHl, tMl, tCap].forEach((e) => e.setAttribute("opacity", String(lo)));
    const so = ssm(TL.scIn[0], TL.scIn[1], t) * (1 - ssm(TL.scOut[0], TL.scOut[1], t));
    [tH, tM, tVH, tVM, tRH, tRM, ...ldrV, ...ldrR, ...endT].forEach((e) => e.setAttribute("opacity", String(so)));
    if (ze < 0.002) cardEl.style.display = "none";
    else {
      const h = CARD.hh * ze;
      cardEl.style.cssText = `display:block;left:${CARD.x0}px;top:${CARD.cy - h}px;width:${CARD.x1 - CARD.x0}px;height:${2 * h}px;opacity:${ssm(0.12, 0.5, ze)}`;
      setCard(sw_t);
    }
  }
  return { draw };
}
