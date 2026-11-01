import { Notice } from "obsidian";

export interface NoticeAction {
  label: string;
  run: () => void;
  /** The main action (drawn as the call to action). */
  primary?: boolean;
}

export interface RichNotice {
  title: string;
  line?: string;
  detail?: string;
  actions?: NoticeAction[];
  /** Milliseconds; 0 (the default) stays until closed. */
  duration?: number;
}

/** A notice with a title, a line, and buttons. Clicking a button runs it
 *  and closes the notice. */
export function richNotice(options: RichNotice): Notice {
  return new Notice(richContent(options), options.duration ?? 0);
}

/** A rich notice's content, for changing it in place with setMessage. */
export function richContent(options: RichNotice): DocumentFragment {
  return createFragment((f) => {
    const box = f.createDiv({ cls: "synclo-notice" });
    box.createDiv({ cls: "synclo-notice-title", text: options.title });
    if (options.line) box.createDiv({ cls: "synclo-notice-line", text: options.line });
    if (options.detail) box.createDiv({ cls: "synclo-notice-detail", text: options.detail });
    if (options.actions?.length) {
      const row = box.createDiv({ cls: "synclo-notice-actions" });
      for (const a of options.actions) {
        const b = row.createEl("button", { text: a.label, cls: a.primary ? "mod-cta" : "" });
        b.addEventListener("click", () => a.run());
      }
    }
  });
}

/** The same notice's words, changed in place. */
export function noticeContent(title: string, line: string): DocumentFragment {
  return createFragment((f) => {
    const box = f.createDiv({ cls: "synclo-notice" });
    box.createDiv({ cls: "synclo-notice-title", text: title });
    box.createDiv({ cls: "synclo-notice-line", text: line });
  });
}
