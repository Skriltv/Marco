//! Native input simulation for the Loadout Swapper.
//!
//! Ported step-for-step from the old (working) WPF app's Win32 SendInput /
//! keybd_event / mouse_event sequence — same keys, same delays — so a
//! loadout swap is fully self-contained and no longer needs AutoHotkey.exe
//! installed on the system.
//!
//! Why this exists: Marco's Loadouts tab previously piggy-backed on the
//! general-purpose Macros pipeline — it generated a per-slot `.ahk` script
//! and, on hotkey press, spawned `AutoHotkey.exe` to run it (see
//! `register_hotkeys` / `run_macro` in commands.rs). That's an optional
//! external dependency the old app never had, and if it isn't installed the
//! spawn just fails silently (only `eprintln!`'d, never surfaced to the UI)
//! — which is almost certainly why the Loadouts panel "doesn't work at all".
//! This module removes that dependency for loadout slots specifically; the
//! general Macros tab (arbitrary user `.ahk` scripts) is untouched.

use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

// Raw user32.dll bindings, mirroring the old app's P/Invoke declarations
// 1:1 (rather than pulling in extra `windows` crate features) so this stays
// simple to audit against the original working C#.

#[repr(C)]
struct KeybdInput {
    w_vk: u16,
    w_scan: u16,
    dw_flags: u32,
    time: u32,
    dw_extra_info: usize,
}

#[repr(C)]
struct MouseInput {
    dx: i32,
    dy: i32,
    mouse_data: u32,
    dw_flags: u32,
    time: u32,
    dw_extra_info: usize,
}

#[repr(C)]
union InputUnion {
    mi: std::mem::ManuallyDrop<MouseInput>,
    ki: std::mem::ManuallyDrop<KeybdInput>,
}

#[repr(C)]
struct Input {
    r#type: u32,
    u: InputUnion,
}

const INPUT_KEYBOARD: u32 = 1;

const KEYEVENTF_EXTENDEDKEY: u32 = 0x0001;
const KEYEVENTF_KEYUP: u32 = 0x0002;
const KEYEVENTF_SCANCODE: u32 = 0x0008;

const MOUSEEVENTF_MOVE: u32 = 0x0001;
const MOUSEEVENTF_LEFTDOWN: u32 = 0x0002;
const MOUSEEVENTF_LEFTUP: u32 = 0x0004;
const MOUSEEVENTF_ABSOLUTE: u32 = 0x8000;

const MAPVK_VK_TO_VSC: u32 = 0;
const VK_LEFT: u16 = 0x25;
const VK_ESCAPE: u8 = 0x1B;

const SM_CXSCREEN: i32 = 0;
const SM_CYSCREEN: i32 = 1;

#[link(name = "user32")]
extern "system" {
    fn SendInput(c_inputs: u32, p_inputs: *const Input, cb_size: i32) -> u32;
    fn keybd_event(b_vk: u8, b_scan: u8, dw_flags: u32, dw_extra_info: usize);
    fn mouse_event(dw_flags: u32, dx: u32, dy: u32, dw_data: u32, dw_extra_info: usize);
    fn MapVirtualKeyW(u_code: u32, u_map_type: u32) -> u32;
    fn GetSystemMetrics(n_index: i32) -> i32;
}

/// Same-frame key-down + key-up (mirrors the old app's plain `keybd_event`
/// tap for the Inventory Key).
fn tap_key(vk: u8) {
    unsafe {
        keybd_event(vk, 0, 0, 0);
        keybd_event(vk, 0, KEYEVENTF_KEYUP, 0);
    }
}

/// Scan-code-based keypress — sends a real hardware scan code via `SendInput`
/// rather than a virtual-key event, which is what games that read raw scan
/// codes (like Destiny 2) actually respond to. This is why the arrow key —
/// and Esc — go through here instead of `tap_key`. Set `extended` for keys in
/// the extended block (arrows, etc.); Esc is a normal key, so `extended` is
/// false for it. Mirrors the old app's `SendExtendedKeyPress`.
fn send_scancode_key(vk: u16, extended: bool) {
    let scan = unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) } as u16;
    let base_flags = if extended {
        KEYEVENTF_SCANCODE | KEYEVENTF_EXTENDEDKEY
    } else {
        KEYEVENTF_SCANCODE
    };
    let mut input = Input {
        r#type: INPUT_KEYBOARD,
        u: InputUnion {
            ki: std::mem::ManuallyDrop::new(KeybdInput {
                w_vk: 0,
                w_scan: scan,
                dw_flags: base_flags,
                time: 0,
                dw_extra_info: 0,
            }),
        },
    };
    unsafe { SendInput(1, &input, std::mem::size_of::<Input>() as i32) };
    thread::sleep(Duration::from_millis(40));
    unsafe {
        (*input.u.ki).dw_flags = base_flags | KEYEVENTF_KEYUP;
    }
    unsafe { SendInput(1, &input, std::mem::size_of::<Input>() as i32) };
}

