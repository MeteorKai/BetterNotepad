import { useEffect, useRef } from "react";
import { t } from "../i18n";

interface VerticalResizeHandleProps {
  onDrag: (delta: number) => void;
}

// A thin horizontal drag strip between two stacked panels. The parent
// translates the pixel delta into a height change (positive = downward).
// Mirrors ResizeHandle, which does the same for side-by-side panels — kept
// separate so the horizontal one keeps its col-resize cursor semantics.
export default function VerticalResizeHandle({ onDrag }: VerticalResizeHandleProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onDragRef = useRef(onDrag);
  onDragRef.current = onDrag;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let startY = 0;
    let last = 0;
    const onMove = (e: MouseEvent) => {
      const dy = e.clientY - startY;
      onDragRef.current(dy - last);
      last = dy;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    const onDown = (e: MouseEvent) => {
      e.preventDefault();
      startY = e.clientY;
      last = 0;
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
    el.addEventListener("mousedown", onDown);
    return () => el.removeEventListener("mousedown", onDown);
  }, []);

  return (
    <div
      ref={ref}
      title={t("resize.heightTitle")}
      className="shrink-0 cursor-row-resize bg-transparent hover:bg-accent/25 transition-colors"
      style={{ height: 6 }}
    />
  );
}
