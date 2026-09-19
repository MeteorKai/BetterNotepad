import { useCallback, useEffect, useState } from "react";

export interface MascotPos {
  x: number;
  y: number;
}

const VIS_KEY = "betternotepad.mascot.visible";
const POS_KEY = "betternotepad.mascot.pos";

function loadVisible(): boolean {
  try {
    const v = localStorage.getItem(VIS_KEY);
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
}

function loadPos(): MascotPos | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p.x === "number" && typeof p.y === "number") return p;
  } catch {
    /* ignore */
  }
  return null;
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

  const savePos = useCallback((p: MascotPos) => {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(p));
    } catch {
      /* ignore */
    }
  }, []);

  return { visible, toggle, loadPos, savePos };
}
