// Nuskha (and Nuskha HQ) as a Windows program: its own window, icon, taskbar button and title bar
// around the Nuskha server on this PC, drawn by Microsoft Edge WebView2 (part of Windows 10/11).
// No browser around it: no address bar, no browser right-click menu, no developer tools, no
// browser shortcuts. Links to WhatsApp, email and other websites open outside, in their own apps.
// Built by build.mjs / build-hq.mjs with the C# compiler that comes with Windows (.NET Framework);
// compiled with /define:HQ it becomes Nuskha HQ.exe. If WebView2 is missing it opens an Edge window.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class Program
{
#if HQ
    public const string Title = "Nuskha HQ";
    const string Profile = "NuskhaHQ";
#elif OWNER
    public const string Title = "Nuskha Owner";
    const string Profile = "NuskhaOwner";
#else
    public const string Title = "Nuskha";
    const string Profile = "Nuskha";
#endif

    [DllImport("user32.dll")] static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [STAThread]
    static void Main(string[] args)
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string url = Arg(args, "--url");
#if HQ
        if (url == null) url = "http://localhost:" + Port(Path.Combine(dir, "hq.json"), 5299) + "/";
#elif OWNER
        // The owner's live view of the shop, read from Nuskha Cloud.
        if (url == null) url = "https://app-nuskha.vercel.app/#/view";
#else
        if (url == null) url = "http://localhost:" + Port(Path.Combine(dir, "config.json"), 5199) + "/";
#endif
        // One window: opening Nuskha again brings the open one to the front.
        bool first;
        Mutex one = new Mutex(true, "Local\\NuskhaWindow-" + Profile, out first);
        if (!first)
        {
            IntPtr h = FindWindow(null, Title);
            if (h != IntPtr.Zero) { if (IsIconic(h)) ShowWindow(h, 9); SetForegroundWindow(h); }
            return;
        }
        string version = null;
        try { version = CoreWebView2Environment.GetAvailableBrowserVersionString(); } catch { }
        if (string.IsNullOrEmpty(version))
        {
            // No WebView2 on this PC (very old Windows): an Edge app window instead.
            try { Process.Start(new ProcessStartInfo("msedge.exe", "--app=" + url) { UseShellExecute = true }); } catch { }
            return;
        }
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { } // sharp text on every screen scale
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new MainWindow(url, Profile));
        GC.KeepAlive(one);
    }

    static string Arg(string[] args, string name)
    {
        for (int i = 0; i < args.Length - 1; i++) if (args[i] == name) return args[i + 1];
        return null;
    }

    static int Port(string file, int fallback)
    {
        try
        {
            Match m = Regex.Match(File.ReadAllText(file), "\"(?:port|local_port)\"\\s*:\\s*(\\d+)");
            if (m.Success) return int.Parse(m.Groups[1].Value);
        }
        catch { }
        return fallback;
    }
}

class MainWindow : Form
{
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    static readonly Color Page = Color.FromArgb(0xF4, 0xF6, 0xF8);
    static readonly Color Navy = Color.FromArgb(0x1A, 0x14, 0x46);
    readonly string url;
    readonly string origin;
    readonly string profile;
    readonly WebView2 web = new WebView2();
    readonly Label waiting = new Label();
    int tries;

    public MainWindow(string url, string profile)
    {
        this.url = url;
        this.profile = profile;
        Uri u = new Uri(url);
        origin = u.Scheme + "://" + u.Authority;
        Text = Program.Title;
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        BackColor = Page;
        StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(1366, 820);
        MinimumSize = new Size(1000, 640);
        WindowState = FormWindowState.Maximized;
        waiting.Dock = DockStyle.Fill;
        waiting.TextAlign = ContentAlignment.MiddleCenter;
        waiting.Font = new Font("Segoe UI", 15f);
        waiting.ForeColor = Navy;
        waiting.BackColor = Page;
        waiting.Text = "Opening " + Program.Title + "…";
        web.Dock = DockStyle.Fill;
        web.DefaultBackgroundColor = Page;
        Controls.Add(web);
        Controls.Add(waiting);
        waiting.BringToFront();
        Load += async (s, e) => await Start();
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        // Windows 11: a light title bar in Nuskha's colours instead of a black one.
        int light = 0, caption = Bgr(Page), text = Bgr(Navy);
        try
        {
            DwmSetWindowAttribute(Handle, 20, ref light, 4);   // not dark mode
            DwmSetWindowAttribute(Handle, 35, ref caption, 4); // caption colour
            DwmSetWindowAttribute(Handle, 34, ref caption, 4); // border colour
            DwmSetWindowAttribute(Handle, 36, ref text, 4);    // title text colour
        }
        catch { }
    }

    static int Bgr(Color c) { return c.R | (c.G << 8) | (c.B << 16); }

