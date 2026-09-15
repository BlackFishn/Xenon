# Xenon Crosshair for Xbox Game Bar

A local Windows crosshair widget controlled from Xenon’s System → FPS card.

## Use

1. Open **Win + G → Widgets → Xenon Crosshair** on the game display.
2. Pin the widget and enable Game Bar’s click-through option.
3. Press **Center on this screen**, then close the Game Bar interface.
4. In Xenon, open **System → FPS** and press **Crosshair ON/OFF**. The gear opens color, size (8–48), Center, and Open Game Bar controls.

Open Game Bar targets this widget directly when it is installed. Pinning, click-through, and the selected display remain Game Bar settings. The button only reports a successful change after the widget acknowledges it.

Color and size are saved. A fresh widget launch starts OFF. Closing Game Bar with the widget unpinned, suspending the widget, or ending its process makes Xenon report it unavailable after at most eight seconds. Reopen it from Win + G if necessary. Game Bar recreates the connection on the next widget launch. Cleanup is dispatched to the widget’s own UI thread.

The first version draws a plus with a black outline. The size uses Windows device-independent pixels. Rendering over a particular game, exclusive fullscreen mode, and exact pixel alignment with display scaling should be checked in that game.

## Build and install locally

Requirements:

- Windows 10 build 19041 or newer, x64, and Xbox Game Bar.
- Visual Studio Build Tools 2019 with `Microsoft.VisualStudio.ComponentGroup.UWP.BuildTools`, Windows SDK 10.0.19041, and the .NET Native toolchain.
- Developer Mode enabled by the PC owner for local unpackaged registration.
- Internet access during the initial NuGet restore.

From the repository root, in PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File apps/game-bar-crosshair/build.ps1 -Configuration Release -Register
```

The script restores pinned Microsoft packages, generates the logo assets, builds an unsigned MSIX, installs required Microsoft runtime dependencies if missing/older, unpacks the package beneath `%LOCALAPPDATA%\Xenon\GameBarCrosshair\<package-hash>`, and registers it for the current user. Updating closes only this package’s running application. It does not enable Developer Mode, create a trusted certificate, or change Xenon’s signed-update checks.

Increment the Identity Version in `Package.appxmanifest` before building an update; Windows can retain the old location if a changed package reuses its version. Omit `-Register` to build without installation. Debug is also available for development. This is a personal development package; the unsigned MSIX is not a double-click installer or a Store release.

For removal, uninstall **Xenon Crosshair** from Windows Installed apps. Re-register a previously built package with the same command after checking out its source to roll back.

## Integration

The UWP widget is independent of the Tauri shell. Xenon uses the Game Bar SDK rather than injecting code into the game.

- `GET /api/crosshair`: supported/installed/online status and current settings.
- `POST /api/crosshair`: validated enabled, color, size, or center command.
- `POST /api/crosshair/open`: request Game Bar activation.

All routes are denied to paired remote devices and protected by the existing loopback, Origin, and sandbox checks. Neither the widget nor this integration introduces a network listener.

The backend discovers one exact Xenon package identity in the current user’s Windows package storage. It rejects redirected storage and exchanges bounded JSON files in the package’s LocalState directory. Commands have unique IDs and expiry times; the widget validates them again. Writes use temporary files and rename. The widget polls commands twice per second while visible and publishes a heartbeat every two seconds. The UI checks status every five seconds only when the control is visible.

Microsoft references: [Game Bar SDK](https://learn.microsoft.com/en-us/xbox/game-bar/), [widget activation URI](https://learn.microsoft.com/en-us/xbox/game-bar/api/xgb-widgetcontrol), and [SDK samples](https://github.com/microsoft/XboxGameBarSamples). The SDK proxy-stub manifest declarations are adapted from the Microsoft samples; their MIT notice is included alongside this file.

## Verification

- Debug and .NET Native Release builds.
- 68 controller and remote-access tests, including stale status, command acknowledgement, timeouts, concurrent requests, invalid data, and redirected storage.
- Actual Game Bar command/readback: enable, disable, color, size, and center.
- Browser checks on 2560×720, 440×1100, 1920×1080, and 360×320: dialog overflow, repeated clicks, color changes, and failed-command feedback.
- Native screenshot inspection and game-specific fullscreen testing still need a manual check. The native UI automation tool was unavailable on the development machine.
