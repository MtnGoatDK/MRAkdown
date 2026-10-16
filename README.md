# MRAkdown

A lightweight Markdown viewer and editor for Windows and Linux, in the spirit of Obsidian but without vaults:
double-click a `.md` file and it opens, with the folder around it in a sidebar.

Built with .NET 10 and [Markdig](https://github.com/xoofx/markdig). The UI is a web page (`web/`) shown by a small native
host: WinForms + WebView2 on Windows, GTK 4 + libadwaita + WebKitGTK (through [Gir.Core](https://gircore.github.io/)) on Linux.

## Features

- Obsidian-style reading view: `[[wikilinks]]`, callouts, highlights, task lists, tables, embedded images
- Folder sidebar with search; the nearest `.obsidian` or `.git` folder is used as the root
- Read, Edit and Split (live preview) modes, with a formatting toolbar and image paste/drop
- Tabs with per-tab history; drag tabs to reorder, into a new window, or onto another window
- One running instance: opening more files adds tabs to the open window
- New files with Save As; any other file opens as text, with JSON, CSV/TSV, XML and text viewers
- Keeps file encodings (UTF-8, UTF-16, Windows-1252) and line endings when saving
- Follows the system light/dark theme; choose your own accent colour

## Project layout

| Folder | What |
|---|---|
| `src/MRAkdown.Core` | Note index, Markdown rendering, wikilinks, file encodings, and serving the page (`NoteServer`) |
| `src/MRAkdown.Windows` | Windows host: WinForms window with WebView2 |
| `src/MRAkdown.Linux` | Linux host: libadwaita window with WebKitGTK; the page is served under `mrakdown://notes/` |
| `web/` | The page itself, shared by both hosts (embedded in Core) |
| `packaging/linux` | Desktop entry and per-user install script |

## Build on Windows

```powershell
dotnet publish src\MRAkdown.Windows -c Release -o publish
```

`publish\MRAkdown.exe` needs the .NET 10 Desktop Runtime and the WebView2 Runtime (built into Windows 11).

A single small exe for sharing (no ReadyToRun: it crashes combined with single-file on installed .NET):

```powershell
dotnet publish src\MRAkdown.Windows -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:PublishReadyToRun=false -p:DebugType=none -o share
```

The app icon is generated from `web/logo.svg` with `assets/make-icon.ps1`.

## Build on Linux

Needs the .NET 10 SDK, GTK 4, libadwaita and WebKitGTK 6.0 (on Arch/CachyOS: `dotnet-sdk gtk4 libadwaita webkitgtk-6.0`).

```sh
packaging/linux/install.sh            # build and install for the current user (~/.local)
packaging/linux/install.sh --default  # ...and make it the default app for .md files
packaging/linux/install.sh --uninstall
```

Or run it from the repo: `dotnet run --project src/MRAkdown.Linux -- [file or folder]`.
`MRAKDOWN_DEVTOOLS=1` enables Inspect Element and prints the page's console messages.

Differences from Windows:

- Wayland doesn't tell apps where windows are, so dropping a tab onto another window relies on that window noticing
  the pointer entering it, and new windows open where the desktop puts them.
- There is no separate title bar: drag the empty part of the top bar to move the window. Double, middle and right
  clicks there do what your desktop does for title bars, and the window buttons follow its button layout.
- If pages render blank or with glitches on NVIDIA, try `WEBKIT_DISABLE_DMABUF_RENDERER=1`.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl+N` / `Ctrl+Shift+N` | New file / new window |
| `Ctrl+O` / `Ctrl+Shift+O` | Open file / open folder |
| `Ctrl+S` | Save (asks where, for a new file) |
| `Ctrl+E` / `Ctrl+Shift+E` | Toggle Edit / Split mode |
| `Ctrl+P` | Search files |
| `Ctrl+T`, `Ctrl+W`, `Ctrl+Shift+T` | New, close, reopen tab |
| `Ctrl+Tab`, `Ctrl+1…9` | Switch tabs |
| `Alt+←` / `Alt+→` | Back / forward |
| `Ctrl+\` | Show or hide the folder panel |

Click opens in the current tab; `Ctrl+click` or middle-click opens a background tab, `Shift+click` a new window.

## Third-party code

`web/hljs*` is [highlight.js](https://highlightjs.org/) 11.9.0 (BSD-3-Clause).
