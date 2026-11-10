import { useEffect, type ReactNode } from 'react';
import { ApiError } from '../api/errors';
import { describeError, describeFieldError } from './error-text';

export function LoadingState({ label }: { readonly label: string }) {
  return (
    <p role="status" aria-live="polite" className="text-muted">
      {label}
    </p>
  );
}

export function ErrorState({ error, children }: { readonly error: unknown; readonly children?: ReactNode }) {
  const { title, text } = describeError(error);
  return (
    <div role="alert" className="rounded-card border border-danger-text bg-danger-bg p-4 text-danger-text">
      <p className="font-semibold">{title}</p>
      <p>{text}</p>
      {error instanceof ApiError && error.fields.length > 0 && <FieldErrorList fields={error.fields} />}
      {children}
    </div>
  );
}

/**
 * Every entry of `details.fields`, in the server's order (ui-guide.md §7.4). A page without a form for them shows them
 * here; a form binds the names it knows to its inputs and passes only the rest (`partitionFieldErrors`).
 */
export function FieldErrorList({ fields }: { readonly fields: ApiError['fields'] }) {
  return (
    <ul aria-label="Abgelehnte Angaben" className="mt-2 list-disc pl-6">
      {fields.map((entry, i) => {
        const { name, text } = describeFieldError(entry);
        return (
          <li key={i}>
            <code className="font-mono">{name}</code>: {text}
          </li>
        );
      })}
    </ul>
  );
}

export function Notice({ tone, children }: { readonly tone: 'info' | 'success' | 'warning'; readonly children: ReactNode }) {
  const tones = {
    info: 'border-info-text bg-info-bg text-info-text',
    success: 'border-success-text bg-success-bg text-success-text',
    warning: 'border-warning-text bg-warning-bg text-warning-text',
  };
  return <div className={`rounded-card border p-4 ${tones[tone]}`}>{children}</div>;
}

/** The browser tab names the page and, inside a Realm, the Realm (ui-guide.md §3.2: which context is shown). */
export function pageTitle(...parts: readonly string[]): string {
  return [...parts.filter((part) => part !== ''), 'Vermieter Cockpit'].join(' · ');
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

export function CenteredPage({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  useDocumentTitle(pageTitle(title === 'Vermieter Cockpit' ? '' : title));
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4 py-8">
      <h1 className="text-title font-semibold">{title}</h1>
      {children}
    </main>
  );
}

export const buttonClass = 'inline-flex min-h-touch items-center justify-center rounded-input bg-primary px-4 font-semibold text-surface disabled:opacity-60';
export const secondaryButtonClass = 'inline-flex min-h-touch items-center justify-center rounded-input border border-border bg-surface px-4 text-text';
