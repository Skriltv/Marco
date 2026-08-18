use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use chrono::Local;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl};
use tauri::webview::WebviewBuilder;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Lets the frontend interrupt an in-progress `redeem_codes` run (the "Stop"
/// button). A simple flag checked between codes, rather than an abort
/// handle, so the current in-flight code always finishes cleanly instead of
/// being killed mid-submission.
#[derive(Default)]
pub struct RedeemState {
    pub cancel: AtomicBool,
}

pub fn macros_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("macros")))
        .unwrap_or_else(|| PathBuf::from("macros"))
}

fn bindings_path() -> PathBuf {
    macros_dir().join("_bindings.json")
}

fn profiles_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("profiles")))
        .unwrap_or_else(|| PathBuf::from("profiles"))
}

fn profile_slug(name: &str) -> String {
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() { "default".into() } else { slug }
}

/// Helper to parse hotkey strings reliably for Tauri (e.g. "Shift+X" -> "Shift+KeyX")
pub(crate) fn parse_shortcut(s: &str) -> Result<Shortcut, String> {
    if let Ok(sc) = s.parse::<Shortcut>() {
        return Ok(sc);
    }
    let mut parts: Vec<String> = s.split('+').map(|p| p.trim().to_string()).collect();
    if let Some(last) = parts.last_mut() {
        if last.len() == 1 && last.chars().next().unwrap().is_ascii_alphabetic() {
            *last = format!("Key{}", last.to_ascii_uppercase());
        }
    }
    for p in parts.iter_mut() {
        if p.eq_ignore_ascii_case("Ctrl") {
            *p = "Control".to_string();
        } else if p.eq_ignore_ascii_case("Win") {
            *p = "Super".to_string();
        }
    }
    let normalized = parts.join("+");
    normalized.parse::<Shortcut>().map_err(|e| format!("{e}"))
}

