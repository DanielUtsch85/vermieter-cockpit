import { useEffect, useRef, useState, type FormEvent } from 'react';
import { SignInError } from '../session/mre-authenticator';
import { useSession } from '../session/use-session';
import { buttonClass, CenteredPage, Notice } from './states';

const SIGN_IN_TEXTS: Record<SignInError['reason'], string> = {
  INVALID_CREDENTIALS: 'E-Mail-Adresse oder Passwort ist falsch.',
  MISSING_FIELDS: 'Bitte E-Mail-Adresse und Passwort eingeben.',
  UNAVAILABLE: 'Die Anmeldung von MicroRealEstate ist nicht erreichbar. Bitte später erneut versuchen.',
};

/**
 * Sign-in through the MRE authenticator (mre-integration.md §47.2 point 1): the same account as in MicroRealEstate, no
 * DE login and no DE password store. The password is sent once and not kept.
 */
export function LoginPage({ expired }: { readonly expired: boolean }) {
  const session = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const failureRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (failure !== undefined) failureRef.current?.focus();
  }, [failure]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setFailure(undefined);
    session.signIn(email.trim(), password).then(
      () => setPassword(''),
      (error: unknown) => {
        setBusy(false);
        setFailure(error instanceof SignInError ? SIGN_IN_TEXTS[error.reason] : SIGN_IN_TEXTS.UNAVAILABLE);
      },
    );
  };

  return (
    <CenteredPage title="Anmelden">
      <p className="text-muted">Mit dem Konto von MicroRealEstate. Das Cockpit hat keine eigene Anmeldung.</p>
      {expired && (
        <Notice tone="info">
          <p>Ihre Sitzung ist abgelaufen. Bitte melden Sie sich erneut an.</p>
        </Notice>
      )}
      {failure !== undefined && (
        <div ref={failureRef} tabIndex={-1} role="alert" className="rounded-card border border-danger-text bg-danger-bg p-4 text-danger-text">
          {failure}
        </div>
      )}
      <form onSubmit={submit} className="flex flex-col gap-4 rounded-card border border-border bg-surface p-6">
        <label className="flex flex-col gap-1">
          <span className="text-label text-muted">E-Mail-Adresse</span>
          <input
            type="email"
            name="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="min-h-touch rounded-input border border-border px-3 text-form"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-label text-muted">Passwort</span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="min-h-touch rounded-input border border-border px-3 text-form"
          />
        </label>
        <button type="submit" disabled={busy} className={buttonClass}>
          {busy ? 'Anmeldung läuft …' : 'Anmelden'}
        </button>
      </form>
    </CenteredPage>
  );
}
