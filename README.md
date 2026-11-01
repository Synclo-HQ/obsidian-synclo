# Synclo for Obsidian

Turn a note into a designed presentation. Synclo writes and designs the slides
from your note; then you edit, present and share them in Synclo, or download
them into your vault as PowerPoint or PDF.

- **Your note, as you wrote it.** Its words, the notes it embeds and its own
  images go into the deck. Comments, queries and properties stay behind, and
  you see exactly what will be sent before you send it.
- **Watch it being made.** The Synclo panel opens beside your note and shows
  each slide as it's written.
- **Back in your vault.** The deck's link goes into the note's properties, and
  downloads are saved next to the note.

## What you need

- **A Synclo account.** You connect it from the plugin. Signing up is free.
- **Credits.** New accounts get 400 free credits, enough for about 40 slides:
  each slide Synclo makes costs 10 credits. More credits are an optional
  purchase at [synclo.app](https://synclo.app); the plugin shows no prices and
  takes no payments. Opening, finding and downloading the presentations you
  already have costs nothing.
- **An internet connection.** See [What is sent, and when](#what-is-sent-and-when).

## Getting started

1. Install and enable Synclo in **Settings › Community plugins**.
2. Open a note and click **Make a presentation from this note** in the left
   ribbon, or run it from the command palette.
3. The first time, click **Connect**. Synclo's sign-in opens in your browser,
   then brings you back to Obsidian.
4. Check what will be sent, choose your options and click **Make**.

## Making a presentation

### The make window

Before anything leaves your vault, the window shows what will be sent: the
note's title, its word and image counts, any linked notes included, and a
**Left out** line that names what stays behind (for example "Left out: 1 PDF,
1 Dataview query, comments"). **Preview what's sent** shows the exact text.

Then choose:

- **Format**: slides or a document.
- **Length**: the most slides Synclo makes, title slide included (up to 10 on
  the Free plan). A short note may get fewer.
- **Words**: *Tighten the wording* keeps every fact and shortens the
  sentences; *Keep my exact words* keeps every word as written. A note under 20
  words is treated as a topic, and Synclo writes the slides itself.
- **Theme**: one of Synclo's themes or your workspace's own, or a look Synclo
  designs for the note.
- **Image style**: the style of the images Synclo creates. Images in your note
  are used as they are.
- **Include linked notes**: also send the notes it links to directly (up to 10).
- **More options**: the language, and instructions such as who the
  presentation is for.

If your credits fall short, the window says so before you start. To use only
part of a note, select it and run **Make a presentation from the selection**.

### While it's made

A presentation takes three to five minutes. The Synclo panel opens beside your
note and shows the plan, then each slide as it's written, then the finished
deck, which you can look through there. The status bar shows the progress in
one line; click it to bring the panel back. On a phone, a notice offers
**Watch**, which opens the panel.

Keep working, or close Obsidian: the plugin remembers the presentation on this
device and picks it up again when Obsidian opens or comes back to the front.

### When it's ready

The deck's link is written into the note's properties as `synclo`, and the
panel offers **Open in Synclo**, **Download PowerPoint** and **Download PDF**.
If the panel isn't on screen, a notice offers them instead.

Downloads are saved in the note's folder, or in Obsidian's attachment folder (a
setting), and listed in the note's properties under `synclo files`. Existing
files are never overwritten. Files made on Synclo's Free plan carry a small
"Made with Synclo" mark.

Making another presentation from the same note links the note to the new one;
the first stays in your Synclo library.

## Commands

| Command | What it does |
| --- | --- |
| Make a presentation from this note | Opens the make window for the open note. |
| Make a presentation from the selection | The same, for the selected text only. |
| Find a presentation | Searches your Synclo presentations by title, then inserts a link to one, opens it or downloads it. |
| Open this note's presentation in your browser | Opens it in Synclo, where you edit, present and share it. |
| Download this note's presentation as PowerPoint | Saves a `.pptx` in your vault. |
| Download this note's presentation as PDF | Saves a PDF in your vault. |

Making a presentation is also in the left ribbon, in a note's file menu and in
the editor's right-click menu. No command has a default hotkey; set your own in
**Settings › Hotkeys**.

## Settings

**Settings › Synclo** shows your connection (the workspace, its credits and
**Disconnect**), the defaults for new presentations (format, length, words,
theme, image style and linked notes) and where downloads are saved. You can
change the defaults each time in the make window.

## What is sent, and when

The plugin talks to Synclo only when you use it: when you run one of its
commands, connect, or open its settings, make window or panel; and, while a
presentation you started is being made, to check on it. It talks only to
Synclo (`https://synclo.app`):

- **Connect** opens Synclo's sign-in page in your browser. Synclo sends you
  back to Obsidian, and the plugin exchanges a one-time code for its sign-in.
- **Make** sends the note's text as the make window showed it, your choices,
  and the note's own images (PNG, JPEG or WebP up to 8 MB; up to 20). Only the
  note you chose is read, plus the notes and images it embeds and, if you turn
  it on, the notes it links to. Nothing else in your vault is read.
- **Never sent:** frontmatter and properties (except `title`, which names the
  deck), `%%comments%%` and `<!-- comments -->`, tags, block ids, Dataview,
  Tasks, search and Bases queries, PDFs, canvases, audio and video, and files
  that aren't linked from the note.
- **While a presentation is made,** the plugin asks Synclo how it is going: one
  request that Synclo holds open for up to half a minute, then the next. While
  the Synclo panel is on screen, it also asks every few seconds for the
  pictures of the slides written so far.
- **Download** asks Synclo to make the file, then fetches it from the link
  Synclo returns; that link forwards to the file in Synclo's storage. Your
  sign-in is never sent to storage.
- **Find** sends the words you type, to search your presentations' titles.
- **The settings and the make window** ask Synclo for your workspace's name,
  credits, plan and themes, to show them.

## Your sign-in and privacy

- Your sign-in is kept in Obsidian's secret storage on this device (the
  keychain), never in your vault and never in the plugin's `data.json`. Each
  device signs in on its own. **Disconnect** ends this device's sign-in on
  Synclo and forgets it.
- The plugin has **no telemetry**: it records and sends nothing about how you
  use it.
- What Synclo does with what you send is described in its privacy policy:
  <https://synclo.app/privacy>.

## On phones and tablets

Everything works on mobile. Sign-in opens your browser and comes back to
Obsidian. While a presentation is made, a notice offers **Watch**, which opens
the Synclo panel; when it's ready, a notice offers the same actions as on a
computer. Phones pause apps in the background; when you return to Obsidian, the
plugin checks on presentations at once.

## Help

Write to [support@synclo.app](mailto:support@synclo.app), or open an issue on
this repository. Synclo's own help pages are at <https://synclo.app/help>.

## Building from source

```sh
npm install
npm run build   # main.js
npm test        # the note-to-material tests and the rest
npm run lint    # Obsidian's own lint rules
```

The note-to-material code (`src/material/`) is pure TypeScript with no Obsidian
imports; its awkward test notes live in `tests/fixtures/vault/`, and the exact
text each one sends is in `tests/fixtures/expected/`.

Releases are built and attested by GitHub Actions
(`.github/workflows/release.yml`) from a tag that matches the version in
`manifest.json`.

## License

MIT, © 2026 Synclo Inc. See [LICENSE](LICENSE).
