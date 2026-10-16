using System.Runtime.InteropServices;
using static MRAkdown.ObjC;

namespace MRAkdown;

/// <summary>
/// Owns all windows; the app quits when the last one closes. macOS runs one copy of the app, and hands it the files
/// opened from Finder or with "open -a MRAkdown" while it runs.
/// </summary>
sealed unsafe class MRAkdownApp
{
    const int NSApplicationActivationPolicyRegular = 0;
    const int NSTerminateCancel = 0, NSTerminateNow = 1;

    static MRAkdownApp? s_app;

    readonly IntPtr _nsApp;
    readonly List<MainWindow> _windows = [];
    readonly List<string> _startPaths;
    MainWindow? _lastActive;
    CGPoint? _cascade;

    /// <param name="startPaths">Files and folders from the command line.</param>
    public MRAkdownApp(List<string> startPaths)
    {
        s_app = this;
        _startPaths = startPaths;
        _nsApp = Send(Class("NSApplication"), "sharedApplication");
        // A Dock icon and menu bar also when started from a terminal rather than as MRAkdown.app.
        Send(_nsApp, "setActivationPolicy:", NSApplicationActivationPolicyRegular);

        var delegateClass = DefineClass("MRAkdownAppDelegate", "NSObject", ["NSApplicationDelegate"],
            ("applicationDidFinishLaunching:", (IntPtr)(delegate* unmanaged<IntPtr, IntPtr, IntPtr, void>)&DidFinishLaunching, "v@:@"),
            ("application:openURLs:", (IntPtr)(delegate* unmanaged<IntPtr, IntPtr, IntPtr, IntPtr, void>)&OpenUrls, "v@:@@"),
            ("applicationShouldTerminate:", (IntPtr)(delegate* unmanaged<IntPtr, IntPtr, IntPtr, nint>)&ShouldTerminate, "Q@:@"),
            ("applicationShouldTerminateAfterLastWindowClosed:",
                (IntPtr)(delegate* unmanaged<IntPtr, IntPtr, IntPtr, byte>)&ShouldTerminateAfterLastWindowClosed, "c@:@"));
        Send(_nsApp, "setDelegate:", Send(Send(delegateClass, "alloc"), "init"));
        Send(_nsApp, "setMainMenu:", MainMenu.Create());
    }

    public void Run() => Send(_nsApp, "run");

    [UnmanagedCallersOnly]
    static void DidFinishLaunching(IntPtr self, IntPtr sel, IntPtr notification) => Callback(() =>
    {
        var app = s_app!;
        Send(app._nsApp, "activateIgnoringOtherApps:", 1);
        foreach (var path in app._startPaths) app.OnOpenPath(path);
        // Started without files (Finder opens files before launching finishes): a window for the last folder.
        if (app._windows.Count == 0) app.OpenPath(null);
    });

    /// <summary>Files and folders opened from Finder, the Dock or "open", at launch or while running.</summary>
    [UnmanagedCallersOnly]
    static void OpenUrls(IntPtr self, IntPtr sel, IntPtr application, IntPtr urls) => Callback(() =>
    {
        foreach (var url in Items(urls))
        {
            if (SendBool(url, "isFileURL") && FromNSString(Send(url, "path")) is { } path) s_app!.OnOpenPath(path);
        }
    });

    /// <summary>Quitting: windows with unsaved edits save them first (and may be cancelled); the app quits with the last.</summary>
    [UnmanagedCallersOnly]
    static nint ShouldTerminate(IntPtr self, IntPtr sel, IntPtr application) => Callback(() =>
    {
        var app = s_app!;
        if (!app._windows.Any(w => w.HasUnsavedEdits)) return NSTerminateNow;
        foreach (var window in app._windows.ToList()) window.Close();
        return app._windows.Count == 0 ? NSTerminateNow : NSTerminateCancel;
    }, NSTerminateNow);

    [UnmanagedCallersOnly]
    static byte ShouldTerminateAfterLastWindowClosed(IntPtr self, IntPtr sel, IntPtr application) => 1;

    /// <summary>A file or folder to open: as a tab in the most recently used window, or a new window if there is none.</summary>
    void OnOpenPath(string path)
    {
        var target = _lastActive ?? _windows.LastOrDefault();
        if (target is null) OpenPath(path);
        else if (File.Exists(path)) target.OpenFileInTab(path);
        else if (Directory.Exists(path)) target.OpenFolderInTab(Roots.Get(path));
    }

