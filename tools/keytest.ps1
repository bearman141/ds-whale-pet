# Inject real key chords so the app's global uiohook listener sees them.
#
#   keytest.ps1 chord1 chord2 ...
#   chord syntax: "down:0x12,down:0x51,up:0x51,up:0x12"
#
# Uses keybd_event (injected input still reaches a WH_KEYBOARD_LL hook).

$ErrorActionPreference = "Stop"

$code = @'
using System;
using System.Runtime.InteropServices;

public class Keys
{
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    const uint KEYEVENTF_KEYUP = 0x0002;

    public static void Down(int vk, bool extended)
    {
        keybd_event((byte)vk, 0, extended ? KEYEVENTF_EXTENDEDKEY : 0, UIntPtr.Zero);
    }

    public static void Up(int vk, bool extended)
    {
        keybd_event((byte)vk, 0, (extended ? KEYEVENTF_EXTENDEDKEY : 0) | KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    // "0x12:down=1:ext=0;0x51:down=1:ext=0;..."
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
