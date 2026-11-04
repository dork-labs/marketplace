/** Shared display metadata; the saved fetch time is never replaced by the rendering clock. */
export function savedReadAt(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

/** Unknown times have no label. Relative age is computed from the saved timestamp. */
export function lastReadLine(
  value: unknown,
  now = new Date(),
  surface: 'panel' | 'cli' = 'panel'
): string | null {
  const at = savedReadAt(value);
  if (at === null) return null;
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(at)) / 60_000));
  const count =
    minutes < 60 ? minutes : minutes < 1440 ? Math.floor(minutes / 60) : Math.floor(minutes / 1440);
  const unit = minutes < 60 ? 'minute' : minutes < 1440 ? 'hour' : 'day';
  const age = minutes === 0 ? 'just now' : `${count} ${unit}${count === 1 ? '' : 's'} ago`;
  return surface === 'cli' ? `List last read ${age}. It may be out of date.` : `Last read ${age}.`;
}