pub struct HotkeyState {
    pub ids: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct MacroFile {
    pub name: String,
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MacroBinding {
    pub name: String,
    pub file: String,
    pub hotkey: String,
    pub enabled: bool,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub click_x: Option<i32>,
    #[serde(default)]
    pub click_y: Option<i32>,
    #[serde(default)]
    pub inventory_key: Option<String>,
    #[serde(default)]
    pub close_with_esc: Option<bool>,
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    opener::open(&url).map_err(|e| format!("{e}"))
}

/// Launches the uninstaller next to the running exe (`uninstall.exe` for the
/// NSIS build, `unins000.exe` for the Inno Setup build) and quits Marco.
#[tauri::command]
pub fn uninstall_app(app: tauri::AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("{e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "Couldn't resolve app folder".to_string())?;

    let uninstaller = ["uninstall.exe", "Uninstall.exe", "unins000.exe"]
        .iter()
        .map(|name| dir.join(name))
        .find(|p| p.exists())
        .ok_or_else(|| "Couldn't find an uninstaller next to Marco.exe".to_string())?;

    std::process::Command::new(&uninstaller)
        .spawn()
        .map_err(|e| format!("Failed to launch uninstaller: {e}"))?;

    app.exit(0);
    Ok(())
}

#[tauri::command]
pub fn list_macros() -> Result<Vec<MacroFile>, String> {
    let dir = macros_dir();
    let _ = fs::create_dir_all(&dir);
    let mut files = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map_or(false, |e| e == "ahk") {
                files.push(MacroFile {
                    name: path.file_name().unwrap_or_default().to_string_lossy().into(),
                    path: path.to_string_lossy().into(),
                    size: entry.metadata().map(|m| m.len()).unwrap_or(0),
                });
            }
        }
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

#[tauri::command]
pub fn run_macro(path: String) -> Result<(), String> {
    let full = macros_dir().join(&path);
    if !full.exists() {
        return Err(format!("Macro not found: {}", full.display()));
    }
    opener::open(&full).map_err(|e| format!("Failed to run macro: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn save_bindings(bindings: Vec<MacroBinding>) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&bindings).map_err(|e| e.to_string())?;
    fs::write(bindings_path(), json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_bindings() -> Result<Vec<MacroBinding>, String> {
    match fs::read_to_string(bindings_path()) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| e.to_string()),
        Err(_) => Ok(Vec::new()),
    }
}

#[tauri::command]
pub fn open_macros_folder() -> Result<(), String> {
    let dir = macros_dir();
    let _ = fs::create_dir_all(&dir);
    opener::open(&dir).map_err(|e| format!("{e}"))
}

#[tauri::command]
pub fn open_app_folder() -> Result<(), String> {
    let dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .ok_or_else(|| "Couldn't resolve app folder".to_string())?;
    opener::open(&dir).map_err(|e| format!("{e}"))
}

#[tauri::command]
pub fn read_macro_content(name: String) -> Result<String, String> {
    let path = macros_dir().join(&name);
    fs::read_to_string(&path).map_err(|e| format!("{e}"))
}

#[tauri::command]
pub fn save_macro_content(name: String, content: String) -> Result<(), String> {
    let dir = macros_dir();
    let _ = fs::create_dir_all(&dir);
    let path = dir.join(&name);

    if path.exists() {
        let versions_dir = dir.join(".versions");
        let _ = fs::create_dir_all(&versions_dir);
        let ts = Local::now().format("%Y%m%d-%H%M%S");
        let stem = name.strip_suffix(".ahk").unwrap_or(&name);
        let backup_name = format!("{}.{}.ahk", stem, ts);
        let backup_path = versions_dir.join(&backup_name);
        if let Err(e) = fs::copy(&path, &backup_path) {
            eprintln!("Failed to backup {}: {}", name, e);
        }
    }

    fs::write(&path, content).map_err(|e| format!("{e}"))
}

#[tauri::command]
pub fn delete_macro(name: String) -> Result<(), String> {
    let path = macros_dir().join(&name);
    fs::remove_file(&path).map_err(|e| format!("{e}"))
}

#[tauri::command]
pub fn register_hotkeys(app: AppHandle, bindings: Vec<MacroBinding>) -> Result<(), String> {
    let state = app.state::<Mutex<HotkeyState>>();
    let gs = app.global_shortcut();
    {
        let mut hs = state.lock().map_err(|e| e.to_string())?;
        for id in hs.ids.drain(..) {
            if let Ok(sc) = parse_shortcut(&id) {
                let _ = gs.unregister(sc);
            }
        }
    }

    let mut ids = Vec::new();
    let macros_dir = macros_dir();

    for b in bindings {
        if !b.enabled || b.hotkey.is_empty() {
            continue;
        }
        let path = macros_dir.join(&b.file);
        let shortcut = b.hotkey.clone();
        let sc = match parse_shortcut(&shortcut) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("bad hotkey '{}': {}", shortcut, e);
                continue;
            }
        };
        let is_loadout = b.kind.as_deref() == Some("loadout");
        let register_result = if is_loadout {
            let click_x = b.click_x;
            let click_y = b.click_y;
            let inv_key = b.inventory_key.clone();
            let close_with_esc = b.close_with_esc.unwrap_or(false);
            let binding_name = b.name.clone();
            gs.on_shortcut(sc, move |app, _sc, ev| {
                if ev.state() == ShortcutState::Pressed {
                    let (Some(x), Some(y), Some(inv)) = (click_x, click_y, inv_key.clone())
                    else {
                        let _ = app.emit(
                            "loadout-swap-failed",
                            serde_json::json!({
                                "name": binding_name,
                                "reason": "Slot is missing a click position or Inventory Key",
                            }),
                        );
                        return;
                    };
                    let app2 = app.clone();
                    let name2 = binding_name.clone();
                    std::thread::spawn(move || {
                        if !crate::overlay::destiny_is_foreground() {
                            let _ = app2.emit(
                                "loadout-swap-failed",
                                serde_json::json!({
                                    "name": name2,
                                    "reason": "Destiny 2 isn't the focused window",
                                }),
                            );
                            return;
                        }
                        if let Err(e) =
                            crate::loadout::execute_loadout_swap(&inv, x, y, close_with_esc)
                        {
                            let _ = app2.emit(
                                "loadout-swap-failed",
                                serde_json::json!({ "name": name2, "reason": e }),
                            );
                        }
                    });
                }
            })
        } else {
            let path_clone = path.clone();
            gs.on_shortcut(sc, move |_app, _sc, ev| {
                if ev.state() == ShortcutState::Pressed {
                    let p = path_clone.clone();
                    std::thread::spawn(move || {
                        let _ = opener::open(&p);
                    });
                }
            })
        };
        match register_result {
            Ok(()) => ids.push(shortcut.clone()),
            Err(e) => eprintln!("failed to register hotkey {}: {}", shortcut, e),
        }
    }
    let mut hs = state.lock().map_err(|e| e.to_string())?;
    hs.ids = ids;
    Ok(())
}

pub fn start_file_watcher(app_handle: AppHandle) {
    use notify::{recommended_watcher, Event, RecursiveMode, Watcher};

    let dir = macros_dir();
    let _ = std::fs::create_dir_all(&dir);

    let h = app_handle.clone();
    let mut w = match recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(event) = res {
            let relevant = event.paths.iter().any(|p| {
                p.extension().map_or(false, |e| e == "ahk")
                    || p.file_name().map_or(false, |n| n == "_bindings.json")
            });
            if relevant {
                let _ = h.emit("macros-changed", ());
            }
        }
    }) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("Failed to create file watcher: {}", e);
            return;
        }
    };

    if let Err(e) = w.watch(&dir, RecursiveMode::NonRecursive) {
        eprintln!("Failed to watch macros dir: {}", e);
        return;
    }

    Box::leak(Box::new(w));
}

