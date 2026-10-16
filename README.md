# MRAkdown

A lightweight Markdown viewer and editor for Windows and Linux, in the spirit of Obsidian but without vaults:
double-click a `.md` file and it opens, with the folder around it in a sidebar.

![MRAkdown with a note on the left and a comparison with the last git commit on the right](assets/screenshot.png)

MRAkdown is a personal project, shared as-is: there's no promise of support, fixes or new features. It was made for
Windows first; the Linux version is newer and has only been tested on GNOME (Wayland).

## Features

- **Reading view in Obsidian style:** `[[wikilinks]]` (also to headings and with aliases), callouts, highlights, task
  lists, tables, footnotes, embedded images and syntax-highlighted code
- **Folder sidebar with search.** Opening a file shows its nearest `.obsidian` or `.git` folder, or else its own
  folder. Choose whether the sidebar lists Markdown files only, all files with a viewer, or all files.
- **Read, Edit and Split** (live preview) modes, with a formatting toolbar and image paste and drop
- **Tabs** with their own back/forward history; drag tabs to reorder them, into a new window, or onto another window
- **Two panes side by side**, each with its own tabs and mode: "Open to the side" from a file, link or tab menu, or
  drag a tab onto the right half of the window
- **Compare files** side by side, with changed lines and words highlighted and unchanged stretches folded: two files,
  or a file with its last git commit or any earlier commit
- **Other files open too**, with viewers for JSON, CSV/TSV, XML and plain text
- **Keeps each file's encoding** (UTF-8, UTF-16, Windows-1252) and line endings when saving
- **One running instance:** opening more files adds tabs to the open window
- Follows the system's light or dark theme, with your choice of accent colour

MRAkdown has no account and no telemetry; your files are only read and written on your own computer. Web links open in
your browser, and images that a note embeds from the web load as they would in a browser.

## Install

There are no ready-made downloads: build it from source as below. You need the
[.NET 10 SDK](https://dotnet.microsoft.com/download). Comparing with git commits also needs
[git](https://git-scm.com/), on the `PATH`.

### Windows

Needs the .NET 10 Desktop Runtime and the WebView2 Runtime (built into Windows 11; on Windows 10, install it from
Microsoft if it's missing).

```powershell
dotnet publish src\MRAkdown.Windows -c Release -o publish
```

This builds `publish\MRAkdown.exe`. To open Markdown files with it by double-clicking, choose it under "Open with" in
Explorer.

A single small `.exe` for sharing (without ReadyToRun, which crashes combined with single-file on installed .NET):

```powershell
dotnet publish src\MRAkdown.Windows -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:PublishReadyToRun=false -p:DebugType=none -o share
```

### Linux

Needs GTK 4, libadwaita and WebKitGTK 6.0. On Arch and CachyOS: `sudo pacman -S dotnet-sdk gtk4 libadwaita webkitgtk-6.0`.

```sh
packaging/linux/install.sh             # build and install for the current user (in ~/.local)
packaging/linux/install.sh --default   # ...and make it the default app for Markdown files
packaging/linux/install.sh --uninstall
```

MRAkdown is then in the app menu, and `mrakdown [file or folder]` starts it from a terminal (if `~/.local/bin` is on
your `PATH`). To update, close MRAkdown and run the install script again.

Differences from Windows:

- There is no separate title bar: drag the empty part of the top bar to move the window. Double, middle and right
  clicks there do what your desktop does for title bars, and the window buttons follow the desktop's button layout.
- Wayland doesn't tell apps where windows are, so dropping a tab onto another window relies on that window noticing
  the pointer entering it, and new windows open where the desktop puts them.
- If pages render blank or with glitches on NVIDIA graphics, try starting it with `WEBKIT_DISABLE_DMABUF_RENDERER=1`.

## Using it

### Panes and comparisons

- **Open to the side:** right-click a file in the sidebar, a link or a tab. Drag a tab onto the other pane to move it
  there; a pane closes with its last tab, and the divider between the panes can be dragged.
- **Compare two files:** right-click one and choose "Select for compare", then right-click the other and choose
  "Compare with …". With two panes open, a tab's menu can also compare it with the file in the other pane.
- **Compare with git:** "Compare with last commit", or "Compare with commit…" to pick from the commits that changed the
  file (renames are followed).
- Comparisons use the files as saved, and ignore differences in line endings alone.

A very large folder (over 50,000 files and folders, such as a home folder) is scanned as you open its subfolders, so
links and search then cover the folders opened so far. Links to folders (symlinks, junctions) aren't followed.

### Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl+N` / `Ctrl+Shift+N` | New file / new window |
| `Ctrl+O` / `Ctrl+Shift+O` | Open file / open folder |
| `Ctrl+S` | Save (asks where, for a new file) |
| `Ctrl+E` / `Ctrl+Shift+E` | Toggle Edit / Split mode |
| `Ctrl+P` | Search files |
| `Ctrl+T`, `Ctrl+W`, `Ctrl+Shift+T` | New, close, reopen tab |
| `Ctrl+Tab`, `Ctrl+Shift+Tab`, `Ctrl+PageDown`, `Ctrl+PageUp` | Next / previous tab |
| `Ctrl+1…8`, `Ctrl+9` | Go to that tab, to the last tab |
| `Alt+←` / `Alt+→`, mouse back / forward | Back / forward |
| `F5` or `Ctrl+R` | Reload the file and folder |
| `F7` / `Shift+F7` | Next / previous change, in a comparison |
| `Ctrl+\` | Show or hide the folder panel |
| `Ctrl+Shift+W` | Close the window |

Clicking a file or link opens it in the current tab. `Ctrl+click` or middle-click opens it in a background tab,
`Ctrl+Shift+click` in a new tab you switch to, and `Shift+click` in a new window.

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
| `assets/` | App icon (generated from `web/logo.svg` with `make-icon.ps1`) and the screenshot |

- Run the Linux version from the repo with `dotnet run --project src/MRAkdown.Linux -- [file or folder]`.
- `MRAKDOWN_DEVTOOLS=1` (Linux) enables Inspect Element in the page and prints its console messages.
- `MRAKDOWN_INSTANCE=name` starts a separate instance, e.g. to test next to an installed copy that is in use.

## License

MRAkdown is free software under the [GNU General Public License v3.0](LICENSE).

It uses [Markdig](https://github.com/xoofx/markdig) (BSD-2-Clause), [Gir.Core](https://gircore.github.io/) (MIT) and
the WebView2 SDK (BSD-3-Clause style, Microsoft), and includes [highlight.js](https://highlightjs.org/) 11.9.0
(BSD-3-Clause) in `web/hljs*`.
