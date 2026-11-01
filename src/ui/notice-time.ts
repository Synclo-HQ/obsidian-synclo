/** How long a notice without a button stays. */
export const INFORMS_MS = 10_000;

/** A notice's time on screen, in milliseconds (0 stays until closed): the
 *  one it was given, or, by default, until used or closed when it has a
 *  button, and INFORMS_MS when it only informs. */
export function noticeDuration(options: { duration?: number; actions?: unknown[] }): number {
  return options.duration ?? (options.actions?.length ? 0 : INFORMS_MS);
}