    async Task Start()
    {
        string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Nuskha", "Window-" + profile);
        CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, data, new CoreWebView2EnvironmentOptions());
        await web.EnsureCoreWebView2Async(env);
        CoreWebView2 core = web.CoreWebView2;
        CoreWebView2Settings s = core.Settings;
        s.AreDevToolsEnabled = false;
        s.AreBrowserAcceleratorKeysEnabled = false; // no Find, Print page, Reload, View source …
        s.IsStatusBarEnabled = false;
        s.IsSwipeNavigationEnabled = false;
        s.IsGeneralAutofillEnabled = false;
        s.IsPasswordAutosaveEnabled = false;
        s.IsBuiltInErrorPageEnabled = false;
        s.IsZoomControlEnabled = true; // Ctrl + mouse wheel still makes text bigger for older eyes

        core.ContextMenuRequested += (o, a) =>
        {
            // Only boxes you type in get a menu, and only cut / copy / paste / select all / undo.
            if (!a.ContextMenuTarget.IsEditable) { a.Handled = true; return; }
            string[] keep = { "cut", "copy", "paste", "pasteAndMatchStyle", "selectAll", "undo", "redo", "emoji" };
            for (int i = a.MenuItems.Count - 1; i >= 0; i--)
            {
                CoreWebView2ContextMenuItem item = a.MenuItems[i];
                if (item.Kind == CoreWebView2ContextMenuItemKind.Separator) continue;
                if (Array.IndexOf(keep, item.Name) < 0) a.MenuItems.RemoveAt(i);
            }
            for (int i = a.MenuItems.Count - 1; i >= 0; i--)
            {
                bool sep = a.MenuItems[i].Kind == CoreWebView2ContextMenuItemKind.Separator;
                bool edge = i == 0 || i == a.MenuItems.Count - 1 || a.MenuItems[i - 1].Kind == CoreWebView2ContextMenuItemKind.Separator;
                if (sep && edge) a.MenuItems.RemoveAt(i);
            }
        };
        core.NewWindowRequested += (o, a) =>
        {
            // "Sign in with Google" opens Google in a small window that reports back to Nuskha: it must
            // stay inside the program (a WebView2 popup keeps window.opener). Everything else opens outside.
            if (SignIn(a.Uri)) return;
            a.Handled = true;
            Outside(a.Uri);
        };
        core.NavigationStarting += (o, a) =>
        {
            if (!Ours(a.Uri) && !SignIn(a.Uri)) { a.Cancel = true; Outside(a.Uri); }
        };
        core.NavigationCompleted += (o, a) =>
        {
            if (a.IsSuccess) { tries = 0; waiting.Visible = false; }
            else if (a.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled) Retry();
        };
        core.Navigate(url);
    }

    bool Ours(string uri)
    {
        return uri.StartsWith(origin + "/", StringComparison.OrdinalIgnoreCase) || uri == origin || uri.StartsWith("about:") || uri.StartsWith("data:") || uri.StartsWith("blob:");
    }

    /** Google sign-in pages (accounts.google.com and the pages it passes through). */
    static bool SignIn(string uri)
    {
        Uri u;
        if (!Uri.TryCreate(uri, UriKind.Absolute, out u) || u.Scheme != "https") return false;
        string h = u.Host.ToLowerInvariant();
        return h == "accounts.google.com" || h.EndsWith(".accounts.google.com") || h == "accounts.youtube.com"
            || h == "myaccount.google.com" || h == "ssl.gstatic.com" || h == "www.gstatic.com";
    }

    static void Outside(string uri)
    {
        // WhatsApp, email, phone and websites open in their own app or the PC's browser.
        if (string.IsNullOrEmpty(uri)) return;
        string l = uri.ToLowerInvariant();
        if (!(l.StartsWith("https://") || l.StartsWith("http://") || l.StartsWith("whatsapp:") || l.StartsWith("mailto:") || l.StartsWith("tel:"))) return;
        try { Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true }); } catch { }
    }

    void Retry()
    {
        // Nuskha's server may still be starting (just after the PC was switched on).
        tries++;
#if OWNER
        waiting.Text = "No internet. Nuskha Owner tries again by itself…";
#else
        waiting.Text = tries < 60 ? "Starting " + Program.Title + "…" : Program.Title + " is not running on this PC. Restart the PC, or ask for help.";
#endif
        waiting.Visible = true;
        waiting.BringToFront();
#if !OWNER
        if (tries >= 90) return;
#endif
        System.Windows.Forms.Timer t = new System.Windows.Forms.Timer { Interval = 2000 };
        t.Tick += (o, e) => { t.Stop(); t.Dispose(); if (web.CoreWebView2 != null) web.CoreWebView2.Navigate(url); };
        t.Start();
    }
}
