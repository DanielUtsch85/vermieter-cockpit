import { useCallback, useEffect, useRef, useState } from 'react';
import { waitAfter } from '../../rent/reconciliation-rules';

/**
 * One explicit command of step 6 at a time (ui-guide.md §6.6, §7.3, §11): sent only from a click, one request per
 * click (a second click while one runs does nothing), nothing turned green before the answer, a late answer after the
 * page was left ignored. After a refusal that asks to wait (`Retry-After`, a write running in MRE, `REMOVAL_TOO_EARLY`)
 * the actions stay locked for that time; nothing is ever sent again by itself, there is no retry loop.
 */
export type CommandStage<A extends string, T> =
  | { readonly kind: 'idle' }
  | { readonly kind: 'sending'; readonly action: A }
  | { readonly kind: 'refused'; readonly action: A; readonly error: unknown; readonly retry: (() => void) | undefined }
  | { readonly kind: 'done'; readonly action: A; readonly value: T };

export function useCommand<A extends string, T>(options: {
  /** After a refusal (e.g. read the detail again, ui-guide.md §6.6); not called when the page was left. */
  readonly onRefused?: (action: A, error: unknown) => void;
  readonly onDone: (action: A, value: T) => void;
}) {
  const [stage, setStage] = useState<CommandStage<A, T>>({ kind: 'idle' });
  const [waiting, setWaiting] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== undefined) clearTimeout(timer.current);
    };
  }, []);

  const run = useCallback((action: A, call: () => Promise<T>, retryable: (error: unknown) => boolean = () => false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setStage({ kind: 'sending', action });
    const send = () => run(action, call, retryable);
    call()
      .then(
        (value) => {
          if (!mounted.current) return;
          setStage({ kind: 'done', action, value });
          latest.current.onDone(action, value);
        },
        (error: unknown) => {
          if (!mounted.current) return;
          setStage({ kind: 'refused', action, error, retry: retryable(error) ? send : undefined });
          const seconds = waitAfter(error, Date.now());
          if (seconds > 0) {
            if (timer.current !== undefined) clearTimeout(timer.current);
            setWaiting(true);
            timer.current = setTimeout(() => {
              timer.current = undefined;
              if (mounted.current) setWaiting(false);
            }, seconds * 1000);
          }
          latest.current.onRefused?.(action, error);
        },
      )
      .finally(() => {
        inFlight.current = false;
      });
  }, []);

  return { stage, waiting, run, reset: () => setStage({ kind: 'idle' }) };
}
