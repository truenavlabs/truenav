// Where the tour's popover goes: beside the target on the first side with room, never over the target, always inside
// the screen. When no side has room it says "over" so the caller can show the card without an arrow.

export type Box = { left: number; top: number; width: number; height: number };
export type Placed = { side: "bottom" | "top" | "right" | "left" | "over"; left: number; top: number; arrow: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

export function placePopover(t: Box, pop: { w: number; h: number }, view: { w: number; h: number }, o: { margin?: number; gap?: number } = {}): Placed {
  const m = o.margin ?? 8;
  const gap = o.gap ?? 14;
  const cx = t.left + t.width / 2;
  const cy = t.top + t.height / 2;
  const fitsX = (l: number) => l >= m && l + pop.w <= view.w - m;
  const fitsY = (tp: number) => tp >= m && tp + pop.h <= view.h - m;
  const arrowX = (l: number) => clamp(cx - l, 14, pop.w - 14);
  const arrowY = (tp: number) => clamp(cy - tp, 14, pop.h - 14);
  for (const side of ["bottom", "top", "right", "left"] as const) {
    if (side === "bottom" || side === "top") {
      const top = side === "bottom" ? t.top + t.height + gap : t.top - gap - pop.h;
      if (!fitsY(top)) continue;
      const left = clamp(cx - pop.w / 2, m, view.w - m - pop.w);
      if (!fitsX(left)) continue;
      return { side, left, top, arrow: arrowX(left) };
    }
    const left = side === "right" ? t.left + t.width + gap : t.left - gap - pop.w;
    if (!fitsX(left)) continue;
    const top = clamp(cy - pop.h / 2, m, view.h - m - pop.h);
    if (!fitsY(top)) continue;
    return { side, left, top, arrow: arrowY(top) };
  }
  return { side: "over", left: clamp((view.w - pop.w) / 2, m, view.w - m - pop.w), top: Math.max(m, view.h - m - pop.h), arrow: 0 };
}