#[tauri::command]
pub async fn ensure_web_panel(
    app: AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    profile: Option<String>,
) -> Result<(), String> {
    if app.get_webview(&label).is_some() {
        return Ok(());
    }
    let parsed = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    let main = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    let app_handle = app.clone();
    let label_clone = label.clone();

    let mut builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(parsed))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        .disable_drag_drop_handler()
        .zoom_hotkeys_enabled(true)
        .initialization_script(
            "window.open = function(url) { if (url) location.href = url; return null; };",
        )
        .on_navigation(move |nav_url| {
            let u = nav_url.as_str();
            let is_oauth = u.contains("steampowered.com")
                || u.contains("playstation.com")
                || u.contains("live.com")
                || u.contains("xbox.com")
                || u.contains("epicgames.com")
                || u.contains("/User/SignIn")
                || u.contains("/login");
            let _ = app_handle.emit("web-panel-navigated", (label_clone.clone(), u.to_string(), is_oauth));
            true
        });

    if let Some(name) = profile {
        let dir = profiles_dir().join(profile_slug(&name));
        let _ = fs::create_dir_all(&dir);
        builder = builder.data_directory(dir);
    }

    main.add_child(
        builder,
        LogicalPosition::new(x, y),
        LogicalSize::new(width.max(1.0), height.max(1.0)),
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn set_web_panel_zoom(app: AppHandle, label: String, factor: f64) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        wv.set_zoom(factor.clamp(0.25, 3.0)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_web_panel_bounds(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        wv.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        wv.set_size(LogicalSize::new(width.max(1.0), height.max(1.0))).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn show_web_panel(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        wv.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn hide_web_panel(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        wv.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn close_web_panel(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        wv.close().map_err(|e| e.to_string())?;

        // `close()` only *requests* the webview tear down -- the platform
        // event loop removes it from `app`'s webview registry asynchronously
        // once it actually finishes destroying, which can take a tick or
        // more. If we return immediately, the caller (RedeemPanel's account
        // switch effect) turns around and calls `ensure_web_panel` right
        // away, which sees the label still registered and no-ops -- leaving
        // the OLD profile's webview (and its already-signed-in session) in
        // place instead of the new account's isolated one. That's the
        // "can't sign in on a different account" bug: the panel never
        // actually switches profiles, and any sign-in you complete gets
        // written into the wrong profile's cookie jar (or the request hits
        // Bungie with a session that doesn't match what the page thinks it
        // has, which is also consistent with the generic "you should
        // probably include a body" redeem errors). Block here until the
        // label is genuinely free (or give up after ~2s) so the caller's
        // subsequent ensure_web_panel is guaranteed to (re)create it fresh.
        for _ in 0..40 {
            if app.get_webview(&label).is_none() {
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn continue_signin(app: AppHandle, label: String, redeem_url: String) -> Result<(), String> {
    // Bungie's own sign-in flow lands on an interstitial page of its own
    // ("You're logged in! Continue to Bungie.net.") that requires that link
    // to actually be clicked -- that click is what finalizes the session,
    // not the redirect that got us here. The old nav-listener logic treated
    // ANY off-redeem-page bungie.net URL as "done signing in" and tore the
    // whole panel down (close + recreate) immediately, which killed this
    // page before the click could happen, so the session never finished
    // establishing and the freshly (re)opened redeem page just asked you to
    // sign in again. Fix: click the page's own "Continue" link/button in
    // place if one is visible; only fall back to a plain in-place navigate
    // to the redeem URL (still no panel teardown, so nothing gets
    // interrupted and no cookies that were just set get lost) if there's
    // nothing to click.
    let Some(wv) = app.get_webview(&label) else { return Ok(()) };
    let escaped = redeem_url.replace('\\', "\\\\").replace('\'', "\\'");
    let script = format!(
        r#"(function() {{
  try {{
    var re = /continue to bungie\.net|continue to the site|^continue$/i;
    var els = Array.from(document.querySelectorAll('a, button, [role="button"]'));
    var hit = els.find(function(el) {{
      var t = (el.textContent || '').trim();
      return re.test(t) && el.offsetParent !== null;
    }});
    if (hit) {{ hit.click(); }}
    else {{ location.href = '{url}'; }}
  }} catch (e) {{ location.href = '{url}'; }}
}})();"#,
        url = escaped
    );
    wv.eval(&script).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_profile(name: String) -> Result<(), String> {
    let dir = profiles_dir().join(profile_slug(&name));
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("{e}"))?;
    }
    Ok(())
}

// --- DIM login export / import (move a saved account's DIM login to another PC) ---

const DIM_URL: &str = "https://app.destinyitemmanager.com";
const TRANSFER_LABEL: &str = "dim-transfer";

/// Closes the transient `dim-transfer` webview and blocks until the label is
/// genuinely free (or gives up after ~2s), same teardown shape as
/// `close_web_panel`.
async fn close_transfer_webview(app: &AppHandle) {
    if let Some(wv) = app.get_webview(TRANSFER_LABEL) {
        let _ = wv.close();
        for _ in 0..40 {
            if app.get_webview(TRANSFER_LABEL).is_none() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }
}

/// Opens a hidden 1x1 off-screen webview on the given account `profile`,
/// pointed at DIM, and waits until it reaches the DIM origin so that profile's
/// `localStorage` is readable. Marco already runs several webviews on the same
/// `profiles/<slug>/` data directory at once (dim, godroll, redeem…), so a
/// transient one here doesn't conflict with the live DIM tab. Caller must
/// `close_transfer_webview` when finished.
async fn open_transfer_webview(
    app: &AppHandle,
    profile: Option<String>,
) -> Result<tauri::webview::Webview, String> {
    close_transfer_webview(app).await;

    let parsed = DIM_URL.parse().map_err(|e| format!("invalid url: {e}"))?;
    let main = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    let mut builder = WebviewBuilder::new(TRANSFER_LABEL, WebviewUrl::External(parsed))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36");

    if let Some(name) = profile {
        let dir = profiles_dir().join(profile_slug(&name));
        let _ = fs::create_dir_all(&dir);
        builder = builder.data_directory(dir);
    }

    main.add_child(
        builder,
        LogicalPosition::new(-10000.0, -10000.0),
        LogicalSize::new(1.0, 1.0),
    )
    .map_err(|e| e.to_string())?;

    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        if let Some(wv) = app.get_webview(TRANSFER_LABEL) {
            if let Ok(url) = wv.url() {
                if url
                    .host_str()
                    .map(|h| h.contains("destinyitemmanager.com"))
                    .unwrap_or(false)
                {
                    // Small extra beat so the document's localStorage is ready.
                    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                    return Ok(wv);
                }
            }
        }
    }

    // Origin check timed out — return the webview anyway if it exists; the
    // localStorage read below will simply report empty/failure if it isn't
    // usable, rather than hanging.
    app.get_webview(TRANSFER_LABEL)
        .ok_or_else(|| "Could not open the DIM session for that account".to_string())
}

/// Reads the chosen account's DIM `localStorage` (where DIM keeps its Bungie
/// login) into a compact copy-paste token. `profile` is the account id, or
/// `None` for the "Main" (default-session) account.
#[tauri::command]
pub async fn export_dim_login(app: AppHandle, profile: Option<String>) -> Result<String, String> {
    let wv = open_transfer_webview(&app, profile).await?;

    let reader = r#"(function() {
  try {
    var dump = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      dump[k] = localStorage.getItem(k);
    }
    var b64 = btoa(unescape(encodeURIComponent(JSON.stringify(dump))));
    location.hash = 'marco=' + encodeURIComponent(b64);
  } catch (e) {
    location.hash = 'marco=' + encodeURIComponent('ERR:' + (e && e.message ? e.message : e));
  }
})();"#;
    wv.eval(reader).map_err(|e| e.to_string())?;

    let mut result: Option<String> = None;
    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        let Some(wv) = app.get_webview(TRANSFER_LABEL) else { break };
        if let Ok(url) = wv.url() {
            if let Some(frag) = url.fragment() {
                if let Some(payload) = frag.strip_prefix("marco=") {
                    let decoded = pct_decode(payload);
                    let _ = wv.eval(
                        "history.replaceState(null, '', location.pathname + location.search);",
                    );
                    result = Some(decoded);
                    break;
                }
            }
        }
    }

    close_transfer_webview(&app).await;

    match result {
        Some(payload) if payload.starts_with("ERR:") => {
            Err(format!("Could not read the DIM login: {}", &payload[4..]))
        }
        Some(payload) => Ok(format!("marco-dim-1:{payload}")),
        None => Err("Timed out reading the DIM login (is that account signed in?)".into()),
    }
}

