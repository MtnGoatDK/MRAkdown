# MRAkdown

A lightweight Markdown note viewer and editor for Windows, in the spirit of Obsidian but without vaults:
double-click a `.md` file and it opens, with the folder around it in a sidebar.

Built with .NET 10 (WinForms), WebView2 and [Markdig](https://github.com/xoofx/markdig).

## Features

- Obsidian-style reading view: `[[wikilinks]]`, callouts, highlights, task lists, tables, embedded images
- Folder sidebar with search; the nearest `.obsidian` or `.git` folder is used as the root
- Read, Edit and Split (live preview) modes, with a formatting toolbar and image paste/drop
- Tabs with per-tab history; drag tabs to reorder, into a new window, or onto another window
- One running instance: opening more files adds tabs to the open window
- New notes with Save As; any other file opens as text, with JSON, CSV/TSV, XML and text viewers
- Keeps file encodings (UTF-8, UTF-16, Windows-1252) and line endings when saving
- Follows the Windows light/dark theme; choose your own accent colour

## Build

```powershell
dotnet publish -c Release -o publish
```

`publish\MRAkdown.exe` needs the .NET 10 Desktop Runtime and the WebView2 Runtime (built into Windows 11).

A single small exe for sharing (no ReadyToRun: it crashes combined with single-file on installed .NET):

```powershell
dotnet publish -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:PublishReadyToRun=false -p:DebugType=none -o share
```

The app icon is generated from `web/logo.svg` with `assets/make-icon.ps1`.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl+N` / `Ctrl+Shift+N` | New note / new window |
| `Ctrl+O` / `Ctrl+Shift+O` | Open file / open folder |
| `Ctrl+S` | Save (asks where, for a new note) |
| `Ctrl+E` / `Ctrl+Shift+E` | Toggle Edit / Split mode |
| `Ctrl+P` | Search notes |
| `Ctrl+T`, `Ctrl+W`, `Ctrl+Shift+T` | New, close, reopen tab |
| `Ctrl+Tab`, `Ctrl+1…9` | Switch tabs |
| `Alt+←` / `Alt+→` | Back / forward |
| `Ctrl+\` | Show or hide the folder panel |

Click opens in the current tab; `Ctrl+click` or middle-click opens a background tab, `Shift+click` a new window.

## Third-party code

`web/hljs*` is [highlight.js](https://highlightjs.org/) 11.9.0 (BSD-3-Clause).
