# MRAkdown

A lightweight Markdown viewer and editor for Windows and Linux. Double-click a `.md` file and it opens, with the folder
around it in a sidebar: there's no vault to set up. It reads notes written for Obsidian, with their `[[wikilinks]]` and
callouts.

![MRAkdown with a note on the left and a comparison with the last git commit on the right](assets/screenshot.png)

MRAkdown is a personal project, shared as-is: there's no promise of support, fixes or new features. It runs on
Windows 10 and 11, and on Linux with recent GTK libraries (see [Linux](#linux)).

## Features

**Notes**

- Reads Obsidian notes: `[[wikilinks]]`, callouts, highlights, task lists, tables, footnotes, images and highlighted code
- **Edit** a note while it looks as it does when read, or switch to the plain **Source**, or **Split** with a preview
- A formatting toolbar; pasted or dropped images are saved next to the note
- Rename a file right from its title, its tab or the sidebar

**Other files**

- JSON and XML as trees and CSV/TSV as tables, editable as they look
- Text, logs and code, even very large ones (tested with a 784 MB log): files over 20 MB open read-only
- Stays quick with long files: tables and text only draw what's on screen

**Folders and files**

- No vault: double-click a file and its folder becomes the sidebar, with search
- Tabs with back and forward, two panes side by side, more windows
- Compare two files, or a file with any earlier git commit
- Follows changes made by other programs, without losing your unsaved edits
- Saves when you choose (or automatically), keeping each file's encoding and line endings
- Light, dark or system theme, an accent colour, and keyboard shortcuts you can change

MRAkdown has no account and no telemetry of its own; your files are only read and written on your own computer. Web
links open in your browser, and images that a note embeds from the web load as they would in a browser. (On Windows,
the WebView2 runtime that shows the page follows Microsoft's own settings for diagnostic data.)

## Install

Comparing with git commits needs [git](https://git-scm.com/), on the `PATH`.

### Windows

Download `MRAkdown-…-win-x64.zip` from the [latest release](https://github.com/MtnGoatDK/MRAkdown/releases/latest),
unzip it somewhere permanent and run `MRAkdown.exe`. It needs the
[.NET 10 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/10.0) and the WebView2 Runtime (built into
Windows 11; on Windows 10, install it from Microsoft if it's missing). The `.exe` isn't code-signed, so Windows may warn
the first time you run it: choose "More info", then "Run anyway" (or right-click the zip, choose Properties and tick
"Unblock" before unzipping). To open Markdown files with it by double-clicking, choose it under "Open with" in Explorer.

To build it yourself instead, you need the [.NET 10 SDK](https://dotnet.microsoft.com/download):

```powershell
dotnet publish src\MRAkdown.Windows -c Release -o publish
```

This builds `publish\MRAkdown.exe`.

The release zip holds a single small `.exe` (and the license), built by `.github/workflows/release.yml` when a version
tag such as `v1.0.0` is pushed. The same build locally (without ReadyToRun, which crashes combined with single-file on installed
.NET):

```powershell
dotnet publish src\MRAkdown.Windows -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:PublishReadyToRun=false -p:DebugType=none -o share
```

### Linux

Needs at least GTK 4.10, libadwaita 1.5 and WebKitGTK 2.40 (its 6.0 API): MRAkdown uses functions those versions
added, so older releases of some distributions are too old. Tested with GTK 4.24, libadwaita 1.10 and WebKitGTK 2.54.
On Arch and CachyOS: `sudo pacman -S dotnet-sdk gtk4 libadwaita webkitgtk-6.0`. It builds for the processor of the
machine it's built on (x86-64 or ARM64).

```sh
packaging/linux/install.sh             # build and install for the current user (in ~/.local)
packaging/linux/install.sh --default   # ...and make it the default app for Markdown files
packaging/linux/install.sh --uninstall # keeps your settings
```

MRAkdown is then in the app menu, and `mrakdown [file or folder]` starts it from a terminal (if `~/.local/bin` is on
your `PATH`). To update, close MRAkdown and run the install script again.

Differences from Windows:

- As on Windows, there is no separate title bar: drag the empty part of the top bar to move the window. Double, middle
  and right clicks there do what your desktop does for title bars, and the window buttons follow the desktop's button
  layout.
- Wayland doesn't tell apps where windows are, so dropping a tab onto another window relies on that window noticing
  the pointer entering it, and new windows open where the desktop puts them.
- If pages render blank or with glitches on NVIDIA graphics, try starting it with `WEBKIT_DISABLE_DMABUF_RENDERER=1`.

## Using it

### Modes and editing

- **Read** shows a note as it's meant to look; Obsidian's `[[wikilinks]]` work also to headings (`[[Note#Heading]]`)
  and with aliases (`[[Note|text]]`).
- **Edit** changes a Markdown file while it looks as it does when read: headings, emphasis, links, images, lists, task
  checkboxes, quotes, callouts, code blocks and tables show formatted, and the line the cursor is on (or the table
  it's in) shows its Markdown. The file stays exactly the text you type.
- **Source** shows the plain text, every character as it is; **Split** shows the source and a preview side by side.
- Pasted or dropped images are saved in an `attachments` folder next to the file.
- **JSON and XML** in Edit look like the Read view's tree: the same colours, collapsible branches with their size
  shown, guide lines per level. JSON syntax errors are marked as you type. A file that's all on one line (minified)
  opens spread over indented lines without changing any value or text, and saving puts it back on one line (Source
  shows it as it is on disk). Format re-indents the whole JSON file, and right-clicking a branch puts
  just that object or array on one line or spreads it out. Very long lines show only their start, and lines over
  500,000 characters (such as embedded images) are read-only.
- **CSV and TSV** in Edit are the Read view's table, editable: add and remove rows and columns; only the cells you
  change are rewritten in the file.
- **Rename** a file by clicking its title above the text, with `F2`, or from its tab's or sidebar entry's right-click
  menu; open tabs, their history and unsaved edits follow it.

### The sidebar

Opening a file shows its nearest `.obsidian` or `.git` folder, or else its own folder. Choose whether the sidebar
lists Markdown files only, also files with a viewer of their own, or all files; hidden files and folders and
`node_modules` are left out. Search finds files by name and path.

A very large folder (over 50,000 files and folders, such as a home folder) is scanned as you open its subfolders, so
links and search then cover the folders opened so far. Links to folders (symlinks, junctions) aren't followed.

### Other files and large files

JSON, CSV/TSV and XML open in viewers of their own; `.txt`, `.log` and files without an extension as plain text;
other text files as code. "View as" picks another viewer, remembered per file type.

Long files stay quick: tables and text only draw the rows near the view, and big JSON or XML branches add their
items as you scroll. Text files over 20 MB (big logs) open read-only, read from disk in parts as you scroll, whatever
their size. One with more lines than a page can hold (about a million) is shown in parts, with buttons for the
start, earlier, later and the end.

### Saving and changes from other programs

- A tab keeps its unsaved edits (marked with a dot) until you save them with `Ctrl+S`, also while you look at other
  tabs. You're asked Save / Don't save / Cancel before they'd be lost: closing the tab or window, or opening another
  file in it. With "Save automatically" on (Settings), edits are saved whenever you switch to another file, tab or
  mode instead. A new file asks where to save it the first time.
- Each file keeps its encoding (UTF-8, UTF-16, Windows-1252) and line endings (CRLF or LF). A Windows-1252 file that
  gets characters it can't hold, such as emoji, is saved as UTF-8 instead.
- When a file you have open changes on disk (another editor, `git pull`), it shows the new version right away, and
  the sidebar updates too. If you have unsaved edits in it, Settings decides: **Ask me** (default) keeps both when the
  changes are on different lines, and otherwise lets you compare, keep yours, save yours as a copy or reload; **Keep
  mine** leaves your edits (saving asks before overwriting the new version); **Take new** saves your edits as a copy
  next to the file and shows the new version.
- One instance runs at a time: opening more files adds tabs to the window you used last.

### Tabs, panes and comparisons

- **Tabs** each have their own back/forward history. Drag a tab to reorder it, out of the window to open it in a new
  one, or onto another window to move it there.
- **Open to the side:** right-click a file in the sidebar, a link or a tab, or drag a tab onto the right half of the
  page (when its pane has other tabs). Drag a tab onto the other pane to move it there; a pane closes with its last
  tab, and the divider between the panes can be dragged (double-click it to reset).
- **Compare two files:** right-click one and choose "Select for compare", then right-click the other and choose
  "Compare with …". A file's menu in the sidebar can also compare it with the file open now, and with two panes open,
  a tab's menu with the file in the other pane.
- **Compare with git:** "Compare with last commit", or "Compare with commit…" to pick from the commits that changed the
  file (renames are followed).
- Comparisons show the two side by side, with changed lines and words highlighted and unchanged stretches folded away.
  They use the files as saved, and ignore differences in line endings alone.

### The window

There is no separate title bar: the tab bar takes its place. Drag its empty part (or the folder name above the
sidebar) to move the window; double-click it to maximize, right-click it for the window menu. Snapping and resizing
from every edge work as usual. On Windows, hovering the maximize button doesn't show the Snap Layouts menu; `Win+Z`
does. On Linux, see [Differences from Windows](#linux).

### Keyboard shortcuts

These are the defaults. All keys except `Ctrl+1…9` can be changed in Settings, under "Change shortcuts…" (the mouse
buttons can't).

| Keys | Action |
|---|---|
| `Ctrl+N` / `Ctrl+Shift+N` | New file / new window |
| `Ctrl+O` / `Ctrl+Shift+O` | Open file / open folder |
| `Ctrl+S` | Save (asks where, for a new file) |
| `F2` | Rename the file (or click its title, or right-click its tab or its entry in the sidebar) |
| `Ctrl+E` / `Ctrl+U` / `Ctrl+Shift+E` | Toggle Edit / Source / Split mode |
| `Ctrl+P` | Search files (`Enter` opens the first match, `Esc` clears) |
| `Ctrl+T` (or the + after the tabs), `Ctrl+W`, `Ctrl+Shift+T` | New, close, reopen tab |
| `Ctrl+Tab`, `Ctrl+Shift+Tab`, `Ctrl+PageDown`, `Ctrl+PageUp` | Next / previous tab |
| `Ctrl+1…8`, `Ctrl+9` | Go to that tab, to the last tab |
| `Alt+←` / `Alt+→`, mouse back / forward | Back / forward |
| `F5` or `Ctrl+R` | Reload the file and folder |
| `F7` / `Shift+F7` | Next / previous change, in a comparison |
| `Ctrl+\` | Show or hide the sidebar |
| `Ctrl+Shift+W` | Close the window |
| `Ctrl+B` / `Ctrl+I` / `Ctrl+K` | Bold / italic / link, while editing a Markdown file |

Clicking a file or link opens it in the current tab. `Ctrl+click` or middle-click opens it in a background tab,
`Ctrl+Shift+click` in a new tab you switch to, and `Shift+click` in a new window. Middle-click a tab to close it.

## Development

The UI is a web page (`web/`) shown by a small native host: WinForms with WebView2 on Windows, and GTK 4 with
libadwaita and WebKitGTK (through [Gir.Core](https://gircore.github.io/)) on Linux. Both are built with .NET 10.

| Folder | What |
|---|---|
| `src/MRAkdown.Core` | Shared: indexing folders, rendering Markdown, wikilinks, file encodings, git history, and serving the page (`NoteServer`) |
| `src/MRAkdown.Windows` | Windows host: a WinForms window with WebView2 |
| `src/MRAkdown.Linux` | Linux host: a libadwaita window with WebKitGTK; the page is served under `mrakdown://notes/` |
| `web/` | The page, shared by both hosts (embedded in Core) |
| `packaging/linux` | Desktop entry and per-user install script |
| `assets/` | Windows app icon (made from `web/logo.svg` by `make-icon.ps1`, on Windows with Microsoft Edge) and the screenshot |

- Run the Linux version from the repo with `dotnet run --project src/MRAkdown.Linux -- [file or folder]`.
- `MRAKDOWN_DEVTOOLS=1` (Linux) enables Inspect Element in the page and prints its console messages.
- `MRAKDOWN_INSTANCE=name` starts a separate instance, e.g. to test next to an installed copy that is in use.

## License

MRAkdown is free software under the [GNU General Public License v3.0](LICENSE).

It uses [Markdig](https://github.com/xoofx/markdig) (BSD-2-Clause), [Gir.Core](https://gircore.github.io/) (MIT) and
the WebView2 SDK (BSD-3-Clause style, Microsoft), and includes [highlight.js](https://highlightjs.org/) 11.9.0
(BSD-3-Clause) in `web/hljs*` and [CodeMirror 6](https://codemirror.net/) with Lezer (MIT) in `web/codemirror.js`,
bundled from the exact versions in `tools/codemirror` (`npm ci && npm run build` there rebuilds it).

MRAkdown isn't affiliated with or endorsed by Obsidian.
