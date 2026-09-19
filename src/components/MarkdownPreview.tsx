import { useMemo } from "react";
import { marked, type RendererObject } from "marked";
import DOMPurify from "dompurify";
import Prism from "prismjs";

// marked reports common short aliases (js, ts, py…) but Prism registers the
// full names (javascript, typescript, python…), so map them before highlighting.
const PRISM_ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  py: "python",
  sh: "bash",
  yml: "yaml",
  md: "markdown",
  rb: "ruby",
  rs: "rust",
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Tokenize with Prism.tokenize + a custom renderer (Prism.highlight itself
// throws in this environment, and the Editor already relies on this approach).
function renderToken(token: Prism.Token): string {
  const types = Array.isArray(token.type) ? token.type : [token.type];
  const cls = types.map((t) => `token ${t}`).join(" ");
  return `<span class="${cls}">${renderContent(token.content)}</span>`;
}

function renderContent(content: Prism.TokenStream): string {
  if (typeof content === "string") return escapeHtml(content);
  if (Array.isArray(content)) {
    return content
      .map((t) => (typeof t === "string" ? escapeHtml(t) : renderToken(t)))
      .join("");
  }
  return renderToken(content);
}

function highlightCode(text: string, language: string): string {
  const grammar = Prism.languages[language];
  if (!grammar) return escapeHtml(text);
  try {
    return Prism.tokenize(text, grammar)
      .map((t) => (typeof t === "string" ? escapeHtml(t) : renderToken(t)))
      .join("");
  } catch {
    return escapeHtml(text);
  }
}

const mdRenderer: RendererObject = {
  code({ text, lang }) {
    const resolved = lang ? PRISM_ALIASES[lang] ?? lang : "";
    const language = resolved && Prism.languages[resolved] ? resolved : "markup";
    return `<pre class="language-${language}"><code class="language-${language}">${highlightCode(
      text,
      language
    )}</code></pre>`;
  },
};

marked.use({ renderer: mdRenderer });

export default function MarkdownPreview({ content }: { content: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(content, { async: false });
    return DOMPurify.sanitize(typeof raw === "string" ? raw : String(raw));
  }, [content]);

  // The app shell sets `user-select: none`; rendered markdown opts back in so
  // its text can be selected and copied like any other document content.
  return (
    <div className="h-full overflow-y-auto bg-editor select-text cursor-text">
      <div className="markdown-body p-5" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
