import { PluginSettingTab, Setting, type Plugin, type SettingDefinitionItem } from "obsidian";
import { DEFAULT_BASE, normalizeBase } from "../auth/oauth";
import type { SyncloHost } from "../host";
import { unit } from "../jobs/jobs";
import { IMAGE_STYLES, lengthOptions } from "../settings";

interface Row {
  name: string;
  desc: string;
  render: (setting: Setting) => void;
}

interface Section {
  heading?: string;
  rows: Row[];
}

/**
 * Settings › Synclo: the connection first (who you are connected as and
 * your credits), then the defaults every new presentation starts from,
 * where downloads go, and the server address for development.
 *
 * One list of rows serves both ways Obsidian draws a settings tab: drawn
 * by hand (display(), Obsidian 1.11–1.12) and declared (Obsidian 1.13 and
 * later, where the rows also appear in settings search).
 */
export class SyncloSettingTab extends PluginSettingTab {
  private signingIn = false;

  constructor(
    plugin: Plugin,
    private readonly host: SyncloHost,
  ) {
    super(host.app, plugin);
    // Connected or not, the tab shows it at once (the plugin fetches the
    // account after a sign-in and calls redraw again).
    plugin.register(
      host.session.onChange(() => {
        this.signingIn = false;
        this.redraw();
      }),
    );
    // A sign-in declined or failed: back to Connect.
    plugin.register(
      host.session.onSignInEnded(() => {
        if (!this.signingIn) return;
        this.signingIn = false;
        this.redraw();
      }),
    );
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    // Called when the tab is added too: only fetch while it is open.
    if (this.containerEl.isConnected) void this.refresh();
    return this.sections().map((s) => ({
      type: "group" as const,
      ...(s.heading ? { heading: s.heading } : {}),
      items: s.rows.map((r) => ({ name: r.name, desc: r.desc, render: (setting: Setting) => r.render(setting) })),
    }));
  }

  /** Obsidian 1.11 and 1.12 draw the tab by hand. */
  display(): void {
    this.drawByHand();
    void this.refresh();
  }

  private drawByHand(): void {
    const { containerEl } = this;
    // The row whose control has focus gets it back after the redraw.
    const active = containerEl.ownerDocument.activeElement;
    const focusedRow = active && containerEl.contains(active) ? active.closest(".setting-item")?.querySelector(".setting-item-name")?.textContent : null;
    containerEl.empty();
    let refocus: HTMLElement | null = null;
    for (const section of this.sections()) {
      if (section.heading) new Setting(containerEl).setName(section.heading).setHeading();
      for (const row of section.rows) {
        const setting = new Setting(containerEl).setName(row.name).setDesc(row.desc);
        row.render(setting);
        if (focusedRow && setting.nameEl.textContent === focusedRow) refocus = setting.controlEl.querySelector<HTMLElement>("select, input, textarea, button, .checkbox-container");
      }
    }
    refocus?.focus();
  }

  /** Draws the tab again, whichever way Obsidian draws it. Cheap, and
   *  harmless when the tab isn't open (it is drawn afresh when it opens). */
  redraw(): void {
    const declared = this as unknown as { update?: () => void };
    if (typeof declared.update === "function") declared.update();
    else this.drawByHand();
  }

  private refreshing = false;
  private refreshedAt = 0;
  /** Fetches the account and themes when the tab opens (at most every 30
   *  seconds: a redraw reads the rows again, and must not fetch again). */
  private async refresh(): Promise<void> {
    if (!this.host.session.isSignedIn() || this.refreshing || Date.now() - this.refreshedAt < 30_000) return;
    this.refreshing = true;
    this.refreshedAt = Date.now();
    const before = JSON.stringify([this.host.cachedAccount(), this.host.cachedThemes()?.length]);
    try {
      await Promise.all([this.host.account(true), this.host.themes(true)]);
    } finally {
      this.refreshing = false;
    }
    if (JSON.stringify([this.host.cachedAccount(), this.host.cachedThemes()?.length]) !== before) this.redraw();
  }