/// Writes a token produced by `export_dim_login` into the chosen account's DIM
/// `localStorage`. `profile` is the account id, or `None` for "Main".
#[tauri::command]
pub async fn import_dim_login(
    app: AppHandle,
    profile: Option<String>,
    token: String,
) -> Result<(), String> {
    let payload = token
        .trim()
        .strip_prefix("marco-dim-1:")
        .ok_or_else(|| "That doesn't look like a Marco DIM login token.".to_string())?
        .trim()
        .to_string();
    if payload.is_empty() {
        return Err("The token is empty.".into());
    }

    let wv = open_transfer_webview(&app, profile).await?;

    // Base64 is [A-Za-z0-9+/=] — no backslashes or quotes — but escape anyway
    // to be safe when embedding in the single-quoted JS string.
    let escaped = payload.replace('\\', "\\\\").replace('\'', "\\'");
    let writer = format!(
        r#"(function() {{
  try {{
    var json = decodeURIComponent(escape(atob('{payload}')));
    var map = JSON.parse(json);
    Object.keys(map).forEach(function(k) {{ try {{ localStorage.setItem(k, map[k]); }} catch (e) {{}} }});
    location.hash = 'marco=' + encodeURIComponent('OK');
  }} catch (e) {{
    location.hash = 'marco=' + encodeURIComponent('ERR:' + (e && e.message ? e.message : e));
  }}
}})();"#,
        payload = escaped
    );
    wv.eval(&writer).map_err(|e| e.to_string())?;

    let mut outcome: Option<String> = None;
    for _ in 0..40 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let Some(wv) = app.get_webview(TRANSFER_LABEL) else { break };
        if let Ok(url) = wv.url() {
            if let Some(frag) = url.fragment() {
                if let Some(p) = frag.strip_prefix("marco=") {
                    outcome = Some(pct_decode(p));
                    break;
                }
            }
        }
    }

    // Let WebView2 flush the localStorage writes to disk before teardown.
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    close_transfer_webview(&app).await;

    match outcome.as_deref() {
        Some(e) if e.starts_with("ERR:") => Err(format!("Import failed: {}", &e[4..])),
        // "OK", or no ack captured before teardown — the writes were fired, so
        // treat a missing ack as best-effort success rather than a hard error.
        _ => Ok(()),
    }
}

