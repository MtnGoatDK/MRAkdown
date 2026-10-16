using System.Text;

namespace MRAkdown;

/// <summary>
/// Reads and writes text files in the encoding they already use, so editing never changes it:
/// a byte order mark (UTF-8, UTF-16) wins; otherwise valid UTF-8, otherwise Windows-1252
/// (common for older Western/Danish text files, e.g. æøå).
/// </summary>
static class TextFiles
{
    public const long MaxSize = 20 * 1024 * 1024;

    static readonly UTF8Encoding StrictUtf8 = new(false, throwOnInvalidBytes: true);

    static TextFiles() => Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

    public static Encoding Detect(byte[] bytes)
    {
        if (bytes.AsSpan().StartsWith((byte[])[0xEF, 0xBB, 0xBF])) return new UTF8Encoding(true);
        if (bytes.AsSpan().StartsWith((byte[])[0xFF, 0xFE])) return Encoding.Unicode;
        if (bytes.AsSpan().StartsWith((byte[])[0xFE, 0xFF])) return Encoding.BigEndianUnicode;
        try
        {
            StrictUtf8.GetCharCount(bytes);
            return new UTF8Encoding(false);
        }
        catch (DecoderFallbackException)
        {
            return Encoding.GetEncoding(1252);
        }
    }

    /// <summary>True for files that aren't text (contain NUL bytes and aren't UTF-16).</summary>
    public static bool IsBinary(byte[] bytes)
    {
        var enc = Detect(bytes);
        if (enc is UnicodeEncoding) return false;
        return bytes.AsSpan(0, Math.Min(bytes.Length, 8000)).Contains((byte)0);
    }

    public static string Decode(byte[] bytes)
    {
        var enc = Detect(bytes);
        var skip = bytes.AsSpan().StartsWith(enc.GetPreamble()) ? enc.GetPreamble().Length : 0;
        return enc.GetString(bytes, skip, bytes.Length - skip);
    }

    public static string Read(string path) => Decode(File.ReadAllBytes(path));

    /// <summary>Writes text in the file's current encoding (UTF-8 for new files).</summary>
    public static void Write(string path, string text)
    {
        Encoding enc = File.Exists(path) ? Detect(File.ReadAllBytes(path)) : new UTF8Encoding(false);
        // Windows-1252 can't hold every character (e.g. emoji); switch such files to UTF-8 rather than lose text.
        if (enc.CodePage == 1252 && enc.GetString(enc.GetBytes(text)) != text) enc = new UTF8Encoding(false);
        File.WriteAllText(path, text, enc);
    }
}
