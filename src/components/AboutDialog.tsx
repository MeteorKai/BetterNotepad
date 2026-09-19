import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { t } from "../i18n";

const HOMEPAGE = "https://github.com/MeteorKai/BetterNotepad";

function featureList(): string[] {
  return [
    t("about.feature1"),
    t("about.feature2"),
    t("about.feature3"),
    t("about.feature4"),
    t("about.feature5"),
  ];
}

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export default function AboutDialog({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [version, setVersion] = useState("");

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  useEffect(() => {
    if (!isTauri()) return;
    getVersion().then(setVersion).catch(() => {});
  }, []);

  const openHomepage = () => {
    if (isTauri()) {
      openUrl(HOMEPAGE).catch(() => {});
    } else {
      window.open(HOMEPAGE, "_blank", "noreferrer");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        className="relative overflow-hidden bg-elevated border border-line rounded-2xl shadow-2xl w-[400px] flex flex-col"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="pointer-events-none absolute inset-0 pattern-dots" />
        <div className="glow-orb w-56 h-32 -top-20 -left-20" />

        <div className="relative flex flex-col items-center px-7 pt-7 pb-5">
          <div className="w-12 h-12 rounded-xl bg-accent-soft text-accent flex items-center justify-center">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="8" y1="13" x2="16" y2="13" />
              <line x1="8" y1="17" x2="13" y2="17" />
            </svg>
          </div>
          <h2 className="mt-3 text-lg font-semibold tracking-tight text-ink">BetterNotepad</h2>
          {version && (
            <span className="mt-0.5 text-xs text-faint">
              {t("about.version")} {version}
            </span>
          )}
          <p className="mt-3 text-sm text-sub text-center leading-relaxed">
            {t("about.tagline")}
            <br />
            {t("about.tagline2")}
          </p>

          <ul className="mt-4 w-full space-y-1.5">
            {featureList().map((f) => (
              <li key={f} className="flex items-start gap-2 text-[13px] text-sub">
                <span className="mt-[7px] w-1 h-1 rounded-full bg-accent shrink-0" />
                {f}
              </li>
            ))}
          </ul>

          <p className="mt-5 text-[11px] text-faint text-center leading-relaxed">
            Tauri 2 · React 19 · TypeScript · CodeMirror 6 · Tailwind CSS v4 · Three.js
          </p>
          <button
            onClick={openHomepage}
            title={t("about.homepage")}
            className="mt-2 text-xs text-accent hover:underline underline-offset-2 transition-colors"
          >
            github.com/MeteorKai/BetterNotepad
          </button>
        </div>

        <div className="relative flex items-center justify-between px-7 pb-5 pt-3 border-t border-line-soft">
          <span className="text-xs text-faint">© 2026 Meteor_Kai</span>
          <button
            ref={closeRef}
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-sm font-medium text-accent-ink bg-accent hover:bg-accent-strong transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
          >
            {t("about.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