#[tauri::command]
pub async fn start_calibration_overlay(app: AppHandle, mode: Option<String>) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("calibrate") {
        let _ = w.close();
    }

    let page = if mode.as_deref() == Some("rect") {
        "calibrate.html?mode=rect"
    } else {
        "calibrate.html"
    };
    tauri::WebviewWindowBuilder::new(
        &app,
        "calibrate",
        tauri::WebviewUrl::App(page.into()),
    )
    .title("Calibrate")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .fullscreen(true)
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn report_calibration_click(app: AppHandle, x: i32, y: i32) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("calibrate") {
        let _ = w.close();
    }
    app.emit("calibration-result", (x, y)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn report_calibration_rect(app: AppHandle, x: i32, y: i32, w: u32, h: u32) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("calibrate") {
        let _ = win.close();
    }
    app.emit("calibration-rect", (x, y, w, h)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cancel_calibration(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("calibrate") {
        let _ = w.close();
    }
    app.emit("calibration-cancelled", ()).map_err(|e| e.to_string())
}

fn build_redeem_script(code: &str) -> String {
    let escaped = code.replace('\\', "\\\\").replace('\'', "\\'");
    format!(
        r#"(function() {{
  var report = function(ok, msg) {{
    try {{
      location.hash = 'marco=' + encodeURIComponent(JSON.stringify({{ ok: ok, msg: String(msg || '').slice(0, 160) }}));
    }} catch (e) {{}}
  }};
  try {{
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    var code = '{code}';
    var startHref = location.href;

    var startMain = function() {{
    var norm = function(s) {{ return (s || '').replace(/\s+/g, ' ').trim(); }};

    var findBtnByText = function(pattern, exclude) {{
      return Array.from(document.querySelectorAll('[role="button"], button, input[type="button"], input[type="submit"], a')).find(function(b) {{
        var t = norm(b.textContent || b.value || '');
        if (!pattern.test(t)) return false;
        if (exclude && exclude.test(t)) return false;
        return true;
      }});
    }};

    // Devtools confirmed the real submit control is specifically a
    // `<div role="button">Redeem Code</div>` — go straight for that,
    // filtering to only visible/attached candidates in case a stale or
    // hidden duplicate node is sitting in the DOM (common with
    // hydration frameworks) and we were grabbing the wrong one.
    var isNavTab = function(el) {{
      // The "REDEEM CODE" tab at the top of the page is an <a> with a
      // "...current..." class when active — it matches our text pattern
      // just as well as the real submit button, sits earlier in the DOM,
      // and clicking it (we're already on it) does nothing at all. Exclude
      // it explicitly rather than relying on match order.
      return el.tagName === 'A' && /\bcurrent\b|\bactive\b|\bselected\b/i.test(String(el.className || ''));
    }};
    var findRedeemButton = function() {{
      var candidates = Array.from(document.querySelectorAll('div[role="button"]')).filter(function(b) {{
        var t = norm(b.textContent || '');
        return /redeem code/i.test(t) && !/another/i.test(t) && b.offsetParent !== null;
      }});
      if (candidates.length) return candidates[candidates.length - 1];
      var pool = Array.from(document.querySelectorAll('[role="button"], button, input[type="button"], input[type="submit"], a'))
        .filter(function(b) {{ return !isNavTab(b); }});
      var exact = pool.filter(function(b) {{ return /^redeem code$/i.test(norm(b.textContent || b.value || '')); }});
      if (exact.length) return exact[exact.length - 1];
      var loose = pool.filter(function(b) {{
        var t = norm(b.textContent || b.value || '');
        return /redeem|submit|apply/i.test(t) && !/another/i.test(t);
      }});
      return loose.length ? loose[loose.length - 1] : undefined;
    }};

    var isEnabled = function(b) {{
      if (!b) return false;
      if (b.disabled) return false;
      if (b.getAttribute && b.getAttribute('aria-disabled') === 'true') return false;
      if (b.classList && (b.classList.contains('disabled') || b.classList.contains('is-disabled'))) return false;
      return true;
    }};

    // el.click() alone only fires a synthetic "click" event. The redesigned
    // bungie.net (note the "Marathon" nav tab) looks like it's built on a
    // modern component library, and those commonly bind button activation to
    // Pointer Events rather than legacy mouse events — so fire a full
    // pointer + mouse sequence, with real coordinates in case anything does
    // its own hit-testing, before falling back to click().
    var simulateClick = function(el) {{
      var r = el.getBoundingClientRect();
      var cx = r.left + r.width / 2;
      var cy = r.top + r.height / 2;
      var mouseOpts = {{ bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window }};
      var pointerOpts = Object.assign({{ pointerId: 1, pointerType: 'mouse', isPrimary: true }}, mouseOpts);
      ['pointerover', 'pointerenter', 'pointerdown'].forEach(function(type) {{
        try {{ el.dispatchEvent(new PointerEvent(type, pointerOpts)); }} catch (e) {{ /* PointerEvent unsupported in this webview — skip */ }}
      }});
      el.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
      try {{ el.dispatchEvent(new PointerEvent('pointerup', pointerOpts)); }} catch (e) {{}}
      el.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
      el.click();
    }};

    var nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

    // Pastes (not types) the value into the field: fires a real "paste"
    // clipboard event carrying the text, then sets the value directly so any
    // framework-controlled state stays in sync, then input/change/blur so
    // validation that listens for those still fires.
    var pasteIntoInput = function(input, value) {{
      input.focus({{ preventScroll: true }});
      try {{
        var dt = new DataTransfer();
        dt.setData('text/plain', value);
        var pasteEvent = new ClipboardEvent('paste', {{ bubbles: true, cancelable: true, clipboardData: dt }});
        input.dispatchEvent(pasteEvent);
      }} catch (e) {{ /* ClipboardEvent/DataTransfer construction can fail in some webviews — ignore and fall through */ }}
      nativeInputSetter.call(input, value);
      input.dispatchEvent(new Event('input', {{ bubbles: true }}));
      input.dispatchEvent(new Event('change', {{ bubbles: true }}));
      input.dispatchEvent(new Event('blur', {{ bubbles: true }}));
      input.focus({{ preventScroll: true }});
    }};

    var describeInput = function(i) {{
      return '<' + i.tagName.toLowerCase() +
        ' name=' + JSON.stringify(i.name || '') +
        ' id=' + JSON.stringify(i.id || '') +
        ' placeholder=' + JSON.stringify(i.placeholder || '') +
        ' maxlen=' + i.maxLength + '>';
    }};

    // Every visible text-ish input on the page, regardless of which one we
    // end up picking — kept around purely so a failure report can show what
    // the *other* candidates looked like, in case our heuristic below picked
    // the wrong one.
    var allVisibleInputs = Array.from(document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])'))
      .filter(function(i) {{ return i.offsetParent !== null; }});
    var allInputsDebug = allVisibleInputs.map(describeInput).join(' | ');

    var findCodeInputs = function() {{
      var all = allVisibleInputs;

      var named = all.filter(function(i) {{
        return /code/i.test(i.name || '') || /code/i.test(i.id || '') || /code/i.test(i.placeholder || '');
      }});
      var pool = named.length ? named : all;

      if (pool.length > 1) {{
        var segs = pool.filter(function(i) {{ return (i.maxLength > 0 && i.maxLength <= 6); }});
        if (segs.length >= 2) return segs;
      }}
      return pool.slice(0, 1);
    }};

    var attempts = 0;
    var process = function() {{
      var inputs = findCodeInputs();

      if (!inputs.length) {{
        // Same story as the submit button below: Bungie's redesigned page
        // binds this to Pointer Events, so a plain el.click() intermittently
        // does nothing — the page just sits on the previous result screen
        // with no code field in the DOM, which is exactly this "zero inputs
        // found" case. Use the full simulated pointer+mouse sequence here
        // too instead of a bare click().
        var retryAnother = findBtnByText(/redeem another code/i);
        if (retryAnother) simulateClick(retryAnother);

        attempts++;
        // Generous budget (~9s) since after a real click lands, the page
        // still has to re-render the fresh input — on a slow connection or
        // a sluggish page that can take longer than the old ~3s allowed.
        if (attempts < 45) {{
          setTimeout(process, 200);
          return;
        }}
        // By this point we're already confirmed to be ON the redeem page
        // (the sign-out case is caught separately, above, before we ever
        // get here) — so this isn't actually a sign-in problem. It means
        // the "Redeem Another Code" click never produced a fresh input
        // field in time. Report that plainly instead of pointing at the
        // wrong cause.
        report(false, 'page never showed a code input after clicking "Redeem Another Code" (not a sign-in issue) allInputsOnPage=[' + allInputsDebug + ']');
        return;
      }}

      if (inputs.length === 1) {{
        pasteIntoInput(inputs[0], code);
      }} else {{
        var parts = code.split('-');
        if (parts.length !== inputs.length) {{
          var per = Math.ceil(code.length / inputs.length);
          parts = [];
          for (var p = 0; p < inputs.length; p++) parts.push(code.slice(p * per, p * per + per));
        }}
        inputs.forEach(function(inp, idx) {{ pasteIntoInput(inp, parts[idx] || ''); }});
      }}

      // Debug breadcrumb: snapshot exactly which field(s) we pasted into and
      // what they show right after pasting. If a submission ever comes back
      // with "no body"/empty-code style errors, this tells us definitively
      // whether it's a wrong-field problem (values below are empty or don't
      // match `code`) or something else (values are correct, so the site
      // itself dropped the value before submit — e.g. it ignored our
      // synthetic paste/input events as untrusted).
      var inputSnapshot = 'chosen=[' + inputs.map(function(inp) {{
        return describeInput(inp) + '=' + JSON.stringify(inp.value);
      }}).join(',') + '] allCandidates=[' + allInputsDebug + ']';

      var waited = 0;
      var waitForButton = setInterval(function() {{
        waited += 150;
        var btn = findRedeemButton();
        if (btn && isEnabled(btn)) {{
          clearInterval(waitForButton);
          simulateClick(btn);

          var t0 = Date.now();
          var okRe = /success|redeemed|acquired|congrat|unlocked|has been applied/i;
          var failRe = /error|invalid|already|expired|used|too many|unable|not available|not a valid|failed/i;
          var poll = setInterval(function() {{
            var els = document.querySelectorAll(
              '[class*="error" i],[class*="success" i],[class*="message" i],[class*="alert" i],[class*="status" i],[role="alert"],[role="status"], div'
            );
            for (var i = 0; i < els.length; i++) {{
              var t = (els[i].textContent || '').trim();
              if (!t || t.length > 300) continue;
              if (okRe.test(t)) {{ clearInterval(poll); report(true, t); return; }}
              if (failRe.test(t)) {{ clearInterval(poll); report(false, t + ' [fields=' + inputSnapshot + ']'); return; }}
            }}
            if (Date.now() - t0 > 6500) {{
              clearInterval(poll);
              var dbg = findRedeemButton() ? 1 : 0;
              var navigated = location.href !== startHref;
              // If it navigated, the exact destination path tells us far more
              // than a page-text dump would (e.g. a sign-in bounce vs. a
              // "code redeemed" confirmation route). If it didn't navigate,
              // fall back to dumping whatever short text the message
              // selector actually saw this tick.
              var info;
              if (navigated) {{
                info = 'now at ' + location.pathname + location.search;
              }} else if (dbg) {{
                // Button is still sitting there untouched — the click had no
                // visible effect. Dump what the element actually is so we
                // can see why simulated events aren't landing, instead of
                // guessing at yet another event type blind.
                var bd = findRedeemButton();
                info = 'tag=' + bd.tagName.toLowerCase() +
                  ' type=' + (bd.getAttribute('type') || 'none') +
                  ' form=' + (bd.form ? 'yes' : 'no') +
                  ' cls=' + String(bd.className || '').slice(0, 55);
              }} else {{
                var seen = [];
                for (var j = 0; j < els.length && seen.length < 4; j++) {{
                  var tj = norm(els[j].textContent || '');
                  if (tj && tj.length <= 200 && seen.indexOf(tj) === -1) seen.push(tj);
                }}
                info = seen.length ? seen.join(' | ') : norm(document.body.innerText || '').slice(0, 180);
              }}
              report(false, 'no match (buttons=' + dbg + ', navigated=' + navigated + ', fields=' + inputSnapshot + '): ' + info);
            }}
          }}, 300);
          return;
        }}
        if (waited > 3000) {{
          clearInterval(waitForButton);
          report(false, btn ? ('submit button stayed disabled (tag=' + btn.tagName + ' role=' + (btn.getAttribute('role')||'') + ')') : 'no submit button found');
        }}
      }}, 150);
    }};

    var anotherBtn = findBtnByText(/redeem another code/i);
    if (anotherBtn) simulateClick(anotherBtn);
    setTimeout(process, anotherBtn ? 400 : 50);
    }}; // end startMain

    // The success confirmation for the PREVIOUS code can still be mid
    // client-side redirect when this script fires for the NEXT code,
    // which briefly parks location.pathname somewhere off /codes/redeem
    // even though the session is perfectly fine — that used to get
    // reported immediately as a false "signed out". Poll for up to ~2s
    // for the path to settle back onto the redeem page before actually
    // concluding we're signed out.
    var pageCheckAttempts = 0;
    var checkPage = function() {{
      if (/\/codes\/redeem/i.test(location.pathname)) {{
        startMain();
        return;
      }}
      pageCheckAttempts++;
      if (pageCheckAttempts < 10) {{
        setTimeout(checkPage, 200);
        return;
      }}
      report(false, 'not on redeem page (at ' + location.pathname + ') — likely signed out');
    }};
    checkPage();
  }} catch (err) {{ report(false, 'script error: ' + err); }}
}})();"#,
        code = escaped
    )
}

