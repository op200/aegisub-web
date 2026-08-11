using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace AegisubWebView;

public sealed class MainForm : Form
{
    private readonly WebView2 browser = new() { Dock = DockStyle.Fill };
    private readonly Dictionary<string, string> files = [];

    public MainForm()
    {
        Text = "Aegisub Web";
        Width = 1440;
        Height = 900;
        MinimumSize = new Size(900, 650);
        Controls.Add(browser);
        Shown += async (_, _) => await InitializeBrowser();
    }

    private async Task InitializeBrowser()
    {
        await browser.EnsureCoreWebView2Async();
        var webRoot = Path.Combine(AppContext.BaseDirectory, "wwwroot");
        browser.CoreWebView2.SetVirtualHostNameToFolderMapping(
            "app.aegisub.local", webRoot, CoreWebView2HostResourceAccessKind.DenyCors);
        browser.CoreWebView2.WebMessageReceived += async (_, args) => await HandleMessage(args.WebMessageAsJson);
        browser.CoreWebView2.Navigate("https://app.aegisub.local/index.html");
    }

    private async Task HandleMessage(string json)
    {
        using var request = JsonDocument.Parse(json);
        var root = request.RootElement;
        var id = root.GetProperty("id").GetInt32();
        var method = root.GetProperty("method").GetString();
        var parameters = root.GetProperty("params");
        try
        {
            object? result = method switch
            {
                "openFile" => OpenFile(),
                "readFile" => await ReadFile(parameters.GetProperty("token").GetString()!),
                "saveFile" => await SaveFile(parameters),
                "openMedia" => OpenMedia(parameters.GetProperty("token").GetString()!),
                _ => throw new InvalidOperationException($"Unknown host method: {method}")
            };
            Respond(new { id, result });
        }
        catch (Exception error)
        {
            Respond(new { id, error = error.Message });
        }
    }

    private object? OpenFile()
    {
        using var dialog = new OpenFileDialog
        {
            Filter = "Supported files|*.ass;*.ssa;*.srt;*.mp4;*.mkv;*.webm;*.mov;*.avi;*.wav;*.mp3;*.flac;*.aac;*.ogg;*.m4a|All files|*.*"
        };
        if (dialog.ShowDialog(this) != DialogResult.OK) return null;
        var token = Guid.NewGuid().ToString("N");
        files[token] = dialog.FileName;
        var info = new FileInfo(dialog.FileName);
        return new { token, name = info.Name, size = info.Length, mime = MimeFor(info.Extension) };
    }

    private async Task<object> ReadFile(string token)
    {
        var bytes = await File.ReadAllBytesAsync(Resolve(token));
        return new { base64 = Convert.ToBase64String(bytes) };
    }

    private async Task<object> SaveFile(JsonElement parameters)
    {
        using var dialog = new SaveFileDialog { FileName = parameters.GetProperty("name").GetString() };
        if (dialog.ShowDialog(this) != DialogResult.OK) return new { saved = false };
        var bytes = Convert.FromBase64String(parameters.GetProperty("base64").GetString()!);
        await File.WriteAllBytesAsync(dialog.FileName!, bytes);
        return new { saved = true };
    }

    private object OpenMedia(string token)
    {
        var path = Resolve(token);
        var host = $"media-{token}.aegisub.local";
        browser.CoreWebView2.SetVirtualHostNameToFolderMapping(
            host, Path.GetDirectoryName(path)!, CoreWebView2HostResourceAccessKind.Allow);
        return new { url = $"https://{host}/{Uri.EscapeDataString(Path.GetFileName(path))}" };
    }

    private string Resolve(string token) => files.TryGetValue(token, out var path)
        ? path
        : throw new FileNotFoundException("The selected file handle has expired.");

    private void Respond(object payload) => browser.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(payload));

    private static string MimeFor(string extension) => extension.ToLowerInvariant() switch
    {
        ".ass" or ".ssa" or ".srt" => "text/plain",
        ".mp4" => "video/mp4",
        ".webm" => "video/webm",
        ".wav" => "audio/wav",
        ".mp3" => "audio/mpeg",
        _ => "application/octet-stream"
    };
}
