import { useEffect, useRef } from "react";
import { t } from "../i18n";

interface ResizeHandleProps {
  onDrag: (delta: number) => void;
}

// A thin vertical drag strip between two panels. The parent translates the
// pixel delta into a width change.
export default function ResizeHandle({ onDrag }: ResizeHandleProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onDragRef = useRef(onDrag);
  onDragRef.current = onDrag;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let startX = 0;
    let last = 0;
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - startX;
      onDragRef.current(dx - last);
      last = dx;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    const onDown = (e: MouseEvent) => {
      e.preventDefault();
      startX = e.clientX;
      last = 0;
      document.body.style.cursor = "col-resize";
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
      title={t("resize.title")}
      className="shrink-0 cursor-col-resize bg-transparent hover:bg-accent/25 transition-colors"
      style={{ width: 6 }}
    />
  );
}
