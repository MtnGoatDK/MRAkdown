#!/bin/sh
# Builds MRAkdown and installs it for the current user (no root needed):
#   ~/.local/lib/mrakdown/          the app
#   ~/.local/bin/mrakdown           command to start it
#   ~/.local/share/applications/    menu entry, which also lets file managers open .md files with it
#   ~/.local/share/icons/hicolor/   app icon
#
# Usage: packaging/linux/install.sh [--default]   (--default: make MRAkdown the default app for .md files)
#        packaging/linux/install.sh --uninstall
set -eu

APP_ID=io.github.mtngoatdk.MRAkdown
REPO=$(cd "$(dirname "$0")/../.." && pwd)
DATA=${XDG_DATA_HOME:-$HOME/.local/share}
LIB=$HOME/.local/lib/mrakdown
BIN=$HOME/.local/bin
DESKTOP=$DATA/applications/$APP_ID.desktop
ICON=$DATA/icons/hicolor/scalable/apps/$APP_ID.svg

refresh() {
    update-desktop-database -q "$DATA/applications" 2>/dev/null || true
    gtk-update-icon-cache -q -t "$DATA/icons/hicolor" 2>/dev/null || true
}

if [ "${1:-}" = "--uninstall" ]; then
    rm -rf "$LIB"
    rm -f "$BIN/mrakdown" "$DESKTOP" "$ICON"
    refresh
    echo "MRAkdown uninstalled. Settings are kept in $DATA/MRAkdown."
    exit 0
fi

rm -rf "$LIB"
dotnet publish "$REPO/src/MRAkdown.Linux" -c Release -o "$LIB"

mkdir -p "$BIN" "$(dirname "$DESKTOP")" "$(dirname "$ICON")"
ln -sf "$LIB/mrakdown" "$BIN/mrakdown"
sed "s|@EXEC@|$LIB/mrakdown|" "$REPO/packaging/linux/$APP_ID.desktop" > "$DESKTOP"
cp "$REPO/web/logo.svg" "$ICON"
refresh

if [ "${1:-}" = "--default" ]; then
    xdg-mime default "$APP_ID.desktop" text/markdown
    echo "MRAkdown is now the default app for Markdown files."
fi
echo "MRAkdown installed. Start it from the app menu, or run: mrakdown [file or folder]"
