import { useState, useCallback } from "react";

export function useEditorState(_initialContent: string) {
  const [cursorLine, setCursorLine] = useState(1);
  const [cursorCol, setCursorCol] = useState(1);
  const [totalLines, setTotalLines] = useState(1);

  const updateCursor = useCallback((line: number, col: number, total: number) => {
    setCursorLine(line);
    setCursorCol(col);
    setTotalLines(total);
  }, []);

  return {
    cursorLine,
    cursorCol,
    totalLines,
    updateCursor,
  };
}
