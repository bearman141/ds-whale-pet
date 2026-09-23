# Synthetic-input self check -- "is the injector broken" and "does this machine
# still accept synthetic input at all".
#
#   powershell -File tools/inputcheck.ps1
#
# Why this exists: automated testing of the pet relies on keybd_event / SendInput
# to fake keystrokes. When injection itself is refused by the OS, the pet's log
# just shows "nothing happened", which is very easy to misread as a pet bug.
# This isolates the injection side.
#
# Reading the result:
#   SetCursorPos=True, SendInput=2/2   -> injection works, look at the receiver
#   SetCursorPos=False, cursor frozen  -> the machine currently refuses synthetic
#                                         input. Observed for real: session Active,
#                                         desktop WinSta0\Default, integrity Medium,
#                                         not locked, no leftover hooks -- and
#                                         still False. A process started from an
#                                         independent scheduled task failed too, so
#                                         do not go chasing tokens/privileges.
#                                         Use app/tools/hookprobe.js and have the
#                                         user press real keys instead.
#
# Keep this file ASCII-only: Windows PowerShell 5.1 reads .ps1 as ANSI unless it
# has a BOM, so non-ASCII labels come out as mojibake.

$ErrorActionPreference = "Stop"

$code = @'
using System;
using System.Runtime.InteropServices;
public class IC {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }

  [DllImport("kernel32.dll")] static extern void SetLastError(uint e);
  [DllImport("user32.dll", SetLastError=true)] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError=true)] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, INPUT[] a, int cb);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);

  public static string Screen() { return GetSystemMetrics(0) + "x" + GetSystemMetrics(1); }

  public static string TryCursor(int x, int y) {
    POINT before; GetCursorPos(out before);
    SetLastError(0);
    bool ok = SetCursorPos(x, y);
    int err = Marshal.GetLastWin32Error();
    System.Threading.Thread.Sleep(300);
    POINT after; GetCursorPos(out after);
    return "SetCursorPos(" + x + "," + y + ") = " + ok + " (err " + err + "), cursor "
         + before.X + "," + before.Y + " -> " + after.X + "," + after.Y;
  }

  // INPUT must be a real union, otherwise SendInput fails with err 87
  // (ERROR_INVALID_PARAMETER) and you end up blaming the sandbox for your own bug.
  public static string TryKey(ushort vk) {
    INPUT[] a = new INPUT[2];
    a[0].type = 1; a[0].u.ki.wVk = vk;
    a[1].type = 1; a[1].u.ki.wVk = vk; a[1].u.ki.dwFlags = 2;   // KEYEVENTF_KEYUP
    SetLastError(0);
    uint n = SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
    return "SendInput(key 0x" + vk.ToString("X2") + ") = " + n + "/2 (err " + Marshal.GetLastWin32Error() + ")";
  }
}
'@

Add-Type -TypeDefinition $code

"time    = " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
"user    = " + [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
"session = " + (Get-Process -Id $PID).SessionId
"screen  = " + [IC]::Screen()
[IC]::TryCursor(400, 200)
[IC]::TryKey(0x41)
