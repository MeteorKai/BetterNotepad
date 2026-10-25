export const MASCOT_VARIANTS = ["cat", "rabbit", "bear", "fox"] as const;
export type MascotVariant = typeof MASCOT_VARIANTS[number];

export function isMascotVariant(value: unknown): value is MascotVariant {
  return MASCOT_VARIANTS.some((variant) => variant === value);
}

export const MASCOT_PALETTES = {
  cat: { body: "#ffedda", pink: "#efb4b9", accent: "#b7a4dc", belly: "#fffaf2" },
  rabbit: { body: "#f9e7ed", pink: "#e5acc2", accent: "#9eafd9", belly: "#fff8f7" },
  bear: { body: "#dfb99c", pink: "#c79480", accent: "#95b9af", belly: "#fff0d8" },
  fox: { body: "#efbd8d", pink: "#d5908b", accent: "#86b6ab", belly: "#fff1dc" },
} satisfies Record<MascotVariant, { body: string; pink: string; accent: string; belly: string }>;
