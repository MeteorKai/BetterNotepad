import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark" | "warm";

const STORAGE_KEY = "betternotepad.theme";
const ORDER: Theme[] = ["light", "dark", "warm"];

function isTheme(v: string | null): v is Theme {
  return v === "light" || v === "dark" || v === "warm";
}

function getInitial(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isTheme(stored)) return stored;
  } catch {
    /* localStorage unavailable */
  }
  return "warm";
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(getInitial);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const cycle = useCallback(() => {
    setTheme((t) => ORDER[(ORDER.indexOf(t) + 1) % ORDER.length]);
  }, []);

  return { theme, setTheme, cycle };
}
