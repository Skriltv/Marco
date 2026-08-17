// Thin wrappers over Tauri commands.

import { invoke } from "@tauri-apps/api/core";

export interface MacroFile {
  name: string;
  path: string;
  size: number;
}

export interface MacroBinding {
  name: string;
  file: string;
  hotkey: string;
  enabled: boolean;
  /** "loadout" = native Loadout Swapper slot (no AutoHotkey needed); absent = regular .ahk macro. */
  kind?: "loadout" | "macro";
  clickX?: number;
  clickY?: number;
  inventoryKey?: string;
  /** When true, the swap closes the character screen with Esc instead of re-pressing the Inventory Key. */
  closeWithEsc?: boolean;
}

export function listMacros(): Promise<MacroFile[]> {
  return invoke<MacroFile[]>("list_macros");
}

export function runMacro(path: string): Promise<void> {
  return invoke<void>("run_macro", { path });
}

export function saveBindings(bindings: MacroBinding[]): Promise<void> {
  return invoke<void>("save_bindings", { bindings });
}

export function loadBindings(): Promise<MacroBinding[]> {
  return invoke<MacroBinding[]>("load_bindings");
}

export function openMacrosFolder(): Promise<void> {
  return invoke<void>("open_macros_folder");
}

export function openAppFolder(): Promise<void> {
  return invoke<void>("open_app_folder");
}

export function readMacroContent(name: string): Promise<string> {
  return invoke<string>("read_macro_content", { name });
}

export function saveMacroContent(name: string, content: string): Promise<void> {
  return invoke<void>("save_macro_content", { name, content });
}

export function deleteMacro(name: string): Promise<void> {
  return invoke<void>("delete_macro", { name });
}

export function registerHotkeys(bindings: MacroBinding[]): Promise<void> {
  return invoke<void>("register_hotkeys", { bindings });
}

export interface PanelBounds { x: number; y: number; width: number; height: number; }

export function ensureWebPanel(label: string, url: string, bounds: PanelBounds, profile?: string): Promise<void> {
  return invoke<void>("ensure_web_panel", { label, url, ...bounds, profile: profile ?? null });
}

export function closeWebPanel(label: string): Promise<void> {
  return invoke<void>("close_web_panel", { label });
}

/** Clicks a visible "Continue to Bungie.net"-style link in place, or soft-
 * navigates to redeemUrl if there isn't one — without tearing the panel
 * down, so a session that just got established isn't interrupted. */
export function continueSignIn(label: string, redeemUrl: string): Promise<void> {
  return invoke<void>("continue_signin", { label, redeemUrl });
}

export function deleteProfile(name: string): Promise<void> {
  return invoke<void>("delete_profile", { name });
}

/** Reads the given account's DIM login (its localStorage) into a copy-paste
 * token. `profile` is the account's profile id, or null for the "Main" account. */
export function exportDimLogin(profile: string | null): Promise<string> {
  return invoke<string>("export_dim_login", { profile: profile ?? null });
}

/** Writes a token from exportDimLogin into the given account's DIM login. */
export function importDimLogin(profile: string | null, token: string): Promise<void> {
  return invoke<void>("import_dim_login", { profile: profile ?? null, token });
}

export function setWebPanelBounds(label: string, bounds: PanelBounds): Promise<void> {
  return invoke<void>("set_web_panel_bounds", { label, ...bounds });
}

/** factor is a multiplier, e.g. 1.0 = 100%, 1.25 = 125%. */
export function setWebPanelZoom(label: string, factor: number): Promise<void> {
  return invoke<void>("set_web_panel_zoom", { label, factor });
}

export function showWebPanel(label: string): Promise<void> {
  return invoke<void>("show_web_panel", { label });
}

export function hideWebPanel(label: string): Promise<void> {
  return invoke<void>("hide_web_panel", { label });
}

export function startCalibrationOverlay(mode?: "point" | "rect"): Promise<void> {
  return invoke<void>("start_calibration_overlay", { mode: mode ?? null });
}

export function cancelCalibration(): Promise<void> {
  return invoke<void>("cancel_calibration");
}

