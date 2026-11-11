import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { buttonClass, secondaryButtonClass } from './states';

/**
 * The confirmation step before a command that cannot be taken back (ui-guide.md §4.4, §11), after the pattern of
 * „Buchung bestätigen“: a `role="dialog"` in place of the button that opened it, the focus on its heading, a text that
 * says what will happen, and two buttons. Only the confirm button sends; „Abbrechen“ and Escape send nothing and give
 * the focus back to the button that opened the step (`useConfirmStep`). Rendering it sends nothing.
 */
export function ConfirmStep(props: {
  /** The id of the heading; the text below it is `${id}-text`. Unique on the page. */
  readonly id: string;
  readonly title: string;
  readonly children: ReactNode;
  readonly confirmLabel: string;
  readonly sendingLabel: string;
  readonly sending: boolean;
  /** The command cannot be sent now (a stale state, a wait the server asked for); „Abbrechen“ stays possible. */
  readonly disabled: boolean;
  /** Ids of further texts that explain why the confirm button is disabled. */
  readonly describedBy?: string | undefined;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || props.sending) return;
    event.stopPropagation();
    props.onCancel();
  };
  return (
    <div
      role="dialog"
      aria-labelledby={props.id}
      aria-describedby={`${props.id}-text`}
      className="rounded-card border border-border bg-surface p-4"
      onKeyDown={onKeyDown}
    >
      <h4 id={props.id} ref={heading} tabIndex={-1} className="font-semibold">
        {props.title}
      </h4>
      <div id={`${props.id}-text`}>{props.children}</div>
      <div className="mt-3 flex flex-wrap gap-4">
        <button type="button" className={buttonClass} disabled={props.sending || props.disabled} aria-describedby={props.describedBy} onClick={props.onConfirm}>
          {props.sending ? props.sendingLabel : props.confirmLabel}
        </button>
        <button type="button" className={secondaryButtonClass} disabled={props.sending} onClick={props.onCancel}>
          Abbrechen
        </button>
      </div>
    </div>
  );
}

/**
 * Which confirmation step is open, and the focus back to its button on „Abbrechen“ or Escape. The state lives in the
 * component only: a remount, a refetch or a change of page closes every step without sending anything.
 */
export function useConfirmStep<K extends string>() {
  const [asking, setAsking] = useState<K | undefined>(undefined);
  const triggers = useRef(new Map<K, HTMLButtonElement>());
  const back = useRef<K | undefined>(undefined);
  useEffect(() => {
    if (asking !== undefined || back.current === undefined) return;
    triggers.current.get(back.current)?.focus();
    back.current = undefined;
  }, [asking]);
  return {
    asking,
    ask: (key: K) => setAsking(key),
    cancel: () => {
      back.current = asking;
      setAsking(undefined);
    },
    /** Closes the step after the server's answer: the focus goes to the answer, not back to the button. */
    close: () => setAsking(undefined),
    /** The ref of the button that opens the step for `key`. */
    trigger: (key: K) => (element: HTMLButtonElement | null) => {
      if (element === null) triggers.current.delete(key);
      else triggers.current.set(key, element);
    },
  };
}
