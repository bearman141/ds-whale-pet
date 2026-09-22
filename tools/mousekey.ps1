# Simulate real mouse + keyboard input (for testing the pet's panels).
#
#   mousekey.ps1 move <x> <y>
#   mousekey.ps1 click <x> <y>
#   mousekey.ps1 type <text>
#   mousekey.ps1 key <vk-hex>
#   mousekey.ps1 pos
#
# Coordinates are PHYSICAL pixels (the process declares itself DPI-aware).
#
# IMPORTANT: movement goes through SendInput, NOT SetCursorPos.
# SetCursorPos moves the cursor but does not produce the low-level mouse
# events that Electron's setIgnoreMouseEvents(forward:true) relies on,
# so the pet never notices the pointer and never becomes clickable.

$ErrorActionPreference = "Stop"

$code = @'
using System;
using System.Runtime.InteropServices;

public class MK
{
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public INPUTUNION u; }

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);

    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_MOVE = 0x0001;
    const uint KEYEVENTF_UNICODE = 0x0004, KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_EXTENDEDKEY = 0x0001;

    static bool dpiReady = false;
    static void EnsureDpi() { if (!dpiReady) { try { SetProcessDPIAware(); } catch {} dpiReady = true; } }

    static void Send(INPUT[] a) { lastSent = SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT))); lastWanted = (uint)a.Length; }

    public static uint lastSent = 0, lastWanted = 0;
    public static string LastResult() { return lastSent + "/" + lastWanted + " (err=" + Marshal.GetLastWin32Error() + ")"; }

    public static string Screen()
    {
        EnsureDpi();
        return GetSystemMetrics(0) + "x" + GetSystemMetrics(1);
    }

    public static string Pos()
    {
        EnsureDpi();
        POINT p; GetCursorPos(out p);
        return p.X + "," + p.Y;
    }

    public static void Move(int x, int y)
    {
        EnsureDpi();
        int vx = GetSystemMetrics(0), vy = GetSystemMetrics(1);
        INPUT[] a = new INPUT[1];
        a[0].type = INPUT_MOUSE;
        a[0].u.mi.dx = (int)Math.Round((double)x * 65535 / (vx - 1));
        a[0].u.mi.dy = (int)Math.Round((double)y * 65535 / (vy - 1));
        a[0].u.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE;
        Send(a);
        System.Threading.Thread.Sleep(90);
    }

    public static void Click(int x, int y)
    {
        Move(x, y);
        System.Threading.Thread.Sleep(160);
        INPUT[] a = new INPUT[2];
        a[0].type = INPUT_MOUSE; a[0].u.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
        a[1].type = INPUT_MOUSE; a[1].u.mi.dwFlags = MOUSEEVENTF_LEFTUP;
        Send(a);
        System.Threading.Thread.Sleep(140);
    }

    public static void TypeText(string s)
    {
        foreach (char c in s)
        {
            INPUT[] a = new INPUT[2];
            a[0].type = INPUT_KEYBOARD; a[0].u.ki.wVk = 0; a[0].u.ki.wScan = (ushort)c; a[0].u.ki.dwFlags = KEYEVENTF_UNICODE;
            a[1].type = INPUT_KEYBOARD; a[1].u.ki.wVk = 0; a[1].u.ki.wScan = (ushort)c; a[1].u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            Send(a);
            System.Threading.Thread.Sleep(20);
        }
        System.Threading.Thread.Sleep(120);
    }

    public static void Key(int vk, bool extended)
    {
        INPUT[] a = new INPUT[2];
        a[0].type = INPUT_KEYBOARD; a[0].u.ki.wVk = (ushort)vk; a[0].u.ki.dwFlags = extended ? KEYEVENTF_EXTENDEDKEY : 0;
        a[1].type = INPUT_KEYBOARD; a[1].u.ki.wVk = (ushort)vk; a[1].u.ki.dwFlags = (extended ? KEYEVENTF_EXTENDEDKEY : 0) | KEYEVENTF_KEYUP;
        Send(a);
        System.Threading.Thread.Sleep(60);
    }
}
'@

Add-Type -TypeDefinition $code

$cmd = $args[0]
switch ($cmd) {
  "move"  { [MK]::Move([int]$args[1], [int]$args[2]); "moved -> " + [MK]::Pos() }
  "click" { [MK]::Click([int]$args[1], [int]$args[2]); "clicked $($args[1]),$($args[2])  SendInput=" + [MK]::LastResult() }
  "type"  { [MK]::TypeText([string]$args[1]); "typed $($args[1].Length) chars" }
  "key"   { [MK]::Key([Convert]::ToInt32($args[1], 16), $false); "key $($args[1])" }
  "pos"   { "cursor=" + [MK]::Pos() + "  screen=" + [MK]::Screen() }
  default { "usage: mousekey.ps1 move|click x y | type text | key vkhex | pos" }
}
