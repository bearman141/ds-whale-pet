# List every top-level window of the given processes and say whether it can
# appear in the Windows taskbar.
#
#   powershell -File tools/taskbar-probe.ps1
#
# Taskbar rule: a window is hidden from the taskbar when it has WS_EX_TOOLWINDOW,
# and forced into the taskbar when it has WS_EX_APPWINDOW. Electron's
# skipTaskbar:true sets TOOLWINDOW under the hood.
#
# ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI unless the
# file has a BOM, and a mangled comment line eats the line after it.

$ErrorActionPreference = 'Stop'

$cs = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinProbe {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  delegate bool EnumProc(IntPtr h, IntPtr p);

  public static List<string> Find(int[] want) {
    var outp = new List<string>();
    EnumWindows((h, p) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      bool hit = false;
      foreach (var w in want) { if (pid == (uint)w) hit = true; }
      if (!hit) return true;
      var t = new StringBuilder(256); GetWindowText(h, t, 256);
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      long ex = GetWindowLongPtr(h, -20).ToInt64();
      string flags = "";
      if ((ex & 0x80L) != 0) flags += "TOOLWINDOW ";
      if ((ex & 0x40000L) != 0) flags += "APPWINDOW ";
      if ((ex & 0x8L) != 0) flags += "TOPMOST ";
      if ((ex & 0x80000L) != 0) flags += "LAYERED ";
      string verdict = ((ex & 0x40000L) != 0) ? "IN taskbar (APPWINDOW)"
                     : ((ex & 0x80L) != 0) ? "NOT in taskbar (TOOLWINDOW)"
                     : "no TOOLWINDOW -> normally WOULD show in taskbar";
      outp.Add(String.Format("hwnd=0x{0:X}  pid={1}  visible={2}  ex=0x{3:X}{4}    [{5}]{4}    title=\"{6}\"{4}    class={7}",
        h.ToInt64(), pid, IsWindowVisible(h), ex, Environment.NewLine, flags.Trim(), verdict, t.ToString(), c.ToString()));
      return true;
    }, IntPtr.Zero);
    return outp;
  }
}
'@

Add-Type -TypeDefinition $cs

$procs = Get-Process electron -ErrorAction SilentlyContinue
if (-not $procs) { Write-Host 'electron is not running'; exit }
Write-Host ("electron pids: " + (($procs.Id) -join ', '))
Write-Host ''
[WinProbe]::Find([int[]]$procs.Id) | ForEach-Object { Write-Host $_; Write-Host '' }
