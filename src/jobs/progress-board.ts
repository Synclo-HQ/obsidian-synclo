import type { Status } from "../api/synclo";
import type { ProgressInput } from "./jobs";

/**
 * The newest word on each generation, from whichever of Synclo's answers
 * came last: the job runner's checks (get_generation) or the panel's
 * (card_state). The status bar and the panel both read it, so they never
 * say different things. Two sources can cross on the way back, so an
 * answer that is behind what is already known is not taken.
 */

const ORDER: Record<Status, number> = { queued: 0, running: 1, completed: 2, failed: 2 };

/** An answer that says less has happened than `current` does. */
export function isBehind(next: ProgressInput, current: ProgressInput): boolean {
  if (ORDER[next.status] !== ORDER[current.status]) return ORDER[next.status] < ORDER[current.status];
  if (current.started && !next.started) return true;
  if (current.total > 0 && next.total === 0) return true;
  if (next.written < current.written) return true;
  return (next.pictures?.made ?? 0) < (current.pictures?.made ?? 0);
}

function same(a: ProgressInput, b: ProgressInput): boolean {
  return (
    a.status === b.status &&
    a.title === b.title &&
    a.step === b.step &&
    a.started === b.started &&
    a.total === b.total &&
    a.written === b.written &&
    (a.pictures?.made ?? -1) === (b.pictures?.made ?? -1) &&
    (a.pictures?.total ?? -1) === (b.pictures?.total ?? -1) &&
    a.slideTitles.join("\n") === b.slideTitles.join("\n")
  );
}

export class ProgressBoard {
  private entries = new Map<string, ProgressInput>();
  private listeners = new Set<(generationId: string) => void>();

  get(generationId: string): ProgressInput | null {
    return this.entries.get(generationId) ?? null;
  }

  /** Takes an answer unless it is behind what is known. Planned titles
   *  only one source gives are kept when the other answers. */
  update(generationId: string, input: ProgressInput): void {
    const current = this.entries.get(generationId);
    if (current && isBehind(input, current)) return;
    const next = current && !input.slideTitles.length && current.total === input.total ? { ...input, slideTitles: current.slideTitles } : input;
    if (current && same(current, next)) return;
    this.entries.set(generationId, next);
    for (const l of this.listeners) l(generationId);
  }

  onChange(listener: (generationId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
