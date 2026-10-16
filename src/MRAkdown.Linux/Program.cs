namespace MRAkdown;

static class Program
{
    // One running MRAkdown per user session: GApplication makes a second launch hand its files to the
    // running one over D-Bus. MRAKDOWN_INSTANCE gives a separate instance (e.g. for testing next to a copy that's in use).
    public const string AppId = "io.github.mtngoatdk.MRAkdown";

    static int Main(string[] args)
    {
        Adw.Module.Initialize();
        WebKit.Module.Initialize();

        var instance = new string((Environment.GetEnvironmentVariable("MRAKDOWN_INSTANCE") ?? "").Where(char.IsAsciiLetterOrDigit).ToArray());
        var app = new MRAkdownApp(instance.Length > 0 ? $"{AppId}.Instance{instance}" : AppId);
        return app.Run([Environment.GetCommandLineArgs()[0], .. args]);
    }
}
