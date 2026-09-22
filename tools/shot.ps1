# Screen-capture + A/B pixel-diff helper.
#
#   shot.ps1 grab <x> <y> <w> <h> <out.png>
#   shot.ps1 diff <a.png> <b.png> <tolerance> [prune.png]
#
# grab: BitBlt with CAPTUREBLT so layered (transparent) windows are included.
# diff: reports how many pixels differ and the bounding box of the difference,
#       which is how we confirm the pet is actually on screen and where.

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$drawingAsm = [System.Drawing.Bitmap].Assembly.Location

$code = @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public class Shot
{
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("gdi32.dll")] public static extern bool BitBlt(
        IntPtr hdcDest, int nXDest, int nYDest, int nWidth, int nHeight,
        IntPtr hdcSrc, int nXSrc, int nYSrc, int dwRop);

    const int SRCCOPY = 0x00CC0020;
    const int CAPTUREBLT = 0x40000000;

    public static void Grab(int x, int y, int w, int h, string path)
    {
        IntPtr src = GetDC(IntPtr.Zero);
        try
        {
            using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
            {
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    IntPtr dst = g.GetHdc();
                    try { BitBlt(dst, 0, 0, w, h, src, x, y, SRCCOPY | CAPTUREBLT); }
                    finally { g.ReleaseHdc(dst); }
                }
                bmp.Save(path, ImageFormat.Png);
            }
        }
        finally { ReleaseDC(IntPtr.Zero, src); }
    }

    static byte[] Bytes(string path, out int w, out int h)
    {
        using (Bitmap bmp = new Bitmap(path))
        {
            w = bmp.Width; h = bmp.Height;
            BitmapData d = bmp.LockBits(new Rectangle(0, 0, w, h),
                ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                byte[] buf = new byte[d.Stride * h];
                Marshal.Copy(d.Scan0, buf, 0, buf.Length);
                return buf;
            }
            finally { bmp.UnlockBits(d); }
        }
    }

    public static string Diff(string pathA, string pathB, int tol, string pruneOut)
    {
        int wa, ha, wb, hb;
        byte[] a = Bytes(pathA, out wa, out ha);
        byte[] b = Bytes(pathB, out wb, out hb);
        if (wa != wb || ha != hb)
            return "size mismatch " + wa + "x" + ha + " vs " + wb + "x" + hb;

        int minX = int.MaxValue, minY = int.MaxValue, maxX = -1, maxY = -1, changed = 0;

        Bitmap prune = null;
        Graphics gp = null;
        if (pruneOut != null && pruneOut.Length > 0)
        {
            prune = new Bitmap(wa, ha, PixelFormat.Format32bppArgb);
            gp = Graphics.FromImage(prune);
        }

        for (int y = 0; y < ha; y++)
        {
            int row = y * wa * 4;
            for (int x = 0; x < wa; x++)
            {
                int i = row + x * 4;
                int d = Math.Abs(a[i] - b[i]) + Math.Abs(a[i + 1] - b[i + 1]) + Math.Abs(a[i + 2] - b[i + 2]);
                if (d > tol)
                {
                    changed++;
                    if (x < minX) minX = x;
                    if (y < minY) minY = y;
                    if (x > maxX) maxX = x;
                    if (y > maxY) maxY = y;
                    if (prune != null) prune.SetPixel(x, y, Color.Red);
                }
            }
        }

        if (prune != null)
        {
            // overlay the "B" (reference) image dimmed, then the diff in red
            for (int y = 0; y < ha; y++)
                for (int x = 0; x < wa; x++)
                {
                    int i = (y * wa + x) * 4;
                    Color baseC = Color.FromArgb(255, b[i + 2], b[i + 1], b[i]);
                    Color cur = prune.GetPixel(x, y);
                    if (cur.R == 255 && cur.G == 0 && cur.B == 0)
                        continue;
                    int dim = (baseC.R + baseC.G + baseC.B) / 3 / 3 + 160;
                    prune.SetPixel(x, y, Color.FromArgb(255, Math.Min(255, dim), Math.Min(255, dim), Math.Min(255, dim)));
                }
            gp.Dispose();
            prune.Save(pruneOut, ImageFormat.Png);
            prune.Dispose();
        }

        if (changed == 0) return "changed=0";
        return "changed=" + changed + " bbox=" + minX + "," + minY + " " + (maxX - minX + 1) + "x" + (maxY - minY + 1);
    }
}
'@

Add-Type -TypeDefinition $code -ReferencedAssemblies $drawingAsm

$action = $args[0]
switch ($action) {
  "grab" {
    [Shot]::Grab([int]$args[1], [int]$args[2], [int]$args[3], [int]$args[4], [string]$args[5])
    "saved $($args[5])"
  }
  "diff" {
    $tol = 30
    if ($args.Count -ge 4) { $tol = [int]$args[3] }
    $prune = ""
    if ($args.Count -ge 5) { $prune = [string]$args[4] }
    [Shot]::Diff([string]$args[1], [string]$args[2], $tol, $prune)
  }
  default { "usage: shot.ps1 grab x y w h out | shot.ps1 diff a b [tol] [pruneOut]" }
}
