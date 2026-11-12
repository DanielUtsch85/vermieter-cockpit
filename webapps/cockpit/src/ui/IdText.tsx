/**
 * An id, a key or a code as the API sends it, in the cockpit's one style for technical text (Issue #353 des
 * Projektinhabers, 2026-11-12, point 10). With `name` it is the reference shown by its name (Issue #352, point 3): the
 * resolved name with the id as a tooltip (`title`); a name that is not available keeps the id visible after `missing`,
 * because the id is then the only way to tell the reference apart.
 */
export function IdText(props: { readonly id: string } | { readonly id: string; readonly name: string | undefined; readonly missing?: string }) {
  const code = <code className="font-mono text-label">{props.id}</code>;
  if (!('name' in props)) return code;
  if (props.name !== undefined) return <span title={props.id}>{props.name}</span>;
  return (
    <>
      <span className="text-muted">{props.missing ?? 'Name nicht verfügbar'}</span> {code}
    </>
  );
}
