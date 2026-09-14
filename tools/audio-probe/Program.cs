using System.Runtime.InteropServices;

// A dedicated silent output stream for repeatable mixer tests. Never opens the
// microphone and never writes volume settings belonging to another process.
internal static class Program
{
    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    private struct Format
    {
        public ushort Tag, Channels;
        public uint Rate, Bytes;
        public ushort Align, Bits, Extra;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Header
    {
        public IntPtr Data;
        public uint Length, Recorded;
        public UIntPtr User;
        public uint Flags, Loops;
        public IntPtr Next;
        public UIntPtr Reserved;
    }
    [DllImport("winmm.dll")] private static extern int waveOutOpen(out IntPtr handle, uint id, ref Format format, IntPtr callback, IntPtr instance, uint flags);
    [DllImport("winmm.dll")] private static extern int waveOutPrepareHeader(IntPtr handle, IntPtr header, uint size);
    [DllImport("winmm.dll")] private static extern int waveOutWrite(IntPtr handle, IntPtr header, uint size);
    [DllImport("winmm.dll")] private static extern int waveOutReset(IntPtr handle);
    [DllImport("winmm.dll")] private static extern int waveOutUnprepareHeader(IntPtr handle, IntPtr header, uint size);
    [DllImport("winmm.dll")] private static extern int waveOutClose(IntPtr handle);
    private static void Check(int code) { if (code != 0) throw new Exception("waveOut: " + code); }
    private static unsafe void Main(string[] args)
    {
        if (args.Length >= 2 && args[0] == "--cpu")
        {
            using var process = System.Diagnostics.Process.GetProcessById(int.Parse(args[1]));
            Console.WriteLine(process.TotalProcessorTime.TotalMilliseconds.ToString(System.Globalization.CultureInfo.InvariantCulture));
            return;
        }
        if (args.Length >= 2 && args[0] == "--measure")
        {
            var info = new System.Diagnostics.ProcessStartInfo(args[1]) { UseShellExecute = false, CreateNoWindow = true };
            foreach (var arg in args.Skip(2)) info.ArgumentList.Add(arg);
            var watch = System.Diagnostics.Stopwatch.StartNew();
            using var process = System.Diagnostics.Process.Start(info)!;
            _ = process.Handle;
            if (!process.WaitForExit(6000)) { process.Kill(); throw new Exception("Measurement child timed out"); }
            watch.Stop();
            Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new { cpuMs = process.TotalProcessorTime.TotalMilliseconds, wallMs = watch.Elapsed.TotalMilliseconds, exitCode = process.ExitCode }));
            return;
        }
        var format = new Format { Tag = 1, Channels = 1, Rate = 44100, Bytes = 88200, Align = 2, Bits = 16 };
        Check(waveOutOpen(out var handle, uint.MaxValue, ref format, IntPtr.Zero, IntPtr.Zero, 0));
        var data = Marshal.AllocHGlobal(88200);
        new Span<byte>((void*)data, 88200).Clear();
        var size = (uint)Marshal.SizeOf<Header>();
        var header = Marshal.AllocHGlobal((int)size);
        Marshal.StructureToPtr(new Header { Data = data, Length = 88200, Flags = 12, Loops = uint.MaxValue }, header, false);
        try
        {
            Check(waveOutPrepareHeader(handle, header, size));
            Check(waveOutWrite(handle, header, size));
            Console.WriteLine("ready");
            Console.ReadLine();
        }
        finally
        {
            waveOutReset(handle);
            waveOutUnprepareHeader(handle, header, size);
            waveOutClose(handle);
            Marshal.FreeHGlobal(header); Marshal.FreeHGlobal(data);
        }
    }
}
