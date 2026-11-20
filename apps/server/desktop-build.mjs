// Builds the Windows program (Nuskha.exe or "Nuskha HQ.exe") with the C# compiler that comes with
// Windows (.NET Framework 4), and puts Microsoft's WebView2 files next to it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEBVIEW2 = ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll'];
/** Files of the window program: an update leaves them alone when they are already there (a running window locks them). */
export const DESKTOP_FILES = ['Nuskha.exe', 'Nuskha HQ.exe', ...WEBVIEW2];

export function buildWindow(out, { hq = false, icon }) {
  if (process.platform !== 'win32') { console.log('• Windows program skipped (build on Windows)'); return null; }
  const csc = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (!fs.existsSync(csc)) throw new Error(`The C# compiler was not found at ${csc}`);
  const wv = path.join(here, 'windows', 'webview2');
  const exe = path.join(out, hq ? 'Nuskha HQ.exe' : 'Nuskha.exe');
  execFileSync(csc, ['-nologo', '-target:winexe', '-platform:x64', '-optimize+', ...(hq ? ['-define:HQ'] : []),
    `-out:${exe}`, `-win32icon:${icon}`, `-win32manifest:${path.join(here, 'windows', 'desktop', 'app.manifest')}`,
    `-r:${path.join(wv, 'Microsoft.Web.WebView2.Core.dll')}`, `-r:${path.join(wv, 'Microsoft.Web.WebView2.WinForms.dll')}`,
    '-r:System.Windows.Forms.dll', '-r:System.Drawing.dll', path.join(here, 'windows', 'desktop', 'NuskhaWindow.cs')], { stdio: 'pipe' });
  for (const f of WEBVIEW2) fs.copyFileSync(path.join(wv, f), path.join(out, f));
  console.log(`• Windows program: ${path.basename(exe)}`);
  return exe;
}
