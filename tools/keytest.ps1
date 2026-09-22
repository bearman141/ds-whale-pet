# Inject real key chords so the app's global uiohook listener sees them.
#
#   keytest.ps1 chord1 chord2 ...
#   chord syntax: "down:0x12,down:0x51,up:0x51,up:0x12"
#   actually:     "0x12:1:0;0x51:1:0;0x51:0:0;0x12:0:0"   (vk:isDown:isExtended)
#
# Two things that bit me and are worth keeping:
#   1. bScan MUST be a real scan code. With 0, letters happen to still work but
#      PageUp/PageDown do not -- libuiohook maps keys primarily by scan code, so
#      the hotkey looks broken in tests while a real keyboard works fine.
#   2. Keep the C# source ASCII-only. Chinese comments inside the here-string get
#      read as ANSI by the compiler and can swallow the next line (it ate a
#      [DllImport] attribute once).

$ErrorActionPreference = "Stop"

$code = @'
using System;
using System.Runtime.InteropServices;

public class Keys
{
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern uint MapVirtualKey(uint uCode, uint uMapType);

    const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint MAPVK_VK_TO_VSC = 0;

    static byte Scan(int vk) { return (byte)MapVirtualKey((uint)vk, MAPVK_VK_TO_VSC); }

    public static void Down(int vk, bool extended)
    {
        keybd_event((byte)vk, Scan(vk), extended ? KEYEVENTF_EXTENDEDKEY : 0, UIntPtr.Zero);
    }

    public static void Up(int vk, bool extended)
    {
        keybd_event((byte)vk, Scan(vk), (extended ? KEYEVENTF_EXTENDEDKEY : 0) | KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    public static void Chord(string spec)
    {
        string[] steps = spec.Split(';');
        foreach (string s in steps)
        {
            string[] p = s.Split(':');
            int vk = Convert.ToInt32(p[0], 16);
            bool down = p[1] == "1";
            bool ext = p.Length > 2 && p[2] == "1";
            if (down) Down(vk, ext); else Up(vk, ext);
            System.Threading.Thread.Sleep(45);
        }
    }
}
'@

Add-Type -TypeDefinition $code

foreach ($chord in $args) {
  [Keys]::Chord($chord)
  Start-Sleep -Milliseconds 350
}
"sent $($args.Count) chord(s)"
