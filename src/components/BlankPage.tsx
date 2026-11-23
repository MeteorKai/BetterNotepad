import { t } from "../i18n";

export default function BlankPage({ onWrite, onOpen }: { onWrite: () => void; onOpen: () => void }) {
  return (
    <div className="blank-page">
      <div className="blank-layout">
        <div className="blank-copy">
          <p className="blank-eyebrow">{t("workspace.blank")}</p>
          <h1>{t("workspace.heading")}</h1>
          <p className="blank-description">{t("workspace.description")}</p>
          <div className="blank-actions">
            <button type="button" className="blank-primary" onClick={onWrite}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m13 6 5 5M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15z" />
              </svg>
              {t("workspace.write")}
            </button>
            <button type="button" className="blank-secondary" onClick={onOpen}>
              {t("workspace.openFile")}
              <kbd aria-hidden="true">Ctrl O</kbd>
            </button>
          </div>
        </div>
        <svg className="blank-art" viewBox="0 0 296 282" fill="none" aria-hidden="true">
          <path d="M24 54V36h18m211 0h18v18m0 174v18h-18m-211 0H24v-18" stroke="var(--art-grid)" />
          <path d="M24 141h247M148 36v210" stroke="var(--art-grid)" strokeDasharray="2 6" />
          <circle cx="148" cy="141" r="88" stroke="var(--art-grid)" />
          <circle cx="148" cy="141" r="104" stroke="var(--art-grid)" />
          <g transform="rotate(-12 140 138)">
            <rect x="79" y="59" width="123" height="165" rx="4" fill="var(--panel)" stroke="var(--art-rule)" />
            <path d="M93 61v161" stroke="var(--art-rule)" />
          </g>
          <g className="blank-sheet" transform="rotate(9 162 145)">
            <rect x="97" y="54" width="131" height="180" rx="5" fill="var(--elevated)" stroke="var(--art-rule)" />
            <path d="M116 115h92m-92 17h92m-92 17h92m-92 17h92m-92 17h92m-92 17h92" stroke="var(--art-rule)" />
            <path d="M116 88h23m-23 9h42m-42 18h53m-53 17h36m-36 17h61" stroke="var(--art-ink)" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M173 143v12" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M191 54h18v45l-9-6-9 6z" fill="var(--accent)" />
            <path d="M197 67h6m-6 4h6m-6 4h4" stroke="var(--accent-ink)" strokeLinecap="round" />
            <path d="M116 216h13" stroke="var(--art-ink)" strokeLinecap="round" />
            <circle cx="205" cy="216" r="3" stroke="var(--art-ink)" />
          </g>
          <path d="M42 93v12m-6-6h12m196 93v12m-6-6h12" stroke="var(--accent)" strokeLinecap="round" />
          <circle cx="250" cy="71" r="2.5" fill="var(--accent)" />
          <circle cx="51" cy="204" r="2" fill="var(--art-ink)" />
        </svg>
      </div>
    </div>
  );
}
