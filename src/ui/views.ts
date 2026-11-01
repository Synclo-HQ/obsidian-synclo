import type { App, View } from "obsidian";
import { MESSAGES } from "../api/errors";
import type { SyncloHost } from "../host";
import { NOT_FOUND_MESSAGE } from "../jobs/runner";
import type { DeckWatch, RunnerDocument } from "../panel/watch";

/** What the Synclo panel and the deck viewer share. */

/** Said in place of where it stands when there is no more to follow, with
 *  what the person can do about it. */
export interface Final {
  message: string;
  action: { label: string; run: () => void } | null;
  /** The action is to connect again (a sign-in is got ready for it). */
  connect?: boolean;
  /** The deck isn't in the workspace any more. */
  gone?: boolean;
}

export const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** On screen: its window in front, the view not behind another tab, its
 *  sidebar not collapsed, its drawer not closed. */
export function onScreen(app: App, view: View): boolean {
  if (view.containerEl.doc.visibilityState !== "visible" || !view.containerEl.isShown()) return false;
  const root = view.leaf.getRoot();
  const { leftSplit, rightSplit } = app.workspace;
  for (const side of [leftSplit, rightSplit]) if (root === side && side.collapsed) return false;
  return true;
}

/** The presentation once there is one: from Synclo's answer for the deck,
 *  else from the job runner's; none once it isn't in the workspace. */
export function presentationOf(w: DeckWatch | null): RunnerDocument | null {
  if (!w || w.card?.gone || w.stopped?.reason === "gone") return null;
  return w.card?.document ?? w.runnerDocument;
}

/** What to say once there is no more to follow, if that is so. */
export function finalOf(host: SyncloHost, w: DeckWatch | null): Final | null {
  const card = w?.card ?? null;
  if (card?.gone || w?.stopped?.reason === "gone") return { message: NOT_FOUND_MESSAGE, action: null, gone: true };
  if (card?.status === "failed") {
    if (card.error?.code === "insufficient_credits") {
      return { message: MESSAGES.outOfCredits, action: { label: "Get more credits", run: () => host.openExternal(host.creditsUrl()) } };
    }
    return { message: card.error?.message || "The presentation couldn't be made.", action: null };
  }
  const stopped = w?.stopped;
  if (!stopped) return null;
  if (stopped.reason === "signed-out") return { message: MESSAGES.signedOut, action: { label: "Connect", run: () => void host.connect() }, connect: true };
  if (stopped.reason === "scope") return { message: stopped.error.message, action: { label: "Connect again", run: () => void host.connect() }, connect: true };
  return { message: stopped.error.message, action: null };
}
