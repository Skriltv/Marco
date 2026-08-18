mod commands;
mod overlay;
mod loadout;

use commands::{
    list_macros, run_macro, save_bindings, load_bindings, open_macros_folder, open_app_folder,
    read_macro_content, save_macro_content, delete_macro, register_hotkeys, start_file_watcher,
    HotkeyState, ensure_web_panel, set_web_panel_bounds, show_web_panel, hide_web_panel,
    close_web_panel, delete_profile, continue_signin, start_calibration_overlay, report_calibration_click,
    report_calibration_rect, cancel_calibration, redeem_codes, stop_redeem, RedeemState, open_url,
    set_web_panel_zoom, export_dim_login, import_dim_login, uninstall_app,
};
use overlay::{
    get_weapon_db, get_community_godroll, show_overlay_panels, hide_overlay,
    reset_overlay_layout, set_overlay_opacity, get_overlay_data, set_overlay_hotkey,
    set_calibrate_hotkey, disable_all_hotkeys, set_overlay_settings, ocr_test_capture,
    start_weapon_detection, stop_weapon_detection, set_dim_search_hotkey, detect_once, set_detect_hotkey,
    WeaponDbState, DetectionState,
    OverlayDataState, OverlayHotkeyState, CalibrateHotkeyState, OverlaySettingsState, DimSearchHotkeyState,
    DetectHotkeyState,
};
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let _ = std::fs::create_dir_all(dir.join("macros"));
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Mutex::new(HotkeyState { ids: Vec::new() }))
        .manage(WeaponDbState { weapons: Mutex::new(Vec::new()) })
        .manage(DetectionState { running: Mutex::new(None) })
        .manage(OverlayDataState::default())
        .manage(OverlayHotkeyState::default())
        .manage(CalibrateHotkeyState::default())
        .manage(OverlaySettingsState::default())
        .manage(RedeemState::default())
        .manage(DimSearchHotkeyState::default())
        .manage(DetectHotkeyState::default())
        .setup(|app| {
            start_file_watcher(app.handle().clone());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                overlay::prewarm_overlay_windows(&handle);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    let _ = disable_all_hotkeys(window.app_handle().clone());
                    window.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            list_macros, run_macro,
            save_bindings, load_bindings,
            open_macros_folder,
            open_app_folder,
            read_macro_content, save_macro_content, delete_macro,
            register_hotkeys,
            ensure_web_panel, set_web_panel_bounds, show_web_panel, hide_web_panel,
            close_web_panel, delete_profile, continue_signin,
            set_web_panel_zoom, export_dim_login, import_dim_login,
            start_calibration_overlay, report_calibration_click, report_calibration_rect, cancel_calibration,
            redeem_codes, stop_redeem,
            get_weapon_db, get_community_godroll, show_overlay_panels,
            hide_overlay, reset_overlay_layout, set_overlay_opacity, get_overlay_data,
            set_overlay_hotkey, set_calibrate_hotkey, disable_all_hotkeys, set_overlay_settings,
            ocr_test_capture, start_weapon_detection, stop_weapon_detection,
            set_dim_search_hotkey,
            detect_once, set_detect_hotkey,
            open_url,
            uninstall_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Marco");
}

#[tauri::command]
fn app_version() -> String { env!("CARGO_PKG_VERSION").to_string() }