pub fn pct_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

async fn submit_code_and_wait(app: &AppHandle, label: &str, code: &str) -> Result<(bool, String), String> {
    let wv = app
        .get_webview(label)
        .ok_or_else(|| format!("Panel '{}' isn't open — open the Redeem tab first", label))?;
    wv.eval(&build_redeem_script(code)).map_err(|e| e.to_string())?;

    // Worst case in build_redeem_script: ~3s waiting for the submit button to
    // enable + ~6.5s polling for a result message + a little slack for the
    // "redeem another code" reset step = comfortably under 12s.
    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        let Some(wv) = app.get_webview(label) else { break };
        if let Ok(url) = wv.url() {
            if let Some(frag) = url.fragment() {
                if let Some(payload) = frag.strip_prefix("marco=") {
                    let decoded = pct_decode(payload);
                    let _ = wv.eval("history.replaceState(null, '', location.pathname + location.search);");
                    let parsed: serde_json::Value =
                        serde_json::from_str(&decoded).unwrap_or_else(|_| serde_json::json!({}));
                    let ok = parsed.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
                    let msg = parsed
                        .get("msg")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unrecognized result")
                        .to_string();
                    return Ok((ok, msg));
                }
            }
        }
    }
    Ok((false, "no result reported (page may have navigated)".into()))
}

