//! Give Game Bar a foreground window on the primary display during activation.
//! A background launcher cannot inherit the focus permission from Xenon's click.
use std::sync::atomic::{AtomicIsize, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

static GENERATION: AtomicU64 = AtomicU64::new(0);
static ANCHOR: AtomicIsize = AtomicIsize::new(0);

#[repr(C)]
#[derive(Default)]
struct Message {
    window: isize, message: u32, wparam: usize, lparam: isize,
    time: u32, x: i32, y: i32, private: u32,
}

#[link(name = "user32")]
extern "system" {
    fn GetForegroundWindow() -> isize;
    fn SetForegroundWindow(window: isize) -> i32;
    fn IsWindow(window: isize) -> i32;
    fn MonitorFromWindow(window: isize, flags: u32) -> isize;
    fn CreateWindowExW(ex_style: u32, class: *const u16, title: *const u16, style: u32,
        x: i32, y: i32, width: i32, height: i32, parent: isize, menu: isize,
        instance: isize, parameter: *const std::ffi::c_void) -> isize;
    fn ShowWindow(window: isize, command: i32) -> i32;
    fn DestroyWindow(window: isize) -> i32;
    fn SetLayeredWindowAttributes(window: isize, color: u32, alpha: u8, flags: u32) -> i32;
    fn PeekMessageW(message: *mut Message, window: isize, min: u32, max: u32, remove: u32) -> i32;
    fn TranslateMessage(message: *const Message) -> i32;
    fn DispatchMessageW(message: *const Message) -> isize;
}

struct Anchor { window: isize, previous: isize }
impl Drop for Anchor {
    fn drop(&mut self) {
        unsafe {
            // Never take focus back from Game Bar or another app selected by the user.
            if GetForegroundWindow() == self.window && IsWindow(self.previous) != 0 {
                SetForegroundWindow(self.previous);
            }
            DestroyWindow(self.window);
        }
        let _ = ANCHOR.compare_exchange(self.window, 0, Ordering::SeqCst, Ordering::SeqCst);
    }
}

fn pump() {
    let mut message = Message::default();
    unsafe {
        while PeekMessageW(&mut message, 0, 0, 0, 1) != 0 {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

fn create(app: &AppHandle) -> Result<Option<Anchor>, String> {
    let previous = unsafe { GetForegroundWindow() };
    let primary = unsafe { MonitorFromWindow(0, 1) };
    if primary == 0 { return Err("Windows primary display is unavailable.".into()); }
    if previous != 0 && previous != ANCHOR.load(Ordering::SeqCst)
        && unsafe { MonitorFromWindow(previous, 2) } == primary { return Ok(None); }
    let monitor = app.primary_monitor().map_err(|e| e.to_string())?
        .ok_or("Windows primary display is unavailable.")?;
    let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
    let title: Vec<u16> = "Xenon Crosshair launcher\0".encode_utf16().collect();
    let window = unsafe { CreateWindowExW(
        0x00080080, class.as_ptr(), title.as_ptr(), 0x80000000,
        monitor.position().x + monitor.size().width as i32 / 2,
        monitor.position().y + monitor.size().height as i32 / 2,
        16, 16, 0, 0, 0, std::ptr::null(),
    ) };
    if window == 0 { return Err(std::io::Error::last_os_error().to_string()); }
    let anchor = Anchor { window, previous };
    ANCHOR.store(window, Ordering::SeqCst);
    unsafe {
        // A real, nearly transparent window; no webview, taskbar item or GPU surface.
        if SetLayeredWindowAttributes(window, 0, 1, 2) == 0 {
            return Err("Could not prepare the primary display.".into());
        }
        ShowWindow(window, 1);
        SetForegroundWindow(window);
    }
    pump();
    if unsafe { GetForegroundWindow() } != window {
        return Err("Could not select the primary display. Click Xenon and try again.".into());
    }
    Ok(Some(anchor))
}

pub fn release(_app: &AppHandle) {
    GENERATION.fetch_add(1, Ordering::SeqCst);
}

pub fn prepare(app: &AppHandle) {
    // Sequence the intent on the navigation thread, then create and destroy the
    // Win32 window on its own pumping thread. Stale workers only retire their own window.
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let handle = app.clone();
    std::thread::spawn(move || {
        if GENERATION.load(Ordering::SeqCst) != generation { return; }
        let result = create(&handle);
        if GENERATION.load(Ordering::SeqCst) != generation { return; }
        if let Some(main) = handle.get_webview_window("main") {
            let value = serde_json::json!({ "ok": result.is_ok(), "error": result.as_ref().err() });
            let _ = main.eval(&format!(
                "if(window.XenonCrosshair)window.XenonCrosshair.onPrimaryReady({value});"
            ));
        }
        // Dashboard releases in finally. Bound the lease if it closes/reloads.
        if let Ok(Some(_anchor)) = result {
            let started = Instant::now();
            while GENERATION.load(Ordering::SeqCst) == generation
                && started.elapsed() < Duration::from_secs(25) {
                pump();
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    });
}