    /// <summary>Opens a file or folder (or the last folder, when null) in a new window.</summary>
    public void OpenPath(string? path)
    {
        if (path is not null && File.Exists(path))
        {
            var root = Roots.ForFile(path);
            OpenWindow(root, root.Rel(path));
        }
        else if (path is not null && Directory.Exists(path))
        {
            OpenWindow(Roots.Get(path), null);
        }
        else
        {
            OpenWindow(Roots.ReadLastRoot() is { } last ? Roots.Get(last) : null, null);
        }
    }

    /// <param name="root">Folder to show; null asks the user to pick one.</param>
    /// <param name="size">Size for the new window's content.</param>
    public MainWindow OpenWindow(NoteIndex? root, string? note, CGSize? size = null)
    {
        var window = new MainWindow(this, root, note, size ?? new CGSize(1200, 800));
        _windows.Add(window);
        window.Activated += () => _lastActive = window;
        window.Closed += () =>
        {
            _windows.Remove(window);
            if (_lastActive == window) _lastActive = null;
        };

        // Each new window a step down and to the right of the one before.
        if (_cascade is null)
        {
            Send(window.Window, "center");
            var frame = SendRect(window.Window, "frame");
            _cascade = new CGPoint(frame.Origin.X, frame.Origin.Y + frame.Size.Height);
        }
        _cascade = SendPoint(window.Window, "cascadeTopLeftFromPoint:", _cascade.Value);
        window.Present();
        _ = window.InitAsync();
        return window;
    }

    /// <summary>The MRAkdown window the pointer is over, other than <paramref name="except"/>.</summary>
    public MainWindow? WindowUnderPointer(MainWindow except)
    {
        var number = Send(Class("NSWindow"), "windowNumberAtPoint:belowWindowWithWindowNumber:",
            SendPoint(Class("NSEvent"), "mouseLocation"), 0);
        return _windows.FirstOrDefault(w => w != except && w.WindowNumber == number);
    }
}

/// <summary>
/// The menu bar. The page handles its own shortcuts first (⌘ works as Ctrl there); the menus provide the standard
/// macOS ones it leaves alone, such as ⌘Q, ⌘H, ⌘M and copy and paste.
/// </summary>
static class MainMenu
{
    const int Command = 1 << 20, Option = 1 << 19;

    public static IntPtr Create()
    {
        var bar = New("NSMenu");

        var app = Submenu(bar, "MRAkdown");
        Item(app, "About MRAkdown", "orderFrontStandardAboutPanel:");
        Separator(app);
        Item(app, "Hide MRAkdown", "hide:", "h");
        Item(app, "Hide Others", "hideOtherApplications:", "h", Command | Option);
        Item(app, "Show All", "unhideAllApplications:");
        Separator(app);
        Item(app, "Quit MRAkdown", "terminate:", "q");

        var edit = Submenu(bar, "Edit");
        Item(edit, "Undo", "undo:", "z");
        Item(edit, "Redo", "redo:", "Z");
        Separator(edit);
        Item(edit, "Cut", "cut:", "x");
        Item(edit, "Copy", "copy:", "c");
        Item(edit, "Paste", "paste:", "v");
        Item(edit, "Select All", "selectAll:", "a");

        var window = Submenu(bar, "Window");
        Item(window, "Minimize", "performMiniaturize:", "m");
        Item(window, "Zoom", "performZoom:");
        Separator(window);
        Item(window, "Bring All to Front", "arrangeInFront:");
        Send(Send(Class("NSApplication"), "sharedApplication"), "setWindowsMenu:", window);

        return bar;
    }

    static IntPtr Submenu(IntPtr bar, string title)
    {
        var menu = Send(Send(Class("NSMenu"), "alloc"), "initWithTitle:", NSString(title));
        var item = Send(Send(Class("NSMenuItem"), "alloc"), "initWithTitle:action:keyEquivalent:", NSString(title), 0, NSString(""));
        Send(item, "setSubmenu:", menu);
        Send(bar, "addItem:", item);
        Send(item, "release");
        Send(menu, "release");
        return menu;
    }

    /// <param name="key">Key with ⌘ (an upper-case letter adds ⇧), or "" for none.</param>
    static void Item(IntPtr menu, string title, string action, string key = "", int modifiers = Command)
    {
        var item = Send(Send(Class("NSMenuItem"), "alloc"), "initWithTitle:action:keyEquivalent:",
            NSString(title), Sel(action), NSString(key));
        if (key.Length > 0) Send(item, "setKeyEquivalentModifierMask:", modifiers);
        Send(menu, "addItem:", item);
        Send(item, "release");
    }

    static void Separator(IntPtr menu) => Send(menu, "addItem:", Send(Class("NSMenuItem"), "separatorItem"));
}