#[tauri::command]
pub async fn redeem_codes(app: AppHandle, label: String, codes: Vec<String>) -> Result<(), String> {
    // Matches the message build_redeem_script reports when it finds itself
    // off the redeem page entirely (signed out / session bounce). Once we
    // see this once, every subsequent code will hit the exact same bounce,
    // so there's no point silently burning through the rest of the list.
    const SIGNED_OUT_MARK: &str = "not on redeem page";

    // Fresh run — clear any stale cancel request left over from a previous
    // (already-finished) run before we start checking it below.
    {
        let state = app.state::<RedeemState>();
        state.cancel.store(false, Ordering::Relaxed);
    }
    let is_cancelled = || app.state::<RedeemState>().cancel.load(Ordering::Relaxed);

    let total = codes.len();
    let mut failed: Vec<(String, String)> = Vec::new();
    let mut signed_out = false;
    let mut stopped = false;

    for (i, code) in codes.iter().enumerate() {
        if is_cancelled() { stopped = true; break; }
        let _ = app.emit("redeem-progress", (i, total, code.clone()));
        let (ok, msg) = submit_code_and_wait(&app, &label, code).await?;
        let _ = app.emit(
            "redeem-result",
            serde_json::json!({ "i": i, "total": total, "code": code, "ok": ok, "msg": msg.clone(), "retry": false }),
        );
        if !ok {
            failed.push((code.clone(), msg.clone()));
        }
        if msg.starts_with(SIGNED_OUT_MARK) {
            signed_out = true;
            break;
        }
        if is_cancelled() { stopped = true; break; }
        tokio::time::sleep(std::time::Duration::from_millis(1400)).await;
    }

    let retry_list = if signed_out || stopped { Vec::new() } else { std::mem::take(&mut failed) };
    let retry_total = retry_list.len();
    for (i, (code, _first_msg)) in retry_list.into_iter().enumerate() {
        if is_cancelled() { stopped = true; break; }
        let _ = app.emit("redeem-progress", (i, retry_total, code.clone()));
        let (ok, msg) = submit_code_and_wait(&app, &label, &code).await?;
        let _ = app.emit(
            "redeem-result",
            serde_json::json!({ "i": i, "total": retry_total, "code": code, "ok": ok, "msg": msg.clone(), "retry": true }),
        );
        if !ok {
            failed.push((code, msg.clone()));
        }
        if msg.starts_with(SIGNED_OUT_MARK) {
            signed_out = true;
            break;
        }
        if is_cancelled() { stopped = true; break; }
        tokio::time::sleep(std::time::Duration::from_millis(1400)).await;
    }

    let _ = app.emit(
        "redeem-complete",
        serde_json::json!({
            "submitted": total,
            "failed": failed.iter().map(|(c, m)| serde_json::json!({ "code": c, "msg": m })).collect::<Vec<_>>(),
            "signedOut": signed_out,
            "stopped": stopped,
        }),
    );
    Ok(())
}

/// Requests that the currently-running `redeem_codes` loop stop after it
/// finishes whichever code it's mid-submission on — invoked by the red
/// "Stop" button in the Redeem tab.
#[tauri::command]
pub fn stop_redeem(app: AppHandle) -> Result<(), String> {
    let state = app.state::<RedeemState>();
    state.cancel.store(true, Ordering::Relaxed);
    Ok(())
}