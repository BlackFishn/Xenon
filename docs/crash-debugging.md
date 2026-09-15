# Native crash debug log

Quit Xenon from its tray menu, then launch the newly built shell with `--debug-log`,
or set `XENON_DEBUG_LOG=1` in its environment. A second launch only focuses the
existing process and cannot enable logging for it.

From the repository root after `cargo build --manifest-path apps/native/src-tauri/Cargo.toml`:

```powershell
& .\apps\native\src-tauri\target\debug\xenon-native.exe --debug-log
```

Open **Open crash log** in the tray, or
`%APPDATA%\com.marcimastro98.xenon\crash.log` on Windows. Save `crash.log` and
`crash.log.1` immediately after a crash. The log rotates at 64 KiB with one backup.
Every record includes UTC time and PID. On macOS the directory is
`~/Library/Application Support/com.marcimastro98.xenon`; on Linux it is
`$XDG_CONFIG_HOME/com.marcimastro98.xenon` (default `~/.config`).

Debug mode records setup milestones, page-load events, window focus/close,
background thread start/finish, and focus-guard mode/typing transitions. It does
not record typed text, URLs, or arbitrary launch arguments. Normal launch/exit
and panic records remain enabled. Quit and relaunch without the flag/environment
variable to disable verbose logging.

Note the local crash time, activity, whether a game was open, and monitor
sleep/wake or reconnect events. The last entry narrows the timeline but does
not prove the cause. Rust panic hooks cannot catch native heap corruption or
access violations. Preserve Windows Application Error / Windows Error Reporting
events and any OS crash dump, with the exact executable and matching PDB when
available. No exit/panic entry can also mean external termination or power loss.
Logging is best-effort and cannot guarantee a final record on abrupt termination.
