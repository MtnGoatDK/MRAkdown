using System.IO.Pipes;
using System.Runtime.InteropServices;

namespace MRAkdown;

static class Program
{
    // One running MRAkdown per Windows user session. A second launch hands its file over this pipe.
    // MRAKDOWN_INSTANCE gives a separate instance (e.g. for testing next to a copy that's in use).
    static readonly string PipeName =
        $"MRAkdown-{Environment.UserName}-{System.Diagnostics.Process.GetCurrentProcess().SessionId}"
        + Environment.GetEnvironmentVariable("MRAKDOWN_INSTANCE");

    [STAThread]
    static void Main(string[] args)
    {
        var startPath = args.FirstOrDefault() is { Length: > 0 } arg ? Path.GetFullPath(arg) : null;

        using var mutex = new Mutex(true, PipeName, out var isFirst);
        if (!isFirst && TrySendToRunningInstance(startPath ?? "")) return;

        ApplicationConfiguration.Initialize();
        var app = new MRAkdownApp();
        if (isFirst) app.ListenForOtherInstances(PipeName);
        app.OpenPath(startPath);
        Application.Run(app);
    }

    static bool TrySendToRunningInstance(string path)
    {
        try
        {
            using var pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.Out, PipeOptions.CurrentUserOnly);
            pipe.Connect(2000);
            // We were just launched by the user, so we may pass on the right to take the foreground.
            AllowSetForegroundWindow(-1 /* ASFW_ANY */);
            using var writer = new StreamWriter(pipe);
            writer.WriteLine(path);
            return true;
        }
        catch (Exception ex) when (ex is TimeoutException or IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    [DllImport("user32.dll")]
    static extern bool AllowSetForegroundWindow(int processId);
}

/// <summary>Owns all windows; the app exits when the last one closes.</summary>
sealed class MRAkdownApp : ApplicationContext
{
    readonly List<MainForm> _windows = [];
    readonly Control _uiInvoker = new();
    MainForm? _lastActive;

    public MRAkdownApp() => _uiInvoker.CreateControl();

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
    public MainForm OpenWindow(NoteIndex? root, string? note, Rectangle? bounds = null)
    {
        var form = new MainForm(this, root, note);
        if (bounds is { } b)
        {
            form.StartPosition = FormStartPosition.Manual;
            form.Bounds = b;
        }
        _windows.Add(form);
        form.Activated += (_, _) => _lastActive = form;
        form.FormClosed += (_, _) =>
        {
            _windows.Remove(form);
            if (_lastActive == form) _lastActive = null;
            if (_windows.Count == 0) ExitThread();
        };
        form.Show();
        return form;
    }

    /// <summary>The topmost MRAkdown window at a screen point, other than <paramref name="except"/>.</summary>
    public MainForm? WindowAt(Point screenPoint, MainForm except)
    {
        var root = GetAncestor(WindowFromPoint(screenPoint), 2 /* GA_ROOT */);
        return _windows.FirstOrDefault(w => w != except && w.IsHandleCreated && w.Handle == root);
    }

    [DllImport("user32.dll")]
    static extern IntPtr WindowFromPoint(Point point);

    [DllImport("user32.dll")]
    static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);

    public void ListenForOtherInstances(string pipeName)
    {
        _ = Task.Run(async () =>
        {
            while (true)
            {
                try
                {
                    using var server = new NamedPipeServerStream(pipeName, PipeDirection.In,
                        NamedPipeServerStream.MaxAllowedServerInstances, PipeTransmissionMode.Byte,
                        PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                    await server.WaitForConnectionAsync();
                    using var reader = new StreamReader(server);
                    var path = await reader.ReadLineAsync() ?? "";
                    _uiInvoker.BeginInvoke(() => OnOtherInstance(path));
                }
                catch (IOException)
                {
                    await Task.Delay(100);
                }
            }
        });
    }

    /// <summary>A second launch: open its file as a tab in the most recently used window.</summary>
    void OnOtherInstance(string path)
    {
        var target = _lastActive ?? _windows.LastOrDefault();
        if (target is null || path.Length == 0)
        {
            OpenPath(path.Length == 0 ? null : path);
            return;
        }
        if (File.Exists(path)) target.OpenFileInTab(path);
        else if (Directory.Exists(path)) target.OpenFolderInTab(Roots.Get(path));
    }
}
