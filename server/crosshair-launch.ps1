param([Parameter(Mandatory = $true)][ValidatePattern('^ms-gamebar:(?://launchForeground/activate/Xenon\.Crosshair_[a-z0-9]{13}_App_Crosshair)?$')][string]$Uri)
# Launch only Xenon Crosshair (or the Game Bar installation fallback).
# The monitor hint keeps a click on the Edge from opening the overlay there.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class XenonGameBarLaunch {
  private const uint MONITOR_DEFAULTTOPRIMARY = 1;
  private const uint SEE_MASK_HMONITOR = 0x00200000;
  private const uint SEE_MASK_NOASYNC = 0x00000100;
  private const uint SEE_MASK_FLAG_NO_UI = 0x00000400;
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct ExecuteInfo {
    public uint cbSize, fMask;
    public IntPtr hwnd;
    public string verb, file, parameters, directory;
    public int show;
    public IntPtr instance, idList;
    public string className;
    public IntPtr classKey;
    public uint hotKey;
    public IntPtr monitor, process;
  }
  [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool ShellExecuteExW(ref ExecuteInfo info);
  public static void Open(string uri) {
    var monitor = MonitorFromWindow(IntPtr.Zero, MONITOR_DEFAULTTOPRIMARY);
    if (monitor == IntPtr.Zero) throw new InvalidOperationException("Primary display is unavailable.");
    var info = new ExecuteInfo {
      cbSize = (uint)Marshal.SizeOf(typeof(ExecuteInfo)),
      fMask = SEE_MASK_HMONITOR | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
      verb = "open", file = uri, show = 1, monitor = monitor
    };
    if (!ShellExecuteExW(ref info)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
}
"@
[XenonGameBarLaunch]::Open($Uri)