export function redeemCodes(label: string, codes: string[]): Promise<void> {
  return invoke<void>("redeem_codes", { label, codes });
}

export function stopRedeem(): Promise<void> {
  return invoke<void>("stop_redeem");
}

// --- Overlay / OCR (phase 2) ---

export interface WeaponRecord {
  hash: number;
  name: string;
  icon: string;
  typeName: string;
  tierName: string;
  damageType: string;
  ammoType: string;
  archetype?: string;
  [key: string]: unknown;
}

export interface CaptureRegion { x: number; y: number; w: number; h: number; }

export interface OcrTestResult {
  png: string;
  text: string;
  match: { hash: number; name: string; score: number } | null;
}

export function getWeaponDb(force?: boolean): Promise<WeaponRecord[]> {
  return invoke<WeaponRecord[]>("get_weapon_db", { force: force ?? null });
}

export type OverlayPanelKind = "stats" | "perks";

export type RollSource = "d2ttk" | "community";

export function showOverlayPanels(
  hash: number,
  name: string,
  optimise?: string,
  panels?: OverlayPanelKind[],
  source?: RollSource,
  profile?: string,
): Promise<void> {
  return invoke<void>("show_overlay_panels", {
    hash, name,
    optimise: optimise ?? null,
    panels: panels ?? null,
    source: source ?? null,
    profile: profile ?? null,
  });
}

export function hideOverlay(): Promise<void> {
  return invoke<void>("hide_overlay");
}

export function resetOverlayLayout(): Promise<void> {
  return invoke<void>("reset_overlay_layout");
}

export function setOverlayOpacity(opacity: number): Promise<void> {
  return invoke<void>("set_overlay_opacity", { opacity });
}

export function setOverlayHotkey(combo: string | null, hideOnly: boolean = false): Promise<void> {
  return invoke<void>("set_overlay_hotkey", { combo, hideOnly });
}

export function setCalibrateHotkey(combo: string | null): Promise<void> {
  return invoke<void>("set_calibrate_hotkey", { combo });
}

export function disableAllHotkeys(): Promise<void> {
  return invoke<void>("disable_all_hotkeys");
}

export function setDimSearchHotkey(combo: string | null): Promise<void> {
  return invoke<void>("set_dim_search_hotkey", { combo });
}

export function setOverlaySettings(
  optimise: string,
  source: RollSource,
  panels: OverlayPanelKind[],
  profile?: string,
  region?: CaptureRegion | null,
): Promise<void> {
  return invoke<void>("set_overlay_settings", {
    optimise, source, panels,
    profile: profile ?? null,
    region: region ?? null,
  });
}

export function ocrTestCapture(region: CaptureRegion): Promise<OcrTestResult> {
  return invoke<OcrTestResult>("ocr_test_capture", { region });
}

export function startWeaponDetection(
  region: CaptureRegion,
  intervalMs?: number,
  optimise?: string,
  panels?: OverlayPanelKind[],
  source?: RollSource,
  profile?: string,
): Promise<void> {
  return invoke<void>("start_weapon_detection", {
    region,
    intervalMs: intervalMs ?? null,
    optimise: optimise ?? null,
    panels: panels ?? null,
    source: source ?? null,
    profile: profile ?? null,
  });
}

export function stopWeaponDetection(): Promise<void> {
  return invoke<void>("stop_weapon_detection");
}

export interface DetectOnceResult {
  ok: boolean;
  hash?: number;
  name?: string;
  score?: number;
  text: string;
}

export function setDetectHotkey(combo: string | null): Promise<void> {
  return invoke<void>("set_detect_hotkey", { combo });
}

// --- Bungie API Key Storage ---

const BUNGIE_API_KEY_STORAGE_KEY = "marco.bungieApiKey";

export function loadBungieApiKey(): string {
  try {
    return localStorage.getItem(BUNGIE_API_KEY_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function saveBungieApiKey(key: string): void {
  try {
    if (key.trim()) {
      localStorage.setItem(BUNGIE_API_KEY_STORAGE_KEY, key.trim());
    } else {
      localStorage.removeItem(BUNGIE_API_KEY_STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
}

export function openUrl(url: string): Promise<void> {
  return invoke<void>("open_url", { url });
}