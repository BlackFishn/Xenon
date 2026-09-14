using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;

// The CRXED00 hardware ID was verified against this device's WMI/EDID name.
// Never select a monitor by display number, resolution, or the primary flag.
internal static class EdgePower
{
    private const byte PowerCode = 0xD6;

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MonitorInfo
    {
        public int Size;
        public Rect Monitor, Work;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Device;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DisplayDevice
    {
        public int Size;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Id;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Key;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PhysicalMonitor
    {
        public IntPtr Handle;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
    }

    private delegate bool MonitorCallback(IntPtr monitor, IntPtr dc, ref Rect rect, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorCallback callback, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool EnumDisplayDevices(string device, uint index, ref DisplayDevice display, uint flags);
    [DllImport("dxva2.dll", SetLastError = true)] private static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr monitor, out uint count);
    [DllImport("dxva2.dll", SetLastError = true)] private static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr monitor, uint count, [Out] PhysicalMonitor[] monitors);
    [DllImport("dxva2.dll")] private static extern bool DestroyPhysicalMonitors(uint count, PhysicalMonitor[] monitors);
    [DllImport("dxva2.dll", SetLastError = true)] private static extern bool GetVCPFeatureAndVCPFeatureReply(IntPtr monitor, byte code, out uint type, out uint current, out uint maximum);
    [DllImport("dxva2.dll", SetLastError = true)] private static extern bool SetVCPFeature(IntPtr monitor, byte code, uint value);

    private static IntPtr FindEdge()
    {
        var matches = new List<IntPtr>();
        MonitorCallback callback = delegate(IntPtr monitor, IntPtr dc, ref Rect rect, IntPtr data)
        {
            var info = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
            if (!GetMonitorInfo(monitor, ref info)) return true;
            var display = new DisplayDevice { Size = Marshal.SizeOf(typeof(DisplayDevice)) };
            if (EnumDisplayDevices(info.Device, 0, ref display, 1) && display.Id != null &&
                display.Id.IndexOf("#CRXED00#", StringComparison.OrdinalIgnoreCase) >= 0)
                matches.Add(monitor);
            return true;
        };
        if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero))
            throw new InvalidOperationException("Cannot enumerate displays.");
        if (matches.Count == 0) throw new InvalidOperationException("XENEON EDGE not found. Check its video cable.");
        if (matches.Count != 1) throw new InvalidOperationException("More than one XENEON EDGE found; no display was changed.");
        return matches[0];
    }

    private static bool TryRead(IntPtr handle, out bool on, out uint value)
    {
        uint type, maximum;
        bool ok = GetVCPFeatureAndVCPFeatureReply(handle, PowerCode, out type, out value, out maximum);
        on = value == 1;
        return ok && value >= 1 && value <= 5;
    }

    private static object Control(string command)
    {
        IntPtr monitor = FindEdge();
        uint count;
        if (!GetNumberOfPhysicalMonitorsFromHMONITOR(monitor, out count) || count != 1)
            throw new InvalidOperationException("Cannot identify one physical XENEON EDGE.");
        var physical = new PhysicalMonitor[count];
        if (!GetPhysicalMonitorsFromHMONITOR(monitor, count, physical))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            IntPtr handle = physical[0].Handle;
            bool on;
            uint value;
            bool read = TryRead(handle, out on, out value);
            if (command == "status")
            {
                if (!read) throw new InvalidOperationException("EDGE power state is unavailable. Press the key to wake it.");
                return new { ok = true, on = on, power = value };
            }

            // A sleeping monitor may stop answering reads. Recover by waking,
            // never by guessing that an unreadable display needs to be turned off.
            bool targetOn = command == "on" || (command == "toggle" && (!read || !on));
            if (read && on == targetOn) return new { ok = true, on = on, power = value };
            if (!SetVCPFeature(handle, PowerCode, targetOn ? 1u : 4u))
                throw new Win32Exception(Marshal.GetLastWin32Error());

            // EDGE reports 2 while asleep after a write of 4, and can briefly
            // reject reads during wake. Confirm the resulting state, not the write.
            for (int attempt = 0; attempt < 8; attempt++)
            {
                Thread.Sleep(750);
                if (TryRead(handle, out on, out value) && on == targetOn)
                    return new { ok = true, on = on, power = value };
            }
            throw new InvalidOperationException("EDGE did not confirm its power state. Press the key again to retry.");
        }
        finally { DestroyPhysicalMonitors(count, physical); }
    }

    private static int Main(string[] args)
    {
        var json = new JavaScriptSerializer();
        try
        {
            string command = args.Length == 1 ? args[0] : "";
            if (command != "status" && command != "toggle" && command != "on" && command != "off")
                throw new ArgumentException("Use status, toggle, on, or off.");
            using (var mutex = new Mutex(false, @"Local\XenonEdgeStreamDockPower"))
            {
                bool locked;
                try { locked = mutex.WaitOne(0); }
                catch (AbandonedMutexException) { locked = true; }
                if (!locked) throw new InvalidOperationException("Another EDGE power operation is in progress.");
                try { Console.WriteLine(json.Serialize(Control(command))); }
                finally { mutex.ReleaseMutex(); }
            }
            return 0;
        }
        catch (Exception error)
        {
            Console.WriteLine(json.Serialize(new { ok = false, error = error.Message }));
            return 1;
        }
    }
}
