import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// Colors reference the --tok-* custom properties, so the three [data-theme]
// blocks in styles.css keep driving syntax colors with no CodeMirror-specific
// overrides. The tag groups mirror the Prism selectors they replace.
const highlightStyle = HighlightStyle.define([
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: "var(--tok-comment)",
    fontStyle: "italic",
  },
  {
    tag: [t.punctuation, t.bracket, t.separator, t.paren, t.brace, t.squareBracket, t.angleBracket],
    color: "var(--tok-punctuation)",
  },
  {
    tag: [t.propertyName, t.tagName, t.constant(t.variableName), t.atom, t.deleted],
    color: "var(--tok-property)",
  },
  { tag: [t.bool, t.number, t.null, t.unit], color: "var(--tok-boolean)" },
  {
    tag: [
      t.string,
      t.character,
      t.docString,
      t.special(t.string),
      t.escape,
      t.attributeName,
      t.standard(t.variableName),
      t.inserted,
    ],
    color: "var(--tok-selector)",
  },
  {
    tag: [
      t.operator,
      t.url,
      t.link,
      t.derefOperator,
      t.compareOperator,
      t.logicOperator,
      t.arithmeticOperator,
      t.bitwiseOperator,
      t.definitionOperator,
      t.updateOperator,
      t.typeOperator,
      t.controlOperator,
    ],
    color: "var(--tok-operator)",
  },
  {
    tag: [
      t.keyword,
      t.controlKeyword,
      t.moduleKeyword,
      t.definitionKeyword,
      t.operatorKeyword,
      t.self,
      t.modifier,
      t.attributeValue,
      t.special(t.variableName),
    ],
    color: "var(--tok-keyword)",
  },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName, t.macroName],
    color: "var(--tok-function)",
  },
  {
    tag: [t.className, t.typeName, t.namespace, t.definition(t.className), t.definition(t.typeName)],
    color: "var(--tok-class)",
  },
  { tag: [t.regexp], color: "var(--tok-regex)" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
]);

export const cmHighlighting = syntaxHighlighting(highlightStyle);
