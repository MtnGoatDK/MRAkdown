using System.ComponentModel;
using System.Diagnostics;

namespace MRAkdown;

/// <summary>Reads a file as it is in git's last commit (HEAD), for comparing with the file now.</summary>
static class GitFiles
{
    /// <summary>Thrown with a message for people when git's version of a file can't be read.</summary>
    public sealed class GitException(string message) : Exception(message);

    public static async Task<string> ReadHeadAsync(string file)
    {
        var start = new ProcessStartInfo("git")
        {
            // Run in the file's folder, so "HEAD:./name" is the file in whichever repository holds it.
            WorkingDirectory = Path.GetDirectoryName(file)!,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var arg in new[] { "cat-file", "blob", "HEAD:./" + Path.GetFileName(file) }) start.ArgumentList.Add(arg);

        Process process;
        try
        {
            process = Process.Start(start) ?? throw new GitException("Git couldn't be started.");
        }
        catch (Win32Exception)
        {
            throw new GitException("Git isn't installed, or isn't on the PATH.");
        }

        using (process)
        {
            using var output = new MemoryStream();
            var readOutput = process.StandardOutput.BaseStream.CopyToAsync(output);
            var readError = process.StandardError.ReadToEndAsync();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            try
            {
                await process.WaitForExitAsync(timeout.Token);
            }
            catch (OperationCanceledException)
            {
                process.Kill(entireProcessTree: true);
                throw new GitException("Git took too long to answer.");
            }
            await readOutput;
            var error = await readError;
            if (process.ExitCode != 0) throw new GitException(Explain(error));

            var bytes = output.ToArray();
            if (TextFiles.IsBinary(bytes)) throw new GitException("The committed version isn't a text file.");
            return TextFiles.Decode(bytes);
        }
    }

    /// <summary>Git's error, in words that say what it means for this comparison.</summary>
    static string Explain(string error)
    {
        if (error.Contains("not a git repository", StringComparison.OrdinalIgnoreCase))
            return "This file isn't in a git repository.";
        if (error.Contains("exists on disk, but not in", StringComparison.OrdinalIgnoreCase)
            || error.Contains("does not exist in", StringComparison.OrdinalIgnoreCase))
            return "This file isn't in the last commit yet.";
        if (error.Contains("invalid object name 'HEAD'", StringComparison.OrdinalIgnoreCase)
            || error.Contains("Not a valid object name HEAD", StringComparison.OrdinalIgnoreCase))
            return "The repository has no commits yet.";
        if (error.Contains("dubious ownership", StringComparison.OrdinalIgnoreCase))
            return "Git doesn't trust this repository's folder (it belongs to another user). " + error.Trim();
        return error.Trim() is { Length: > 0 } message ? message : "Git couldn't read the committed version.";
    }
}
