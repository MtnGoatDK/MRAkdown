#!/bin/sh
# Builds MRAkdown.app and installs it for the current user (no admin rights needed), in ~/Applications.
#
# Usage: packaging/macos/install.sh               build and install (or update: quit MRAkdown first)
#        packaging/macos/install.sh --uninstall   keeps your settings
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)
APP=$HOME/Applications/MRAkdown.app
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

if [ "${1:-}" = "--uninstall" ]; then
    "$LSREGISTER" -u "$APP" 2>/dev/null || true
    rm -rf "$APP"
    echo "MRAkdown uninstalled. Settings are kept in ~/Library/Application Support/MRAkdown."
    exit 0
fi

BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT
dotnet publish "$REPO/src/MRAkdown.Mac" -c Release -o "$BUILD/publish"

# The bundle: the published files (the mrakdown executable and the .NET runtime) in Contents/MacOS.
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp -R "$BUILD/publish/." "$APP/Contents/MacOS/"
cp "$REPO/packaging/macos/Info.plist" "$APP/Contents/"
cp "$REPO/assets/MRAkdown.icns" "$APP/Contents/Resources/"

# Sign it for this Mac only ("ad hoc"), which Apple silicon requires of the code it runs: each file, then the bundle.
find "$APP/Contents/MacOS" -type f -exec codesign --force --sign - {} \;
codesign --force --sign - "$APP"
"$LSREGISTER" -f "$APP"

echo "MRAkdown installed in $APP. Open files with it from Finder, or run: open -a MRAkdown [file or folder]"
