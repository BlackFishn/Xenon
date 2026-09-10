using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace XenonHelper;

// Event-driven mixer, separate from the optional sampled peak meters. All COM
// ownership and commands live on one MTA thread. Callbacks only signal that
// thread: they never enumerate, block, write stdout, or release COM references.
public sealed unsafe class AudioControlHost : IDisposable
{
    private static readonly Guid EnumeratorClass = new("BCDE0395-E52F-467C-8E3D-C4579291692E");
    private static readonly Guid EnumeratorInterface = new("A95664D2-9614-4F35-A746-DE8DB63617E6");
    private static readonly Guid ManagerInterface = new("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
    private static readonly Guid Control2Interface = new("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D");
    private static readonly Guid VolumeInterface = new("87CE5498-68D6-44E5-9215-6DA47EF883D8");
    private static readonly Guid EndpointVolumeInterface = new("5CDF2C82-841E-4546-9722-0CF74078229A");
    private static readonly Guid Context = new("1DD03B86-E780-40EE-997B-1879B673D516");
    [DllImport("ole32.dll")] private static extern int CoInitializeEx(IntPtr p, uint flags);
    [DllImport("ole32.dll")] private static extern void CoUninitialize();
    [DllImport("ole32.dll")] private static extern int CoCreateInstance(in Guid cls, IntPtr outer, int context, in Guid iid, out IntPtr obj);
    [DllImport("ole32.dll")] private static extern int PropVariantClear(IntPtr value);
    private static IntPtr Slot(IntPtr p, int slot) => (*(IntPtr**)p)[slot];
    private static void Check(int hr) { if (hr < 0) Marshal.ThrowExceptionForHR(hr); }
    private static void Drop(IntPtr p) { if (p != IntPtr.Zero) Marshal.Release(p); }
    private static IntPtr Query(IntPtr p, Guid iid) { Check(Marshal.QueryInterface(p, in iid, out var q)); return q; }
    private static IntPtr Activate(IntPtr p, Guid iid)
    {
        IntPtr q;
        Check(((delegate* unmanaged[Stdcall]<IntPtr, Guid*, int, IntPtr, IntPtr*, int>)Slot(p, 3))(p, &iid, 23, IntPtr.Zero, &q));
        return q;
    }
    private static IntPtr OutObject(IntPtr p, int slot)
    {
        IntPtr q; Check(((delegate* unmanaged[Stdcall]<IntPtr, IntPtr*, int>)Slot(p, slot))(p, &q)); return q;
    }
    private static int ReadInt(IntPtr p, int slot)
    {
        int v; Check(((delegate* unmanaged[Stdcall]<IntPtr, int*, int>)Slot(p, slot))(p, &v)); return v;
    }
    private static float ReadFloat(IntPtr p, int slot)
    {
        float v; Check(((delegate* unmanaged[Stdcall]<IntPtr, float*, int>)Slot(p, slot))(p, &v)); return v;
    }
    private static string ReadString(IntPtr p, int slot)
    {
        var value = OutObject(p, slot);
        try { return Marshal.PtrToStringUni(value) ?? ""; } finally { Marshal.FreeCoTaskMem(value); }
    }
    private static void Notify(IntPtr p, int slot, IntPtr callback) =>
        Check(((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, int>)Slot(p, slot))(p, callback));
    private static void Unnotify(IntPtr p, int slot, IntPtr callback)
    {
        if (p != IntPtr.Zero && callback != IntPtr.Zero) try { Notify(p, slot, callback); } catch { }
    }

    private readonly AutoResetEvent wake = new(false);
    private readonly ConcurrentQueue<string> commands = new();
    private readonly List<Device> devices = new();
    private IntPtr enumerator;
    private IntPtr deviceCallback;
    private DeviceEvents? deviceEvents;
    private int dirty = 2; // 1 = values changed; 2 = topology changed
    private bool exiting;
    private string lastSnapshot = "";

    internal void Signal(bool topology = false)
    {
        Interlocked.Or(ref dirty, topology ? 2 : 1);
        wake.Set();
    }

    public static int Run()
    {
        Check(CoInitializeEx(IntPtr.Zero, 0)); // COINIT_MULTITHREADED
        try
        {
            using var host = new AudioControlHost();
            return host.Loop();
        }
        finally { CoUninitialize(); }
    }

    private int Loop()
    {
        Check(CoCreateInstance(in EnumeratorClass, IntPtr.Zero, 23, in EnumeratorInterface, out enumerator));
        deviceEvents = new DeviceEvents(this);
        deviceCallback = Marshal.GetComInterfaceForObject<DeviceEvents, IDeviceEvents>(deviceEvents);
        Notify(enumerator, 6, deviceCallback);
        new Thread(() =>
        {
            try
            {
                string? line;
                while ((line = Console.In.ReadLine()) != null)
                {
                    if (line.Length > 8192 || commands.Count >= 128) break;
                    commands.Enqueue(line);
                    wake.Set();
                }
            }
            finally { commands.Enqueue("{\"action\":\"exit\"}"); wake.Set(); }
        }) { IsBackground = true, Name = "audio-commands" }.Start();

        while (!exiting)
        {
            var changes = Interlocked.Exchange(ref dirty, 0);
            if (changes != 0)
            {
                try
                {
                    if ((changes & 2) != 0) Rebuild();
                    Publish();
                }
                catch (Exception e)
                {
                    Emit(new() { ["event"] = "unavailable", ["error"] = e.Message });
                    // Parent falls back and closes this host. Never spin on a
                    // disconnected device or failed callback registration.
                    return 1;
                }
            }
            // Bounded batch so a slider cannot starve incoming Windows events.
            for (var i = 0; i < 32 && commands.TryDequeue(out var command); i++) Execute(command);
            if (commands.IsEmpty && Volatile.Read(ref dirty) == 0 && !exiting) wake.WaitOne();
        }
        return 0;
    }

    private string DefaultId(int flow)
    {
        IntPtr device;
        var hr = ((delegate* unmanaged[Stdcall]<IntPtr, int, int, IntPtr*, int>)Slot(enumerator, 4))(enumerator, flow, 0, &device);
        if (hr < 0) return "";
        try { return ReadString(device, 5); } finally { Drop(device); }
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PropertyKey { public Guid Format; public uint Id; }
    private static string Property(IntPtr device, Guid format, uint id)
    {
        IntPtr store;
        Check(((delegate* unmanaged[Stdcall]<IntPtr, int, IntPtr*, int>)Slot(device, 4))(device, 0, &store));
        var value = Marshal.AllocCoTaskMem(24);
        try
        {
            new Span<byte>((void*)value, 24).Clear();
            var key = new PropertyKey { Format = format, Id = id };
            Check(((delegate* unmanaged[Stdcall]<IntPtr, PropertyKey*, IntPtr, int>)Slot(store, 5))(store, &key, value));
            return Marshal.ReadInt16(value) == 31 ? Marshal.PtrToStringUni(Marshal.ReadIntPtr(value, 8)) ?? "" : "";
        }
        finally { PropVariantClear(value); Marshal.FreeCoTaskMem(value); Drop(store); }
    }

    private sealed class Session
    {
        public IntPtr Control, Volume, Callback;
        public SessionEvents? Events;
        public string Id = "", Name = "", Path = "", Proc = "";
        public int Pid;
        public void Dispose()
        {
            Unnotify(Control, 11, Callback);
            Drop(Callback); Drop(Volume); Drop(Control);
        }
    }
    private sealed class Device
    {
        public IntPtr Endpoint, Volume, Manager, VolumeCallback, SessionCallback;
        public EndpointEvents? VolumeEvents;
        public CreatedEvents? SessionEvents;
        public string Id = "", Name = "", Label = "", Alias = "", Direction = "";
        public bool Default;
        public readonly List<Session> Sessions = new();
        public void Dispose()
        {
            Unnotify(Manager, 7, SessionCallback);
            Unnotify(Volume, 4, VolumeCallback);
            foreach (var s in Sessions) s.Dispose();
            Drop(SessionCallback); Drop(VolumeCallback); Drop(Manager); Drop(Volume); Drop(Endpoint);
        }
    }

    private void Rebuild()
    {
        foreach (var d in devices) d.Dispose();
        devices.Clear();
        var propertyFormat = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
        var interfaceFormat = new Guid("026e516e-b814-414b-83cd-856d6fef4822");
        for (var flow = 0; flow < 2; flow++)
        {
            var defaultId = DefaultId(flow);
            IntPtr collection;
            Check(((delegate* unmanaged[Stdcall]<IntPtr, int, int, IntPtr*, int>)Slot(enumerator, 3))(enumerator, flow, 1, &collection));
            try
            {
                var count = ReadInt(collection, 3);
                for (var i = 0; i < count; i++)
                {
                    IntPtr endpoint;
                    Check(((delegate* unmanaged[Stdcall]<IntPtr, int, IntPtr*, int>)Slot(collection, 4))(collection, i, &endpoint));
                    var d = new Device { Endpoint = endpoint, Direction = flow == 0 ? "Render" : "Capture" };
                    devices.Add(d); // owns partial acquisitions on failure, too
                    d.Id = ReadString(endpoint, 5);
                    d.Default = d.Id == defaultId;
                    d.Name = Property(endpoint, interfaceFormat, 2);
                    d.Label = Property(endpoint, propertyFormat, 2);
                    if (d.Name.Length == 0) d.Name = Property(endpoint, propertyFormat, 14);
                    d.Alias = $"{d.Name}\\Device\\{d.Label}\\{d.Direction}";
                    d.Volume = Activate(endpoint, EndpointVolumeInterface);
                    d.VolumeEvents = new EndpointEvents(this);
                    d.VolumeCallback = Marshal.GetComInterfaceForObject<EndpointEvents, IEndpointEvents>(d.VolumeEvents);
                    Notify(d.Volume, 3, d.VolumeCallback);
                    d.Manager = Activate(endpoint, ManagerInterface);
                    d.SessionEvents = new CreatedEvents(this);
                    d.SessionCallback = Marshal.GetComInterfaceForObject<CreatedEvents, ICreatedEvents>(d.SessionEvents);
                    Notify(d.Manager, 6, d.SessionCallback);
                    // GetCount arms session-created delivery after registration.
                    var list = OutObject(d.Manager, 5);
                    try
                    {
                        var sessions = ReadInt(list, 3);
                        for (var j = 0; j < sessions; j++)
                        {
                            IntPtr control;
                            Check(((delegate* unmanaged[Stdcall]<IntPtr, int, IntPtr*, int>)Slot(list, 4))(list, j, &control));
                            AddSession(d, control);
                        }
                    }
                    finally { Drop(list); }
                }
            }
            finally { Drop(collection); }
        }
    }

    private void AddSession(Device d, IntPtr control)
    {
        var s = new Session { Control = control };
        try
        {
            if (ReadInt(control, 3) == 2) return;
            var ctl2 = Query(control, Control2Interface);
            try { s.Pid = ReadInt(ctl2, 14); s.Id = ReadString(ctl2, 13); }
            finally { Drop(ctl2); }
            if (s.Pid == 0) return;
            using var proc = Process.GetProcessById(s.Pid);
            if (proc.HasExited) return;
            s.Proc = proc.ProcessName;
            try { s.Path = proc.MainModule?.FileName ?? ""; } catch { }
            if (s.Path.Length == 0) s.Path = s.Proc + ".exe";
            s.Name = ReadString(control, 4);
            if (s.Name.Length == 0 || s.Name.StartsWith('@')) s.Name = s.Proc;
            s.Volume = Query(control, VolumeInterface);
            s.Events = new SessionEvents(this);
            s.Callback = Marshal.GetComInterfaceForObject<SessionEvents, ISessionEvents>(s.Events);
            Notify(control, 10, s.Callback);
            d.Sessions.Add(s);
            s = null!;
        }
        catch (ArgumentException) { /* process exited during enumeration */ }
        finally { s?.Dispose(); }
    }

    private List<object?> Rows()
    {
        var rows = new List<object?>();
        foreach (var d in devices)
        {
            rows.Add(Row(d.Label, "Device", d.Direction, d.Name, d.Default, "Active",
                ReadFloat(d.Volume, 9), ReadInt(d.Volume, 15) != 0, d.Id, "", 0));
            foreach (var s in d.Sessions)
            {
                try
                {
                    var state = ReadInt(s.Control, 3);
                    if (state == 2) continue;
                    rows.Add(Row(s.Name, "Application", d.Direction, d.Name, false, state == 1 ? "Active" : "Inactive",
                        ReadFloat(s.Volume, 4), ReadInt(s.Volume, 6) != 0, s.Id, s.Path, s.Pid));
                }
                catch (COMException) { Signal(true); }
            }
        }
        return rows;
    }

    private static string[] Row(string name, string type, string dir, string device, bool def, string state, float volume, bool mute, string id, string path, int pid)
    {
        var r = Enumerable.Repeat("", 22).ToArray();
        r[0] = name; r[1] = type; r[2] = dir; r[3] = device; r[4] = def ? dir : ""; r[7] = state;
        r[8] = mute ? "Yes" : "No"; r[10] = Math.Round(volume * 100).ToString(CultureInfo.InvariantCulture);
        r[18] = id; r[19] = path; r[20] = pid.ToString(CultureInfo.InvariantCulture);
        return r;
    }

    private void Publish()
    {
        var rows = Rows();
        var json = JsonOut.Serialize(new Dictionary<string, object?> { ["event"] = "audio", ["rows"] = rows });
        if (json == lastSnapshot) return;
        lastSnapshot = json;
        Console.WriteLine(json);
    }
    private static void Emit(Dictionary<string, object?> message) => Console.WriteLine(JsonOut.Serialize(message));

    private void Execute(string line)
    {
        var id = 0;
        try
        {
            using var doc = JsonDocument.Parse(line);
            var root = doc.RootElement;
            if (root.TryGetProperty("id", out var value)) id = value.GetInt32();
            var action = root.GetProperty("action").GetString();
            if (action == "exit") { exiting = true; return; }
            if (action == "snapshot")
            {
                Emit(new() { ["id"] = id, ["ok"] = true, ["rows"] = Rows() });
                return;
            }
            if (action != "command") throw new ArgumentException("Unknown action");
            var args = root.GetProperty("args").EnumerateArray().Select(x => x.GetString() ?? "").ToArray();
            if (args.Length < 2 || string.IsNullOrWhiteSpace(args[1])) throw new ArgumentException("Missing target");
            var verb = args[0]; var target = args[1];
            if (verb is not ("/SetVolume" or "/Mute" or "/Unmute" or "/Switch")) throw new ArgumentException("Unsupported command");
            float level = 0;
            if (verb == "/SetVolume" && (args.Length != 3 || !float.TryParse(args[2], CultureInfo.InvariantCulture, out level) || !float.IsFinite(level) || level < 0 || level > 100))
                throw new ArgumentException("Invalid volume");
            var matched = 0;
            foreach (var d in devices)
            {
                if (target.Equals(d.Id, StringComparison.OrdinalIgnoreCase) || target.Equals(d.Alias, StringComparison.OrdinalIgnoreCase) ||
                    (d.Default && target == (d.Direction == "Render" ? "DefaultRenderDevice" : "DefaultCaptureDevice")))
                { WriteVolume(d.Volume, true, verb, level); matched++; }
                foreach (var s in d.Sessions)
                {
                    if (target == s.Id || target.Equals(s.Proc + ".exe", StringComparison.OrdinalIgnoreCase) || target.Equals(s.Path, StringComparison.OrdinalIgnoreCase))
                    { WriteVolume(s.Volume, false, verb, level); matched++; }
                }
            }
            if (matched == 0) throw new ArgumentException("Audio target no longer exists");
            Emit(new() { ["id"] = id, ["ok"] = true });
            Signal();
        }
        catch (Exception e) { Emit(new() { ["id"] = id, ["ok"] = false, ["error"] = e.Message }); }
    }

    private static void WriteVolume(IntPtr p, bool endpoint, string verb, float level)
    {
        var context = Context;
        if (verb == "/SetVolume")
            Check(((delegate* unmanaged[Stdcall]<IntPtr, float, Guid*, int>)Slot(p, endpoint ? 7 : 3))(p, level / 100, &context));
        else
        {
            var mute = verb == "/Mute" || (verb == "/Switch" && ReadInt(p, endpoint ? 15 : 6) == 0);
            Check(((delegate* unmanaged[Stdcall]<IntPtr, int, Guid*, int>)Slot(p, endpoint ? 14 : 5))(p, mute ? 1 : 0, &context));
        }
    }

    public void Dispose()
    {
        Unnotify(enumerator, 7, deviceCallback);
        foreach (var d in devices) d.Dispose();
        Drop(deviceCallback); Drop(enumerator);
        // A callback already in flight may still signal. The process owns this
        // wait handle until exit, so do not dispose it under a callback thread.
        GC.KeepAlive(deviceEvents);
    }

    [ComVisible(true), Guid("641DD20B-4D41-49CC-ABA3-174B9477BB08"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ICreatedEvents { [PreserveSig] int OnSessionCreated(IntPtr session); }
    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    public sealed class CreatedEvents(AudioControlHost host) : ICreatedEvents
    { public int OnSessionCreated(IntPtr session) { host.Signal(true); return 0; } }

    [ComVisible(true), Guid("657804FA-D6AD-4496-8A60-352752AF4F89"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IEndpointEvents { [PreserveSig] int OnNotify(IntPtr data); }
    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    public sealed class EndpointEvents(AudioControlHost host) : IEndpointEvents
    { public int OnNotify(IntPtr data) { host.Signal(); return 0; } }

    [ComVisible(true), Guid("24918ACC-64B3-37C1-8CA9-74A66E9957A8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ISessionEvents
    {
        [PreserveSig] int OnDisplayNameChanged(IntPtr name, IntPtr context);
        [PreserveSig] int OnIconPathChanged(IntPtr path, IntPtr context);
        [PreserveSig] int OnSimpleVolumeChanged(float volume, int mute, IntPtr context);
        [PreserveSig] int OnChannelVolumeChanged(uint count, IntPtr volumes, uint channel, IntPtr context);
        [PreserveSig] int OnGroupingParamChanged(IntPtr grouping, IntPtr context);
        [PreserveSig] int OnStateChanged(int state);
        [PreserveSig] int OnSessionDisconnected(int reason);
    }
    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    public sealed class SessionEvents(AudioControlHost host) : ISessionEvents
    {
        public int OnDisplayNameChanged(IntPtr name, IntPtr context) { host.Signal(true); return 0; }
        public int OnIconPathChanged(IntPtr path, IntPtr context) => 0;
        public int OnSimpleVolumeChanged(float volume, int mute, IntPtr context) { host.Signal(); return 0; }
        public int OnChannelVolumeChanged(uint count, IntPtr volumes, uint channel, IntPtr context) => 0;
        public int OnGroupingParamChanged(IntPtr grouping, IntPtr context) => 0;
        public int OnStateChanged(int state) { host.Signal(state == 2); return 0; }
        public int OnSessionDisconnected(int reason) { host.Signal(true); return 0; }
    }

    [ComVisible(true), Guid("7991EEC9-7E89-4D85-8390-6C703CEC60C0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IDeviceEvents
    {
        [PreserveSig] int OnDeviceStateChanged(IntPtr id, uint state);
        [PreserveSig] int OnDeviceAdded(IntPtr id);
        [PreserveSig] int OnDeviceRemoved(IntPtr id);
        [PreserveSig] int OnDefaultDeviceChanged(int flow, int role, IntPtr id);
        [PreserveSig] int OnPropertyValueChanged(IntPtr id, PropertyKey key);
    }
    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    public sealed class DeviceEvents(AudioControlHost host) : IDeviceEvents
    {
        public int OnDeviceStateChanged(IntPtr id, uint state) { host.Signal(true); return 0; }
        public int OnDeviceAdded(IntPtr id) { host.Signal(true); return 0; }
        public int OnDeviceRemoved(IntPtr id) { host.Signal(true); return 0; }
        public int OnDefaultDeviceChanged(int flow, int role, IntPtr id) { host.Signal(true); return 0; }
        public int OnPropertyValueChanged(IntPtr id, PropertyKey key) { host.Signal(true); return 0; }
    }
}
