/**
 * Copy text to the system clipboard.
 *
 * Prefers the async Clipboard API, but falls back to a hidden textarea +
 * `execCommand("copy")` for webviews where `navigator.clipboard` is missing or
 * rejected (older WebView2 builds, or a page the runtime does not treat as a
 * secure context). The fallback also has to restore the user's current
 * selection, otherwise copying from a menu would silently drop it.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);

    const selection = document.getSelection();
    const savedRange =
      selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);

    if (savedRange && selection) {
      selection.removeAllRanges();
      selection.addRange(savedRange);
    }
    return ok;
  } catch {
    return false;
  }
}
