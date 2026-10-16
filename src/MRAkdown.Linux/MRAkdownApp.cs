namespace MRAkdown;

/// <summary>Owns all windows; the app exits when the last one closes.</summary>
sealed class MRAkdownApp
{
    readonly List<MainWindow> _windows = [];
    MainWindow? _lastActive;

    public Adw.Application Application { get; }

    public MRAkdownApp(string appId)
    {
        Application = Adw.Application.New(appId, Gio.ApplicationFlags.HandlesOpen);
        Application.OnStartup += (_, _) => WebHost.Initialize();
        // Started (or started again) without files: a window for the last folder.
        Application.OnActivate += (_, _) => OpenPath(null);
        // Files and folders from the command line or the file manager, from this launch or a later one.
        Application.OnOpen += (_, e) =>
        {
            foreach (var path in e.Files.Select(f => f.GetPath()).OfType<string>()) OnOpenPath(path);
        };
    }

    public int Run(string[] args) => Application.RunWithSynchronizationContext(args);

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
    /// <param name="size">Size for the new window. Wayland doesn't let apps choose where it goes.</param>
    public MainWindow OpenWindow(NoteIndex? root, string? note, (int Width, int Height)? size = null)
    {
        var window = new MainWindow(this, root, note);
        if (size is { } s) window.Window.SetDefaultSize(s.Width, s.Height);
        _windows.Add(window);
        Gtk.Window.IsActivePropertyDefinition.Notify(window.Window, (_, _) =>
        {
            if (window.Window.IsActive) _lastActive = window;
        }, false);
        window.Window.OnDestroy += (_, _) =>
        {
            _windows.Remove(window);
            if (_lastActive == window) _lastActive = null;
        };
        window.Window.Present();
        return window;
    }

    /// <summary>
    /// The MRAkdown window the pointer is over, other than <paramref name="except"/>. Wayland gives apps no
    /// global pointer position, so each window tracks whether the pointer is inside it.
    /// </summary>
    public MainWindow? WindowUnderPointer(MainWindow except) =>
        _windows.LastOrDefault(w => w != except && w.ContainsPointer);
}
