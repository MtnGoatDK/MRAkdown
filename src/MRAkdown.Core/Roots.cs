using System.Security.Cryptography;
using System.Text;

namespace MRAkdown;

/// <summary>
/// Process-wide registry of open note folders. Each folder gets one <see cref="NoteIndex"/>
/// and one file watcher, shared by every window and tab that shows it.
/// Must be used from the UI thread.
/// </summary>
static class Roots
{
    // Create: without it, a missing folder (e.g. no ~/.local/share yet on a new Linux account) gives "", and the
    // settings would land in whatever folder MRAkdown was started from.
    public static readonly string DataDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData, Environment.SpecialFolderOption.Create), "MRAkdown");
    static readonly string LastRootFile = Path.Combine(DataDir, "last-folder.txt");

    static readonly Dictionary<string, NoteIndex> ById = new();

    /// <summary>Raised on the UI thread after a folder's index was rebuilt because files changed.</summary>
    public static event Action<NoteIndex>? Changed;

    public static NoteIndex Get(string folder)
    {
        var full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(folder));
        var id = IdFor(full);
        if (!ById.TryGetValue(id, out var index))
        {
            index = new NoteIndex(full, id);
            ById[id] = index;
            Watch(index);
        }
        SaveLastRoot(full);
        return index;
    }

    public static NoteIndex? Find(string? id) => id is not null ? ById.GetValueOrDefault(id) : null;

    /// <summary>The folder to use for a file: its nearest Obsidian vault or git repo, else its own folder.</summary>
    public static NoteIndex ForFile(string file)
    {
        var dir = Path.GetDirectoryName(Path.GetFullPath(file))!;
        for (var d = new DirectoryInfo(dir); d is not null; d = d.Parent)
        {
            if (Path.Exists(Path.Combine(d.FullName, ".obsidian")) || Path.Exists(Path.Combine(d.FullName, ".git")))
                return Get(d.FullName);
        }
        return Get(dir);
    }

    /// <summary>
    /// First save of a new note, to the file the user chose: writes it and returns where it ended up
    /// ({ root, rootName, path }) for the page. Throws IOException or UnauthorizedAccessException if it can't be written.
    /// </summary>
    /// <param name="root">The folder the note was created in; it stays there if saved inside it.</param>
    public static object SaveNewNote(NoteIndex? root, string file, string text)
    {
        file = Path.GetFullPath(file);
        if (!NoteIndex.IsMarkdown(file)) file += ".md";
        File.WriteAllText(file, text, new UTF8Encoding(false));

        // Keep it in the current folder if it was saved inside it; otherwise open its own folder.
        var target = root is not null && file.StartsWith(root.Root + Path.DirectorySeparatorChar, NoteIndex.PathComparison)
            ? root
            : ForFile(file);
        return new { root = target.Id, rootName = target.Name, path = target.Rel(file) };
    }

    public static string? ReadLastRoot()
    {
        try
        {
            var path = File.ReadAllText(LastRootFile).Trim();
            return Directory.Exists(path) ? path : null;
        }
        catch (IOException) { return null; }
    }

    static void SaveLastRoot(string root)
    {
        try
        {
            Directory.CreateDirectory(DataDir);
            File.WriteAllText(LastRootFile, root);
        }
        catch (IOException) { }
    }

    // Paths are case-insensitive on Windows only; on Linux, Notes and notes are different folders.
    static string IdFor(string fullPath) =>
        Convert.ToHexStringLower(SHA1.HashData(Encoding.UTF8.GetBytes(
            OperatingSystem.IsWindows() ? fullPath.ToLowerInvariant() : fullPath)))[..10];

    // The watchers, kept referenced: a FileSystemWatcher that nothing refers to can be garbage collected, and then it
    // silently stops reporting changes (the sidebar stopped updating after the first change).
    static readonly List<FileSystemWatcher> Watchers = [];

    static async void Watch(NoteIndex index)
    {
        var ui = SynchronizationContext.Current ?? throw new InvalidOperationException("Roots must be used on the UI thread");
        // Rebuild once changes have settled for 250 ms; each change restarts the wait.
        var generation = 0;
        async void Debounce()
        {
            var mine = ++generation;
            await Task.Delay(250);
            if (mine != generation) return;
            await index.Rebuild();
            Changed?.Invoke(index);
        }

        FileSystemEventHandler onChange = (_, e) =>
        {
            // Ignore churn inside .git, .obsidian etc.
            if (Path.GetRelativePath(index.Root, e.FullPath).Split('\\', '/').Any(s => s.StartsWith('.'))) return;
            ui.Post(_ => Debounce(), null);
        };
        var watched = new HashSet<string>();
        void Start(string rel, bool subfolders)
        {
            var folder = rel.Length == 0 ? index.Root : index.FullPath(rel);
            if (folder is null || !watched.Add(rel)) return;
            var watcher = new FileSystemWatcher(folder)
            {
                IncludeSubdirectories = subfolders,
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite,
            };
            watcher.Changed += onChange;
            watcher.Created += onChange;
            watcher.Deleted += onChange;
            watcher.Renamed += (s, e) => onChange(s, e);
            lock (Watchers) Watchers.Add(watcher);
            // Starting it adds a watch for every subfolder, which takes seconds for a big folder on Linux: not on the UI thread.
            _ = Task.Run(() => watcher.EnableRaisingEvents = true);
        }

        // A partial index (a very large folder) only watches the folders it has scanned, not everything below them.
        index.FolderOpened += rel => Start(rel, false);
        await index.FirstScan;
        if (!index.IsPartial)
        {
            Start("", true);
            return;
        }
        foreach (var rel in index.OpenFolders.ToList()) Start(rel, false);
    }
}
