import { useEffect, useRef } from "react";
import { t } from "../i18n";

interface ConfirmCloseDialogProps {
  fileName: string;
  unsaved: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

export default function ConfirmCloseDialog({
  fileName,
  unsaved,
  onSave,
  onDiscard,
  onCancel,
}: ConfirmCloseDialogProps) {
  const saveRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    saveRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[2px]"
      onMouseDown={onCancel}
    >
      <div
        className="relative overflow-hidden bg-elevated border border-line rounded-2xl shadow-2xl w-[440px] p-6"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="pointer-events-none absolute inset-0 pattern-dots" />
        <div className="glow-orb w-52 h-28 -top-16 -left-16" />
        <div className="relative flex items-center gap-2 mb-3">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-warn shrink-0">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <h2 className="text-base font-semibold text-ink">{t("confirm.saveChangesTitle")}</h2>
        </div>
        <p className="relative text-sm text-sub mb-6 leading-relaxed">
          {unsaved
            ? t("confirm.unsavedNew", { name: fileName })
            : t("confirm.unsavedModified", { name: fileName })}
        </p>
        <div className="relative flex justify-end gap-2">
          <button
            onClick={onDiscard}
            className="px-3 py-1.5 rounded-md text-sm text-ink bg-hover hover:bg-active transition-colors"
          >
            {t("confirm.discard")}
          </button>
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md text-sm text-sub hover:text-ink hover:bg-hover transition-colors"
          >
            {t("confirm.cancel")}
          </button>
          <button
            ref={saveRef}
            onClick={onSave}
            className="px-3 py-1.5 rounded-md text-sm font-medium text-accent-ink bg-accent hover:bg-accent-strong transition-colors"
          >
            {t("confirm.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
