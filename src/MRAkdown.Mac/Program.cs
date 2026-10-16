namespace MRAkdown;

static class Program
{
    static void Main(string[] args)
    {
        ObjC.LoadFrameworks();
        // AppKit, and everything that awaits, runs on the main thread.
        SynchronizationContext.SetSynchronizationContext(new MainThreadContext());

        // Apps started from Finder get a short PATH; add Homebrew's folders so git is found there too.
        var path = Environment.GetEnvironmentVariable("PATH") ?? "/usr/bin:/bin:/usr/sbin:/sbin";
        foreach (var folder in new[] { "/opt/homebrew/bin", "/usr/local/bin" })
        {
            if (!path.Split(':').Contains(folder)) path += ":" + folder;
        }
        Environment.SetEnvironmentVariable("PATH", path);

        MRAkdownApp? app = null;
        // Only existing paths: macOS may add arguments of its own.
        ObjC.Callback(() => app = new MRAkdownApp(args.Where(Path.Exists).Select(Path.GetFullPath).ToList()));
        app?.Run();
    }
}
