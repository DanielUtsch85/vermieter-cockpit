const STEPS = ['Datei & Konto', 'Import ausführen', 'Ergebnis & Klärfälle'] as const;

/** The three steps of ui-guide.md §6.5; the current one is marked for assistive technology too. */
export function ImportSteps({ current }: { readonly current: 1 | 2 | 3 }) {
  return (
    <ol aria-label="Ablauf des Imports" className="flex flex-wrap gap-2 text-label">
      {STEPS.map((label, i) => (
        <li
          key={label}
          aria-current={i + 1 === current ? 'step' : undefined}
          className={`rounded-input border px-3 py-1 ${i + 1 === current ? 'border-primary bg-info-bg font-semibold text-primary' : 'border-border text-muted'}`}
        >
          {`${i + 1} ${label}`}
        </li>
      ))}
    </ol>
  );
}
