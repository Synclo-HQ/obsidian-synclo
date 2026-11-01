import { Modal, SuggestModal, type Editor, type TFile } from "obsidian";
import { messageFor } from "../api/errors";
import type { Presentation } from "../api/synclo";
import type { SyncloHost } from "../host";

/** Where a found presentation can go: the note open when Find started. */
export interface FindContext {
  editor: Editor | null;
  file: TFile | null;
}

/**
 * Find a Synclo presentation: the workspace's presentations, most recent
 * first, narrowed by words in the title as the person types. Choosing one
 * offers to insert a link, download it, or open it. Works without credits.
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

/** What to do with a presentation found. */
class FoundModal extends Modal {
  constructor(
    private readonly host: SyncloHost,
    private readonly p: Presentation,
    private readonly context: FindContext,
  ) {
    super(host.app);
  }

  onOpen(): void {
    this.setTitle(this.p.title);
    this.modalEl.addClass("synclo-found-actions");
    const row = this.contentEl.createDiv({ cls: "synclo-action-list" });
    const action = (label: string, run: () => void, cta = false) => {
      const b = row.createEl("button", { text: label, cls: cta ? "mod-cta" : "" });
      b.addEventListener("click", () => {
        this.close();
        run();
      });
    };
    const { editor, file } = this.context;
    if (editor) {
      action(
        "Insert a link",
        () => {
          const title = this.p.title.replace(/[[\]]/g, "");
          editor.replaceSelection(`[${title}](${this.p.editUrl})`);
        },
        true,
      );
    }
    action("Open in Synclo", () => this.host.openExternal(this.p.editUrl), !editor);
    action("Download PowerPoint", () => void this.host.download(this.p.id, "pptx", file, this.p.title));
    action("Download PDF", () => void this.host.download(this.p.id, "pdf", file, this.p.title));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
