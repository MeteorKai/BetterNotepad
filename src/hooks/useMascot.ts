import { useCallback, useEffect, useState } from "react";

export interface MascotPos {
  x: number;
  y: number;
}

/** Kept here as well so the position maths below and Mascot.tsx agree. */
export const MASCOT_W = 150;
export const MASCOT_H = 190;

const VIS_KEY = "betternotepad.mascot.visible";
const POS_KEY = "betternotepad.mascot.pos";

/** Smallest gap we allow between the mascot and a window edge. */
const EDGE = 4;

function loadVisible(): boolean {
  try {
    const v = localStorage.getItem(VIS_KEY);
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Resolve a usable position for the current window.
 *
 * What is persisted is deliberately **not** an absolute pixel position. Absolute
 * coordinates only mean something at the window size they were captured at, so a
 * spot saved in a maximised window used to be replayed verbatim into a restored
 * one — the mascot was then drawn past the right edge, outside the viewport, with
 * no way to drag it back. Only re-maximising made it reappear.
 *
 * So we store the gaps to the window's bottom-right corner (`rx`/`ry`) and
 * rebuild the pixel position from the window we are actually in. Legacy
 * `{x, y}` values are converted once; both paths are clamped, so a stale value
 * can never come back off-screen. (Mascot.tsx already anchored itself to that
 * corner on resize — this makes mounting behave the same way.)
 */
function loadPos(): MascotPos | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);

    const w = window.innerWidth;
    const h = window.innerHeight;
    // Before the first layout the viewport can still report 0 — fall back to
    // the default corner instead of computing nonsense from it.
    if (w < 200 || h < 200) return null;

    let rx: number;
    let ry: number;
    if (typeof p.rx === "number" && typeof p.ry === "number") {
      rx = p.rx;
      ry = p.ry;
    } else if (typeof p.x === "number" && typeof p.y === "number") {
      rx = w - (p.x + MASCOT_W);
      ry = h - (p.y + MASCOT_H);
    } else {
      return null;
    }

    rx = clamp(rx, EDGE, Math.max(EDGE, w - MASCOT_W - EDGE));
    ry = clamp(ry, EDGE, Math.max(EDGE, h - MASCOT_H - EDGE));
    return { x: w - rx - MASCOT_W, y: h - ry - MASCOT_H };
  } catch {
    /* ignore */
  }
  return null;
}

function savePos(p: MascotPos): void {
  try {
    localStorage.setItem(
      POS_KEY,
      JSON.stringify({
        rx: window.innerWidth - (p.x + MASCOT_W),
        ry: window.innerHeight - (p.y + MASCOT_H),
      })
    );
  } catch {
    /* ignore */
  }
}

export function useMascot() {
  const [visible, setVisible] = useState(loadVisible);

  useEffect(() => {
    try {
      localStorage.setItem(VIS_KEY, visible ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [visible]);

  const toggle = useCallback(() => setVisible((v) => !v), []);

  return { visible, toggle, loadPos, savePos };
}
