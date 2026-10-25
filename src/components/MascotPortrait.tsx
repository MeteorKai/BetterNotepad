import { MASCOT_PALETTES, type MascotVariant } from "../mascot/variants";

/** Static picker preview, also used when WebGL is unavailable. */
export default function MascotPortrait({ variant, className }: { variant: MascotVariant; className?: string }) {
  const colors = MASCOT_PALETTES[variant];
  return (
    <svg className={className} viewBox="0 0 150 190" aria-hidden="true">
      <ellipse cx="75" cy="165" rx="40" ry="6" fill="#493b50" opacity=".08" />
      {variant === "cat" && <path d="M104 146q30-1 23-22" fill="none" stroke={colors.body} strokeWidth="10" strokeLinecap="round" />}
      {variant === "fox" && <><path d="M101 148q30 0 21-30" fill="none" stroke={colors.body} strokeWidth="20" strokeLinecap="round" /><ellipse cx="122" cy="120" rx="10" ry="13" fill={colors.belly} /></>}
      {variant === "rabbit" && <circle cx="104" cy="147" r="12" fill={colors.belly} />}
      <ellipse cx="75" cy="137" rx="27" ry="29" fill={colors.body} />
      <ellipse cx="75" cy="142" rx="16" ry="20" fill={colors.belly} />
      {variant === "bear" ? (
        <><g fill={colors.body}><circle cx="45" cy="65" r="15" /><circle cx="105" cy="65" r="15" /></g><g fill={colors.pink}><circle cx="45" cy="65" r="8" /><circle cx="105" cy="65" r="8" /></g></>
      ) : variant === "rabbit" ? (
        <><g fill={colors.body}><ellipse cx="54" cy="51" rx="11" ry="29" transform="rotate(-10 54 51)" /><ellipse cx="96" cy="51" rx="11" ry="29" transform="rotate(10 96 51)" /></g><g fill={colors.pink}><ellipse cx="54" cy="49" rx="5" ry="20" transform="rotate(-10 54 49)" /><ellipse cx="96" cy="49" rx="5" ry="20" transform="rotate(10 96 49)" /></g></>
      ) : (
        <><path d="M37 81Q30 22 58 61M92 61Q120 22 113 81" fill={colors.body} stroke={colors.body} strokeWidth="8" strokeLinejoin="round" /><path d="M40 66l-1-21 14 17M97 62l14-17-1 21" fill={colors.pink} /></>
      )}
      <ellipse cx="75" cy="92" rx="43" ry="36" fill={colors.body} />
      {variant === "bear" && <ellipse cx="75" cy="104" rx="16" ry="11" fill={colors.belly} />}
      {variant === "fox" && <path d="M34 93q18 6 41 9 23-3 41-9-5 35-41 35T34 93" fill={colors.belly} />}
      <path d="M54 124q21 8 42 0M87 127l3 20" fill="none" stroke={colors.accent} strokeWidth="9" strokeLinecap="round" />
      <g fill={colors.body}><ellipse cx="48" cy="141" rx="8" ry="14" transform="rotate(15 48 141)" /><ellipse cx="102" cy="141" rx="8" ry="14" transform="rotate(-15 102 141)" /><ellipse cx="62" cy="163" rx="12" ry="6" /><ellipse cx="88" cy="163" rx="12" ry="6" /></g>
      <g fill="#493b50"><ellipse cx="61" cy="92" rx="4" ry="6" /><ellipse cx="89" cy="92" rx="4" ry="6" /></g>
      <g fill="#fffdf8"><circle cx="60" cy="90" r="1.5" /><circle cx="88" cy="90" r="1.5" /></g>
      <g fill={colors.pink}><ellipse cx="49" cy="102" rx="6" ry="3" /><ellipse cx="101" cy="102" rx="6" ry="3" /><ellipse cx="75" cy="100" rx="2" ry="1.5" /></g>
      <path d="M69 105q3 4 6 0 3 4 6 0" fill="none" stroke="#493b50" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
