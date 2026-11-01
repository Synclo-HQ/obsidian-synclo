# Synclo for Obsidian

Turn a note into a designed presentation with editable slides, or a document,
and save it as PowerPoint or PDF in your vault. Your note's words, the notes it
embeds and its own pictures come along; its comments, queries and properties
stay behind.

[Synclo](https://synclo.app) is an AI presentation and document maker. This
plugin sends the note you choose to Synclo, which plans, writes and designs the
deck in your Synclo workspace. You can then edit, present and share it in
Synclo, and download it into your vault as PowerPoint or PDF.

## Before you install: what this plugin needs

- **A Synclo account is required.** You sign in at synclo.app from the plugin's
  settings.
- **A free account comes with 400 credits**, once. Each slide or section
  Synclo makes costs 10 credits, so 400 credits make about 40 slides. More
  credits are an optional payment, made at synclo.app; the plugin itself shows
  no prices and takes no payments. Opening, finding and downloading the
  presentations you already have cost nothing.
- **It uses the network.** See [What is sent, and when](#what-is-sent-and-when).

## What you can do

| Command | What it does |
| --- | --- |
| Make a presentation from this note | Opens the make window for the note in front. |
| Make a presentation from the selection | The same, for the selected text only. |
| Download this note's presentation as PowerPoint | Makes a `.pptx` of the note's presentation and saves it in the vault. |
| Download this note's presentation as PDF | The same, as a PDF. |
| Open this note's presentation in your browser | Opens it in Synclo, where you edit, present and share it. |
| Find a presentation | Searches your Synclo presentations; insert a link to one, download it, or open it. |

The make command is also on the ribbon, in a note's file menu and in the editor's
right-click menu. No command has a default hotkey; set your own in Obsidian's
Hotkeys settings.

### The make window

Before anything leaves your vault, the window shows exactly what will be sent:
the title, the number of words and pictures, the linked notes included, and a
**Left out** line that names what stays behind (for example "Left out: 1 PDF,
1 Dataview query, private comments"). **Preview the text** shows the text
itself.

Then you choose:

- **Format**: slides, or a document of sections.
- **Length**: the most slides you want. Your plan sets how many Synclo makes at
  a time (10 on the free plan).
- **Words**: *Let Synclo condense* tightens the wording and keeps every fact;
  *Keep my words* keeps every word as written. A note under 20 words is read as
  a brief instead, and Synclo writes from it.
- **Theme** and **Pictures**: one of your workspace's themes, or a look designed
  for the note; and the style of the pictures Synclo makes.
- **Include linked notes**: also send the notes this note links to, one level
  deep (up to 10 notes).
- **More choices**: the language, and instructions such as who it's for.

The window shows the cost in credits beside your balance. Click **Make**.

### While it's made

A presentation takes three to five minutes. A notice shows the slides as Synclo
plans and writes them ("4 of 9 slides written"); on desktop the status bar does
too. Keep working, close the notice, or close Obsidian: the plugin remembers the
presentation on this device and picks it up again when Obsidian opens or comes
back to the front.

When it's ready, its link is written into the note's properties as `synclo`,
and a notice offers **Open in Synclo**, **Download PowerPoint** and **Download
PDF**. Downloads go next to the note, or into your attachment folder (a
setting). Existing files are never overwritten.

## What is sent, and when

The plugin talks to Synclo only when you use it: when you run one of its
commands, connect, or open its settings or make window; and, while a
presentation you started is being made, to check on it. It talks only to Synclo
(`https://synclo.app`, or the server address set under Advanced):

- **Connect** opens Synclo's sign-in page in your browser. Synclo sends you back
  to Obsidian, and the plugin exchanges a one-time code for its sign-in.
- **Make** sends the note's text as the make window showed it, your choices, and
  the note's own pictures (PNG, JPEG or WebP up to 8 MB; up to 20). Only the
  note you chose is read, plus the notes and pictures it embeds and, if you turn
  it on, the notes it links to. Nothing else in your vault is read.
- **Never sent:** frontmatter and properties (except the `title`, which names
  the deck), `%%comments%%` and `<!-- comments -->`, tags, block ids, Dataview,
  Tasks, search and Bases queries, PDFs, canvases, audio and video, and files
  that aren't linked from the note.
- While a presentation is made, the plugin asks Synclo how it is going: one
  request that Synclo holds open for up to half a minute, then the next.
- **Download** asks Synclo to make the file, then fetches it from the link
  Synclo returns; that link forwards to the file in Synclo's storage. Your
  sign-in is never sent to storage.
- **Find** sends the words you type, to search your presentations' titles.
- The settings and the make window ask Synclo for your workspace's name,
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
Obsidian. Phones pause apps in the background; when you return to Obsidian the
plugin checks on presentations at once. There's no status bar on mobile, so
progress shows in a notice.

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

Releases are built and attested by GitHub Actions (`.github/workflows/release.yml`)
from a tag that matches the version in `manifest.json`.

## License

MIT, © 2026 Synclo Inc. See [LICENSE](LICENSE).
