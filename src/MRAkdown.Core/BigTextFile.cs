using System.Text;
using System.Text.Json;

namespace MRAkdown;

/// <summary>
/// Text files too large to load whole (over <see cref="TextFiles.MaxSize"/>), such as big logs, for reading: the
/// file stays on disk, an index records where every <see cref="Step"/>th line starts, and the page asks for the
/// lines it shows (see textViewer in viewers.js). A file that grows (a log being written) is indexed further from
/// where it ended. UTF-8 and single-byte files only (a line break is the byte 0x0A in those).
/// </summary>
static class BigTextFile
{
    public const int Step = 200;

    sealed class Index
    {
        public required Encoding Encoding;
        public readonly List<long> Starts = [0]; // where lines 0, Step, 2 * Step, ... start
        public long Scanned;  // bytes indexed
        public long Breaks;   // line breaks in them
        public DateTime Written;
        public long Length;
    }

    static readonly Dictionary<string, Index> Cache = new(StringComparer.Ordinal);

    static FileStream Open(string full) =>
        new(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16);

    /// <summary>False for files this can't show (UTF-16 has two-byte line breaks).</summary>
    public static bool CanShow(string full)
    {
        using var file = Open(full);
        var head = new byte[2];
        return file.Read(head) < 2 || !((head[0] == 0xFF && head[1] == 0xFE) || (head[0] == 0xFE && head[1] == 0xFF));
    }

    /// <summary>The index of a file, made or brought up to date (only the part added since, if it grew).</summary>
    static Index Get(string full)
    {
        var info = new FileInfo(full);
        Index? index;
        lock (Cache) Cache.TryGetValue(full, out index);
        // Rebuilt if the file got shorter or changed without growing (not just appended to)
        if (index is null || info.Length < index.Length || (info.Length == index.Length && info.LastWriteTimeUtc != index.Written))
        {
            index = new Index { Encoding = DetectEncoding(full) };
        }
        lock (index)
        {
            if (index.Scanned < info.Length) Scan(full, index);
            index.Length = info.Length;
            index.Written = info.LastWriteTimeUtc;
        }
        lock (Cache) Cache[full] = index;
        return index;
    }

    static Encoding DetectEncoding(string full)
    {
        using var file = Open(full);
        var head = new byte[64 * 1024];
        var read = file.Read(head);
        // A cut at the end of the sample may split a character: decide on what's before the last line break
        var end = Array.LastIndexOf(head, (byte)'\n', Math.Max(0, read - 1));
        return TextFiles.Detect(head[..(end > 0 ? end : read)]);
    }

    static void Scan(string full, Index index)
    {
        using var file = Open(full);
        file.Position = index.Scanned;
        var buffer = new byte[4 * 1024 * 1024];
        int read;
        while ((read = file.Read(buffer)) > 0)
        {
            var span = buffer.AsSpan(0, read);
            for (int at = span.IndexOf((byte)'\n'), offset = 0; at >= 0; at = span[offset..].IndexOf((byte)'\n'))
            {
                offset += at + 1;
                index.Breaks++;
                if (index.Breaks % Step == 0) index.Starts.Add(index.Scanned + offset);
                if (offset >= span.Length) break;
            }
            index.Scanned += read;
        }
    }

    /// <summary>
    /// The page's view of the file: its size, line count, and where every Step-th line starts (for estimating how
    /// tall blocks of lines are before they're loaded).
    /// </summary>
    public static string IndexJson(string full)
    {
        var index = Get(full);
        long lines;
        lock (index) lines = CountLines(full, index);
        List<long> starts;
        lock (index) starts = [.. index.Starts];
        return JsonSerializer.Serialize(new { size = index.Length, lines, step = Step, starts });
    }

    static long CountLines(string full, Index index)
    {
        if (index.Scanned == 0) return 0;
        // The last byte decides whether a last line without a line break follows the last break
        using var file = Open(full);
        file.Position = index.Scanned - 1;
        return index.Breaks + (file.ReadByte() == '\n' ? 0 : 1);
    }

    /// <summary>Lines from..from+count-1 (0-based) as text, one per line ("\r" removed), decoded as the file is.</summary>
    public static string Lines(string full, long from, int count)
    {
        var index = Get(full);
        long start;
        Encoding encoding;
        lock (index)
        {
            var slot = (int)Math.Min(from / Step, index.Starts.Count - 1);
            start = index.Starts[slot];
            from -= (long)slot * Step; // lines to skip from there
            encoding = index.Encoding;
        }
        using var file = Open(full);
        file.Position = start;
        var bytes = new MemoryStream();
        var buffer = new byte[256 * 1024];
        long skipped = 0, taken = 0;
        int read;
        while (taken < count && (read = file.Read(buffer)) > 0)
        {
            var span = buffer.AsSpan(0, read);
            var begin = 0;
            for (var at = 0; at < span.Length && taken < count; at++)
            {
                if (span[at] != '\n') continue;
                if (skipped < from) { skipped++; begin = at + 1; continue; }
                bytes.Write(span[begin..(at + 1)]);
                begin = at + 1;
                taken++;
            }
            if (skipped >= from && taken < count && begin < span.Length) bytes.Write(span[begin..]);
        }
        var text = encoding.GetString(bytes.GetBuffer(), 0, (int)bytes.Length).Replace("\r\n", "\n");
        return text.EndsWith('\n') ? text[..^1] : text;
    }
}
