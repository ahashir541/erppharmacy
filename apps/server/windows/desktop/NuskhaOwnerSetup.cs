// NuskhaOwnerSetup.exe: the owner's laptop program. Double-click, press Install: "Nuskha Owner" is
// copied to %LOCALAPPDATA%\Nuskha Owner (no administrator needed), with a desktop and Start menu
// icon, and opens. It shows the shop's live, read-only view (view code from the shop's Settings).
// Built by build.mjs with the Windows C# compiler; NuskhaOwner.zip is carried inside.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;

static class OwnerSetup
{
    [STAThread]
    static int Main(string[] args)
    {
        // /quiet: install without the window (tests, or IT staff); exit code 0 when installed.
        if (Array.IndexOf(args, "/quiet") >= 0) { OwnerSetupWindow w = new OwnerSetupWindow(); w.Quiet = true; w.Install(); return w.Done ? 0 : 1; }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new OwnerSetupWindow());
        return 0;
    }
}

class OwnerSetupWindow : Form
{
    static readonly Color Navy = Color.FromArgb(0x1A, 0x14, 0x46);
    static readonly Color Page = Color.FromArgb(0xF6, 0xF5, 0xFC);
    readonly Label text = new Label();
    readonly Button go = new Button();
    bool done;
    public bool Quiet;
    public bool Done { get { return done; } }

    static string Target { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Nuskha Owner"); } }

    public OwnerSetupWindow()
    {
        Text = "Nuskha Owner Setup";
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        BackColor = Page;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(480, 260);
        Font = new Font("Segoe UI", 10f);

        Label title = new Label { Text = "Nuskha Owner", Font = new Font("Segoe UI Semibold", 20f), ForeColor = Navy, AutoSize = true, Location = new Point(28, 24) };
        text.Text = "See your pharmacy live from this laptop: sales, stock and udhaar.\r\n\r\n" +
                    "After installing, type the view code from the shop's Nuskha\r\n(Settings → Owner's laptop).";
        text.Location = new Point(30, 80);
        text.Size = new Size(420, 100);
        go.Text = "Install";
        go.Size = new Size(140, 40);
        go.Location = new Point(310, 196);
        go.BackColor = Navy; go.ForeColor = Color.White; go.FlatStyle = FlatStyle.Flat;
        go.Click += delegate { if (done) { Close(); return; } Install(); };
        Controls.Add(title); Controls.Add(text); Controls.Add(go);
    }

    public void Install()
    {
        go.Enabled = false;
        text.Text = "Installing…";
        Refresh();
        try
        {
            foreach (Process p in Process.GetProcessesByName("Nuskha Owner")) { try { p.Kill(); p.WaitForExit(5000); } catch { } }
            Directory.CreateDirectory(Target);
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("NuskhaOwner.zip"))
            using (ZipArchive zip = new ZipArchive(s))
            {
                foreach (ZipArchiveEntry e in zip.Entries)
                {
                    string to = Path.Combine(Target, e.FullName);
                    if (string.IsNullOrEmpty(e.Name)) { Directory.CreateDirectory(to); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(to));
                    e.ExtractToFile(to, true);
                }
            }
            string exe = Path.Combine(Target, "Nuskha Owner.exe");
            Shortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Nuskha Owner.lnk"), exe);
            string start = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Nuskha");
            Directory.CreateDirectory(start);
            Shortcut(Path.Combine(start, "Nuskha Owner.lnk"), exe);
            if (!Quiet) Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true, WorkingDirectory = Target });
            done = true;
            text.Text = "Nuskha Owner is installed.\r\n\r\nIt is open now, and has an icon on the desktop.";
            go.Text = "Close";
        }
        catch (Exception ex)
        {
            text.Text = "Could not install: " + ex.Message;
            go.Text = "Try again";
        }
        go.Enabled = true;
    }

    static void Shortcut(string lnk, string target)
    {
        Type t = Type.GetTypeFromProgID("WScript.Shell");
        object shell = Activator.CreateInstance(t);
        object sc = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnk });
        Type st = sc.GetType();
        st.InvokeMember("TargetPath", BindingFlags.SetProperty, null, sc, new object[] { target });
        st.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, sc, new object[] { Path.GetDirectoryName(target) });
        st.InvokeMember("IconLocation", BindingFlags.SetProperty, null, sc, new object[] { target + ",0" });
        st.InvokeMember("Save", BindingFlags.InvokeMethod, null, sc, null);
    }
}
