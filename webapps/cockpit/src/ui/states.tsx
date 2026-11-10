import type { ReactNode } from 'react';
import { describeError } from './error-text';

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
      {children}
    </div>
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

export function CenteredPage({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4 py-8">
      <h1 className="text-title font-semibold">{title}</h1>
      {children}
    </main>
  );
}

export const buttonClass = 'inline-flex min-h-touch items-center justify-center rounded-input bg-primary px-4 font-semibold text-surface disabled:opacity-60';
export const secondaryButtonClass = 'inline-flex min-h-touch items-center justify-center rounded-input border border-border bg-surface px-4 text-text';
