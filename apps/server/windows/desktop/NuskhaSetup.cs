// NuskhaSetup.exe: the one file a pharmacy downloads. Double-click, press Install, and Nuskha is on
// the PC: it unpacks Nuskha (carried inside this file), runs Install-Nuskha.ps1 quietly (start with
// Windows, desktop icon, other counters on the shop network), then opens Nuskha. Updating an existing
// Nuskha keeps its records, backups and settings. Built by build.mjs with the Windows C# compiler.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;

static class Setup
{
    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new SetupWindow());
    }
}

class SetupWindow : Form
{
    static readonly Color Navy = Color.FromArgb(0x1A, 0x14, 0x46);
    static readonly Color Amber = Color.FromArgb(0xF5, 0xA6, 0x23);
    static readonly Color Page = Color.FromArgb(0xF6, 0xF5, 0xFC);
    const string Target = @"C:\Nuskha";
    readonly Label title = new Label();
    readonly Label text = new Label();
    readonly ProgressBar bar = new ProgressBar();
    readonly Button go = new Button();
    readonly Button close = new Button();
    bool done;

    public SetupWindow()
    {
        Text = "Nuskha Setup";
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(560, 330);
        BackColor = Page;
        Font = new Font("Segoe UI", 10.5f);
        AutoScaleMode = AutoScaleMode.Dpi;

        PictureBox logo = new PictureBox { Location = new Point(36, 34), Size = new Size(64, 64), SizeMode = PictureBoxSizeMode.Zoom };
        try { logo.Image = new Icon(Icon, 64, 64).ToBitmap(); } catch { }
        title.Text = Directory.Exists(Path.Combine(Target, "data")) ? "Update Nuskha" : "Install Nuskha";
        title.Font = new Font("Segoe UI Semibold", 20f);
        title.ForeColor = Navy;
        title.AutoSize = true;
        title.Location = new Point(116, 38);
        text.Text = Directory.Exists(Path.Combine(Target, "data"))
            ? "Nuskha is already on this PC. Updating keeps all your records, backups and settings."
            : "Pharmacy software for Pakistan. Nuskha will be installed in C:\\Nuskha and will start by itself every time this PC is switched on.";
        text.ForeColor = Color.FromArgb(0x4A, 0x4F, 0x68);
        text.Location = new Point(36, 120);
        text.Size = new Size(490, 70);
        bar.Location = new Point(36, 200);
        bar.Size = new Size(488, 10);
        bar.Style = ProgressBarStyle.Marquee;
        bar.Visible = false;
        go.Text = title.Text == "Update Nuskha" ? "Update" : "Install";
        go.Size = new Size(150, 44);
        go.Location = new Point(374, 252);
        go.BackColor = Navy;
        go.ForeColor = Color.White;
        go.FlatStyle = FlatStyle.Flat;
        go.FlatAppearance.BorderSize = 0;
        go.Font = new Font("Segoe UI Semibold", 11f);
        go.Cursor = Cursors.Hand;
        go.Click += async (s, e) => await Install();
        close.Text = "Cancel";
        close.Size = new Size(110, 44);
        close.Location = new Point(254, 252);
        close.FlatStyle = FlatStyle.Flat;
        close.ForeColor = Navy;
        close.Cursor = Cursors.Hand;
        close.Click += (s, e) => Close();
        Panel stripe = new Panel { Dock = DockStyle.Top, Height = 5, BackColor = Amber };
        Controls.AddRange(new Control[] { stripe, logo, title, text, bar, go, close });
        AcceptButton = go;
    }

    async Task Install()
    {
        if (done) { OpenNuskha(); Close(); return; }
        go.Enabled = false;
        close.Enabled = false;
        bar.Visible = true;
        text.Text = "Installing Nuskha… this takes about a minute. Please keep this window open.";
        string work = Path.Combine(Path.GetTempPath(), "NuskhaSetup-" + Guid.NewGuid().ToString("N").Substring(0, 8));
        int code = -1;
        string error = null;
        try
        {
            await Task.Run(() =>
            {
                Directory.CreateDirectory(work);
                string zip = Path.Combine(work, "Nuskha.zip");
                using (Stream src = Assembly.GetExecutingAssembly().GetManifestResourceStream("Nuskha.zip"))
                using (FileStream dst = File.Create(zip)) { src.CopyTo(dst); }
                ZipFile.ExtractToDirectory(zip, work);
                ProcessStartInfo ps = new ProcessStartInfo("powershell.exe",
                    "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(work, "Nuskha", "Install-Nuskha.ps1") + "\" -Quiet")
                { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Path.Combine(work, "Nuskha") };
                using (Process p = Process.Start(ps)) { p.WaitForExit(); code = p.ExitCode; }
            });
        }
        catch (Exception ex) { error = ex.Message; }
        try { Directory.Delete(work, true); } catch { }
        bar.Visible = false;
        close.Enabled = true;
        go.Enabled = true;
        if (error == null && code == 0)
        {
            done = true;
            title.Text = "Nuskha is ready";
            text.Text = "Nuskha is installed and running. Use the Nuskha icon on the desktop to open it.\r\nOn other counter PCs of the shop, open the address shown in Nuskha → Settings.";
            go.Text = "Open Nuskha";
            close.Text = "Close";
            AcceptButton = go;
            go.Focus();
        }
        else
        {
            title.Text = "Setup did not finish";
            text.Text = (error ?? "Nuskha did not start.") + "\r\nSee C:\\Nuskha\\logs\\medflow.log, or send it to Nuskha on WhatsApp for help.";
            go.Text = "Try again";
        }
    }

    static void OpenNuskha()
    {
        // Through Explorer, so Nuskha opens as the signed-in user, not as administrator.
        try { Process.Start("explorer.exe", "\"" + Path.Combine(Target, "Nuskha.exe") + "\""); } catch { }
    }
}