  private sections(): Section[] {
    const s = this.host.settings;
    const save = () => void this.host.saveSettings();
    return [
      { rows: [this.connectionRow()] },
      {
        heading: "Defaults for new presentations",
        rows: [
          {
            name: "Format",
            desc: "",
            render: (setting) => {
              setting.addDropdown((d) =>
                d
                  .addOptions({ slides: "Slides", document: "Document" })
                  .setValue(s.format)
                  .onChange((v) => {
                    s.format = v === "document" ? "document" : "slides";
                    save();
                    this.redraw();
                  }),
              );
            },
          },
          {
            name: "Length",
            desc: s.format === "document" ? "The most sections Synclo writes. A short note may get fewer." : "The most slides Synclo makes, title slide included. A short note may get fewer.",
            render: (setting) => {
              setting.addDropdown((d) => {
                const account = this.host.cachedAccount();
                for (const n of lengthOptions(Math.max(account?.slidesPerPrompt ?? 10, s.slides), s.slides)) d.addOption(String(n), `${n} ${unit(s.format, n)}`);
                d.setValue(String(s.slides)).onChange((v) => {
                  s.slides = Number(v);
                  save();
                });
              });
            },
          },
          {
            name: "Words",
            desc: "Tighten the wording and keep every fact, or keep your words exactly as written.",
            render: (setting) => {
              setting.addDropdown((d) =>
                d
                  .addOptions({ condense: "Tighten the wording", preserve: "Keep my exact words" })
                  .setValue(s.keepWords ? "preserve" : "condense")
                  .onChange((v) => {
                    s.keepWords = v === "preserve";
                    save();
                  }),
              );
            },
          },
          {
            name: "Theme",
            desc: "Choose a theme, or let Synclo design a look for each note.",
            render: (setting) => {
              const themes = this.host.cachedThemes();
              if (!themes) setting.setDesc(!this.host.session.isSignedIn() ? "Connect to choose from your themes." : this.refreshedAt && !this.refreshing ? "Your themes couldn't be loaded right now." : "Choose a theme, or let Synclo design a look for each note.");
              setting.addDropdown((d) => {
                d.addOption("", "Designed for each note");
                for (const t of themes ?? []) d.addOption(t.id, t.name);
                if (s.theme && !(themes ?? []).some((t) => t.id === s.theme)) d.addOption(s.theme, "Your saved theme");
                d.setValue(s.theme).onChange((v) => {
                  s.theme = v;
                  save();
                });
              });
            },
          },
          {
            name: "Image style",
            desc: "The style of the images Synclo creates. Images in your note are used as they are.",
            render: (setting) => {
              setting.addDropdown((d) => {
                for (const [id, label] of IMAGE_STYLES) d.addOption(id, label);
                d.setValue(IMAGE_STYLES.some(([id]) => id === s.imageStyle) ? s.imageStyle : "theme").onChange((v) => {
                  s.imageStyle = v;
                  save();
                });
              });
            },
          },
          {
            name: "Include linked notes",
            desc: "Also send the notes it links to directly. You can change this each time.",
            render: (setting) => {
              setting.addToggle((t) =>
                t.setValue(s.includeLinked).onChange((v) => {
                  s.includeLinked = v;
                  save();
                }),
              );
            },
          },
        ],
      },
      {
        heading: "Downloads",
        rows: [
          {
            name: "Save downloads to",
            desc: "Where PowerPoint and PDF files are saved.",
            render: (setting) => {
              setting.addDropdown((d) =>
                d
                  .addOptions({ "note-folder": "The note's folder", attachments: "Obsidian's attachment folder" })
                  .setValue(s.saveTo)
                  .onChange((v) => {
                    s.saveTo = v === "attachments" ? "attachments" : "note-folder";
                    save();
                  }),
              );
            },
          },
        ],
      },
      // Only for development: shown once the address has been changed in the
      // plugin's data, so it can be put back.
      ...(normalizeBase(s.base) === DEFAULT_BASE ? [] : ([{
        heading: "Advanced",
        rows: [
          {
            name: "Server address",
            desc: `Leave this as ${DEFAULT_BASE} unless you are developing Synclo. Changing it disconnects you.`,
            render: (setting) => {
              setting.addText((t) => {
                t.setPlaceholder(DEFAULT_BASE).setValue(s.base);
                t.inputEl.addEventListener("change", () => {
                  void (async () => {
                    const next = normalizeBase(t.getValue() || DEFAULT_BASE);
                    if (!next) {
                      setting.setDesc("That isn't an address Synclo can use. Use https, or http for this computer only.");
                      return;
                    }
                    if (next === this.host.base()) return;
                    await this.host.disconnect();
                    s.base = next;
                    await this.host.saveSettings();
                    this.redraw();
                  })();
                });
              });
            },
          },
        ],
      }] as Section[])),
    ];
  }

  private connectionRow(): Row {
    return {
      name: "Synclo account",
      desc: "Connect to make presentations from your notes.",
      render: (setting) => {
        const account = this.host.cachedAccount();
        if (this.host.session.isSignedIn()) {
          setting.setName(account ? `Connected to ${account.workspace}` : "Connected to Synclo");
          setting.setDesc(
            createFragment((f) => {
              if (account && account.balance !== null) f.appendText(`${account.balance.toLocaleString()} credits. `);
              if (account?.slidesPerPrompt) f.appendText(`Your plan allows up to ${account.slidesPerPrompt} slides per presentation. `);
              const a = f.createEl("a", { text: "Get more credits", href: this.host.creditsUrl() });
              a.addEventListener("click", (e) => {
                e.preventDefault();
                this.host.openExternal(this.host.creditsUrl());
              });
            }),
          );
          setting.addButton((b) => {
            b.setButtonText("Disconnect").onClick(async () => {
              b.setDisabled(true);
              await this.host.disconnect();
              this.redraw();
            });
          });
          return;
        }
        this.host.prepareConnect();
        setting.setName("Synclo account");
        setting.setDesc(
          this.signingIn
            ? "Finish signing in to Synclo in your browser. You'll come back here when you're done."
            : "Connect your Synclo account to make presentations from your notes. New accounts get 400 free credits.",
        );
        setting.addButton((b) =>
          b
            .setButtonText(this.signingIn ? "Open the sign-in page again" : "Connect")
            .setCta()
            .onClick(() => {
              this.signingIn = true;
              this.redraw();
              void this.host.connect();
            }),
        );
      },
    };
  }
}