/// Sends a single Escape keypress as a *full* key event: the virtual-key code
/// AND an explicit hardware scan code together (`dw_flags: 0`, so Windows
/// treats it like a real key with both fields populated), held ~60ms. This is
/// deliberately different from both `tap_key` (vk only, scan 0) and
/// `send_scancode_key` (scan only, vk 0) — earlier attempts using each of
/// those alone did not register in Destiny's Loadouts menu.
fn press_escape_once() {
    let scan = unsafe { MapVirtualKeyW(VK_ESCAPE as u32, MAPVK_VK_TO_VSC) } as u16;
    let mut input = Input {
        r#type: INPUT_KEYBOARD,
        u: InputUnion {
            ki: std::mem::ManuallyDrop::new(KeybdInput {
                w_vk: VK_ESCAPE as u16,
                w_scan: scan,
                dw_flags: 0,
                time: 0,
                dw_extra_info: 0,
            }),
        },
    };
    unsafe { SendInput(1, &input, std::mem::size_of::<Input>() as i32) };
    thread::sleep(Duration::from_millis(60));
    unsafe {
        (*input.u.ki).dw_flags = KEYEVENTF_KEYUP;
    }
    unsafe { SendInput(1, &input, std::mem::size_of::<Input>() as i32) };
}

/// Moves the cursor to an absolute screen pixel position. `mouse_event`'s
/// MOUSEEVENTF_ABSOLUTE flag wants coordinates normalized to 0..=65535
/// relative to the primary screen, not raw pixels — matches the old app's
/// `SetMousePos`.
pub(crate) fn set_mouse_pos(x: i32, y: i32) {
    let screen_w = unsafe { GetSystemMetrics(SM_CXSCREEN) }.max(1) as f64;
    let screen_h = unsafe { GetSystemMetrics(SM_CYSCREEN) }.max(1) as f64;
    let pos_x = ((x as f64) * (65535.0 / screen_w)) as u32;
    let pos_y = ((y as f64) * (65535.0 / screen_h)) as u32;
    unsafe { mouse_event(MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE, pos_x, pos_y, 0, 0) };
}

pub(crate) fn click() {
    unsafe {
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
    }
}

/// Resolves Marco's Inventory Key text (as typed/bound in the UI — a single
/// character like "I", or a function key like "F1") to a VK code. Extend
/// this list if you bind something it doesn't recognize yet.
fn vk_from_name(name: &str) -> Option<u8> {
    let n = name.trim();
    if n.chars().count() == 1 {
        let c = n.chars().next().unwrap().to_ascii_uppercase();
        if c.is_ascii_alphanumeric() {
            // VK codes for '0'-'9' and 'A'-'Z' are the same as their ASCII values.
            return Some(c as u8);
        }
    }
    match n.to_ascii_uppercase().as_str() {
        "F1" => Some(0x70), "F2" => Some(0x71), "F3" => Some(0x72), "F4" => Some(0x73),
        "F5" => Some(0x74), "F6" => Some(0x75), "F7" => Some(0x76), "F8" => Some(0x77),
        "F9" => Some(0x78), "F10" => Some(0x79), "F11" => Some(0x7A), "F12" => Some(0x7B),
        "TAB" => Some(0x09), "SPACE" => Some(0x20),
        _ => None,
    }
}

// Prevents overlapping swaps (e.g. holding a hotkey down, or two slots
// bound to the same key) from interleaving their keystrokes — mirrors the
// old app's `_isMacroExecuting` guard.
static SWAP_RUNNING: AtomicBool = AtomicBool::new(false);

/// Runs one loadout swap: open inventory, go to the Loadouts sub-tab, click
/// the calibrated slot position, close inventory. Blocking — takes ~1.1s.
/// Call from a background thread, never from the UI/event-loop thread.
///
/// `close_with_esc` picks the final keypress used to leave the character
/// screen: `false` re-presses the Inventory key (the original behavior),
/// `true` presses Esc instead (for players who close the inventory with Esc).
pub fn execute_loadout_swap(
    inventory_key: &str,
    x: i32,
    y: i32,
    close_with_esc: bool,
) -> Result<(), String> {
    if x == 0 && y == 0 {
        return Err("Slot isn't calibrated".into());
    }
    let inv_vk = vk_from_name(inventory_key)
        .ok_or_else(|| format!("Unrecognized Inventory Key '{inventory_key}'"))?;

    if SWAP_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("A loadout swap is already running".into());
    }
    let result = (|| {
        tap_key(inv_vk);
        thread::sleep(Duration::from_millis(700));

        send_scancode_key(VK_LEFT, true);
        thread::sleep(Duration::from_millis(250));

        set_mouse_pos(x, y);
        thread::sleep(Duration::from_millis(50));

        click();
        thread::sleep(Duration::from_millis(150));

        if close_with_esc {
            // Back out of the Loadouts sub-menu (stay in the inventory) rather
            // than closing the whole character screen. A single press only —
            // pressing twice backs out of the inventory entirely, which
            // defeats the point of this option. Uses a full vk+scancode key
            // event — see press_escape_once.
            press_escape_once();
        } else {
            tap_key(inv_vk);
        }
        Ok(())
    })();
    SWAP_RUNNING.store(false, Ordering::SeqCst);
    result
}

