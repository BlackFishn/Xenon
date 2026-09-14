# XENEON EDGE Sleep / Wake for AJAZZ StreamDock

One key turns the EDGE display off; the next press wakes it. The key shows the
last confirmed **EDGE ON** or **EDGE OFF** state. Other displays, the computer,
video playback and the Windows monitor arrangement keep running.

Install from this directory with:

```powershell
rtk proxy powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1 -Install
```

Restart **Stream Dock AJAZZ**, then drag **XENEON EDGE > Sleep / Wake** onto a key.
No account, iCUE integration or settings are required. The plugin uses StreamDock's
bundled Node 20, the existing `ws` dependency (including its license), and a small
.NET Framework helper. It does not start a background service or poll the monitor.

The helper finds the monitor by the observed `CRXED00` hardware ID, not its
Windows display number. It refuses to act if no EDGE or multiple EDGE monitors
are found. DDC/CI power feature `0xD6` uses `4` for sleep and `1` for wake. The
tested device reports `2` while asleep. Wake can take a few seconds; rapid presses
are ignored until confirmation completes. If reads are unavailable, the next
press tries waking the EDGE. An amber key means the state could not be confirmed.

Recovery from another screen, if needed:

```powershell
rtk proxy powershell -NoProfile -Command "& '$env:APPDATA\HotSpot\StreamDock\plugins\com.custom.streamdock.xeneonedge.sdPlugin\plugin\EdgePower.exe' on"
```

The helper also accepts `status`, `toggle`, and `off`. Its output is JSON. It
does not modify brightness, contrast, inputs, USB configuration or display topology.

Validation: `rtk proxy node --test plugin.test.mjs`. Hardware support was checked
on the attached XENEON EDGE; a short sleep/wake cycle was confirmed by the owner.
The main AORUS and portrait LG displays stayed enumerated, and EDGE brightness
remained 95/100 afterward. Touch-to-wake is not required: use the AJAZZ key.

References: [Microsoft SetVCPFeature](https://learn.microsoft.com/en-us/windows/win32/api/lowlevelmonitorconfigurationapi/nf-lowlevelmonitorconfigurationapi-setvcpfeature),
[StreamDock plugin SDK](https://creator.key123.vip/en/guide/get-started.html).
