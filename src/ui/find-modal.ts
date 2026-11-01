import { SuggestModal, setIcon, type Editor, type TFile } from "obsidian";
import { messageFor } from "../api/errors";
import type { Presentation } from "../api/synclo";
import type { SyncloHost } from "../host";
import { markdownLink } from "../util/link-text";

/** Where a found presentation can go: the note open when Find started. */
export interface FindContext {
  editor: Editor | null;
  file: TFile | null;
}

/**
 * Find a Synclo presentation: the workspace's presentations, most recent
 * first, narrowed by words in the title as the person types. Choosing one
 * lists what can be done with it: insert a link, open it, download it.
 * Works without credits.
 */
export class FindModal extends SuggestModal<Presentation> {
  private seq = 0;
  private last: Presentation[] = [];

  constructor(
    private readonly host: SyncloHost,
    private readonly context: FindContext,
  ) {
    super(host.app);
    this.setPlaceholder("Search your Synclo presentations by title");
    this.setInstructions([
      { command: "↑↓", purpose: "to navigate" },
      { command: "↵", purpose: "to choose" },
      { command: "esc", purpose: "to dismiss" },
    ]);
    this.emptyStateText = "Looking…";
    this.limit = 20;
  }

  async getSuggestions(query: string): Promise<Presentation[]> {
    const mine = ++this.seq;
    // A short pause while typing, so each key isn't a request.
    if (query) await new Promise((r) => window.setTimeout(r, 250));
    if (mine !== this.seq) return this.last;
    try {
      const found = await this.host.api.search(query, 20);
      if (mine !== this.seq) return this.last;
      this.last = found;
      this.emptyStateText = query ? `No presentations with “${query}” in the title.` : "No presentations in this workspace yet.";
      return found;
    } catch (err) {
      this.emptyStateText = messageFor(err);
      return [];
    }
  }

  renderSuggestion(p: Presentation, el: HTMLElement): void {
    el.addClass("synclo-found");
    el.createDiv({ cls: "synclo-found-title", text: p.title });
    const when = p.updatedAt ? new Date(p.updatedAt) : null;
    if (when && !Number.isNaN(when.getTime())) el.createEl("small", { cls: "synclo-found-meta", text: `Updated ${when.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}` });
  }

  onChooseSuggestion(p: Presentation): void {
    new FoundModal(this.host, p, this.context).open();
  }
}

/** One thing to do with a presentation found. */
interface FoundAction {
  label: string;
  icon: string;
  run: () => void;
}

/**
 * What to do with a presentation found: a second list in the same place,
 * as Obsidian's own two-step choices are (type to narrow it, arrows and
 * Enter, Escape to leave).
 */
class FoundModal extends SuggestModal<FoundAction> {
  private readonly actions: FoundAction[];

  constructor(host: SyncloHost, p: Presentation, context: FindContext) {
    super(host.app);
    this.setPlaceholder(`${p.title}: choose what to do`);
    this.setInstructions([
      { command: "↑↓", purpose: "to navigate" },
      { command: "↵", purpose: "to use" },
      { command: "esc", purpose: "to dismiss" },
    ]);
    const { editor, file } = context;
    // A download belongs to the open note only when the note's own link is
    // this presentation; otherwise it goes to the attachment folder and no
    // note is touched.
    const owner = file && host.noteDocumentId(file) === p.id ? file : null;
    this.actions = [
      ...(editor
        ? [
            {
              label: "Insert a link to it here",
              icon: "link",
              // Selected words stay, as the link's text.
              run: () => editor.replaceSelection(markdownLink(editor.getSelection(), p.title, p.editUrl)),
            },
          ]
        : []),
      { label: "Open in Synclo", icon: "external-link", run: () => host.openExternal(p.editUrl) },
      { label: "Download as PowerPoint", icon: "presentation", run: () => void host.download(p.id, "pptx", owner, p.title) },
      { label: "Download as PDF", icon: "file-text", run: () => void host.download(p.id, "pdf", owner, p.title) },
    ];
  }

  getSuggestions(query: string): FoundAction[] {
    const q = query.trim().toLowerCase();
    return q ? this.actions.filter((a) => a.label.toLowerCase().includes(q)) : this.actions;
  }

  renderSuggestion(a: FoundAction, el: HTMLElement): void {
    el.addClass("synclo-found-action");
    setIcon(el.createSpan({ cls: "synclo-found-action-icon" }), a.icon);
    el.createSpan({ text: a.label });
  }

  onChooseSuggestion(a: FoundAction): void {
    a.run();
  }
}
