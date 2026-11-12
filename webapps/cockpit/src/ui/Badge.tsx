import type { CodeLabel, Tone } from './transactions/labels';

/** The colours of a badge per tone; the text always says the state, the colour only repeats it (ui-guide.md §4.1). */
export const TONES: Readonly<Record<Tone, string>> = {
  warning: 'border-warning-text bg-warning-bg text-warning-text',
  success: 'border-success-text bg-success-bg text-success-text',
  neutral: 'border-border bg-background text-text',
  info: 'border-info-text bg-info-bg text-info-text',
};

/** A badge (ui-guide.md §4.3), the one of every area (Issue #353 des Projektinhabers, 2026-11-12, point 10). */
export function Badge({ label }: { readonly label: CodeLabel }) {
  return <span className={`inline-block whitespace-nowrap rounded-input border px-2 text-label ${TONES[label.tone]}`}>{label.text}</span>;
}
