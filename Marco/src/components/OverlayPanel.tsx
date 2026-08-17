import { useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import * as api from "../lib/api";

const REGION_KEY = "marco.ocrRegion";
const OPACITY_KEY = "marco.overlayOpacity";
const PANELS_KEY = "marco.overlayPanels";
const OPTIMISE_KEY = "marco.optimiseMode";

const ALL_PANELS: { key: api.OverlayPanelKind; label: string }[] = [
  { key: "stats", label: "Stats + TTK" },
  { key: "perks", label: "Perks" },
];

const OPTIMISE_MODES: { key: string; label: string }[] = [
  { key: "off", label: "Off" },
  { key: "lowest-ttk", label: "Lowest TTK" },
  { key: "easiest-ttk", label: "Easiest TTK" },
  { key: "best-feel", label: "Best feel" },
  { key: "most-reliable", label: "Most reliable" },
  { key: "duelling", label: "Duelling" },
];

function loadPanels(): api.OverlayPanelKind[] {
  try {
    const raw = localStorage.getItem(PANELS_KEY);
    const list = raw ? (JSON.parse(raw) as string[]) : null;
    // "ttk" merged into "stats" — migrate old saved lists.
    const valid = (list ?? []).map(p => (p === "ttk" ? "stats" : p)).filter(
      (p, i, a) => (p === "stats" || p === "perks") && a.indexOf(p) === i,
    ) as api.OverlayPanelKind[];
    return valid.length ? valid : ["stats", "perks"];
  } catch { return ["stats", "perks"]; }
}

/** Old builds stored "lowest"/"easiest" — map to the d2ttk mode keys. */
function migrateOptimise(v: string): string {
  if (v === "lowest") return "lowest-ttk";
  if (v === "easiest") return "easiest-ttk";
  return v;
}

const SOURCE_KEY = "marco.rollSource";
const HOTKEY_KEY = "marco.overlayHotkey";
const HOTKEY_HIDE_ONLY_KEY = "marco.overlayHotkeyHideOnly";
const CALIBRATE_HOTKEY_KEY = "marco.calibrateHotkey";
const DETECT_HOTKEY_KEY = "marco.detectHotkey";
const HOTKEYS_ENABLED_KEY = "marco.hotkeysEnabled";

/** Same combo format the Rust Shortcut parser accepts (e.g. "Alt+X"). */
function comboFromKeyEvent(e: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  const key = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (["Control", "Alt", "Shift", "Meta"].includes(key)) return null;
  return [...mods, key].join("+");
}

interface Props {
  /** Active account profile id (for the godroll.tv session), undefined = Main. */
  profile?: string;
  /** Switches Marco to the GODROLL.tv tab so the user can sign in. */
  onOpenGodroll?: () => void;
}

function loadRegion(): api.CaptureRegion | null {
  try { const raw = localStorage.getItem(REGION_KEY); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
}

const btn = "rounded border border-neutral-700 bg-neutral-800 px-2.5 py-1 text-[11px] text-neutral-200 hover:bg-neutral-700 disabled:opacity-40 transition-colors";
const accent = "border-purple-800 bg-purple-900/40 hover:bg-purple-900/70 text-purple-200";
const numCls = "w-16 rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-[11px] font-mono text-neutral-100 focus:border-purple-500 focus:outline-none";
const selectCls = "w-full rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-[11px] text-neutral-200 focus:border-purple-500 focus:outline-none";
const fieldLabelCls = "text-[10px] font-medium uppercase tracking-wide text-neutral-500";

/** Label-above-control layout used to keep the settings grid aligned instead
 * of everything crammed onto one wrapping flex row. */
function Field({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: ReactNode }) {
  return (
    <div className={"flex min-w-0 flex-col gap-1" + (className ? " " + className : "")} title={hint}>
      <span className={fieldLabelCls}>{label}</span>
      {children}
    </div>
  );
}

export default function OverlayPanel({ profile, onOpenGodroll }: Props) {
  const [dbStatus, setDbStatus] = useState("Loading weapon database…");
  const [region, setRegion] = useState<api.CaptureRegion | null>(loadRegion);
  const [calibrating, setCalibrating] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [opacity, setOpacity] = useState(() => Number(localStorage.getItem(OPACITY_KEY) ?? 100));
  const [panels, setPanels] = useState<api.OverlayPanelKind[]>(loadPanels);
  const [optimise, setOptimise] = useState(() => migrateOptimise(localStorage.getItem(OPTIMISE_KEY) ?? "lowest-ttk"));
  const [source, setSource] = useState<api.RollSource>(
    () => (localStorage.getItem(SOURCE_KEY) === "community" ? "community" : "d2ttk"),
  );
  // Last weapon shown, so changing the optimise mode/source can re-run live.
  const lastWeaponRef = useRef<{ hash: number; name: string } | null>(null);
  const [needsGodrollLogin, setNeedsGodrollLogin] = useState(false);
  const [overlayHotkey, setOverlayHotkey] = useState(() => localStorage.getItem(HOTKEY_KEY) ?? "Alt+X");
  const [overlayHotkeyHideOnly, setOverlayHotkeyHideOnly] = useState(
    () => localStorage.getItem(HOTKEY_HIDE_ONLY_KEY) === "1",
  );
  const [bindingHotkey, setBindingHotkey] = useState(false);
  const [calibrateHotkey, setCalibrateHotkey] = useState(() => localStorage.getItem(CALIBRATE_HOTKEY_KEY) ?? "");
  const [bindingCalibrateHotkey, setBindingCalibrateHotkey] = useState(false);
  const [detectHotkey, setDetectHotkey] = useState(() => localStorage.getItem(DETECT_HOTKEY_KEY) ?? "");
  const [bindingDetectHotkey, setBindingDetectHotkey] = useState(false);
  const [hotkeysEnabled, setHotkeysEnabled] = useState(() => localStorage.getItem(HOTKEYS_ENABLED_KEY) !== "0");
  const [test, setTest] = useState<api.OcrTestResult | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [status, setStatus] = useState("");

  const regionRef = useRef(region);
  useEffect(() => { regionRef.current = region; if (region) localStorage.setItem(REGION_KEY, JSON.stringify(region)); }, [region]);
  useEffect(() => { localStorage.setItem(OPACITY_KEY, String(opacity)); }, [opacity]);
  useEffect(() => { localStorage.setItem(PANELS_KEY, JSON.stringify(panels)); }, [panels]);
  useEffect(() => { localStorage.setItem(OPTIMISE_KEY, optimise); }, [optimise]);
  useEffect(() => { localStorage.setItem(SOURCE_KEY, source); }, [source]);

  // Keep the detection loop's live settings in sync so changing the mode /
  // source / panels / capture region applies immediately — including a
  // recalibration made WHILE auto-detect is already running, which
  // previously had no effect until you stopped and restarted detection.
  useEffect(() => {
    api.setOverlaySettings(optimise, source, panels, profile, region).catch(() => {});
  }, [optimise, source, panels, profile, region]);
  useEffect(() => { localStorage.setItem(HOTKEY_KEY, overlayHotkey); }, [overlayHotkey]);
  useEffect(() => { localStorage.setItem(HOTKEY_HIDE_ONLY_KEY, overlayHotkeyHideOnly ? "1" : "0"); }, [overlayHotkeyHideOnly]);
  useEffect(() => { localStorage.setItem(CALIBRATE_HOTKEY_KEY, calibrateHotkey); }, [calibrateHotkey]);
  useEffect(() => { localStorage.setItem(DETECT_HOTKEY_KEY, detectHotkey); }, [detectHotkey]);
  useEffect(() => { localStorage.setItem(HOTKEYS_ENABLED_KEY, hotkeysEnabled ? "1" : "0"); }, [hotkeysEnabled]);

  // Register the global overlay-toggle shortcut (unless hotkeys are disabled).
  useEffect(() => {
    if (hotkeysEnabled && overlayHotkey) {
      api.setOverlayHotkey(overlayHotkey, overlayHotkeyHideOnly).catch(e => setStatus("Toggle hotkey: " + e));
    } else {
      api.setOverlayHotkey(null).catch(() => {});
    }
  }, [overlayHotkey, overlayHotkeyHideOnly, hotkeysEnabled]);

  // Register the global "DIM search" shortcut on launch (unless hotkeys are
  // disabled). This lives here — not in SettingsModal, where the hotkey is
  // bound/edited — because OverlayPanel is always mounted (App.tsx keeps
  // every tab mounted, just hidden), whereas SettingsModal only mounts once
  // the user opens Settings. Registering it only from SettingsModal meant a
  // fresh launch never actually armed the shortcut with Tauri until you
  // happened to open Settings that session. 
  useEffect(() => {
    const combo = localStorage.getItem("marco.dimSearchHotkey");
    if (hotkeysEnabled && combo) {
      api.setDimSearchHotkey(combo).catch(e => setStatus("DIM search hotkey: " + e));
    } else {
      api.setDimSearchHotkey(null).catch(() => {});
    }
  }, [hotkeysEnabled]);

  // Register the global "start calibration" shortcut (unless hotkeys are disabled).
  useEffect(() => {
    if (hotkeysEnabled && calibrateHotkey) {
      api.setCalibrateHotkey(calibrateHotkey).catch(e => setStatus("Calibrate hotkey: " + e));
    } else {
      api.setCalibrateHotkey(null).catch(() => {});
    }
  }, [calibrateHotkey, hotkeysEnabled]);

  // Register the global "Detect" shortcut (unless hotkeys are disabled).
  useEffect(() => {
    if (hotkeysEnabled && detectHotkey) {
      api.setDetectHotkey(detectHotkey).catch(e => setStatus("Detect hotkey: " + e));
    } else {
      api.setDetectHotkey(null).catch(() => {});
    }
  }, [detectHotkey, hotkeysEnabled]);

  // Capture the next keypress when rebinding the toggle hotkey.
  useEffect(() => {
    if (!bindingHotkey) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      // Escape is allowed as a bindable key here — use the Cancel button to
      // abort binding instead.
      const combo = comboFromKeyEvent(e);
      if (!combo) return;
      setOverlayHotkey(combo);
      setBindingHotkey(false);
      setStatus("Overlay toggle bound to " + combo);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [bindingHotkey]);

  // Capture the next keypress when rebinding the calibrate hotkey.
  useEffect(() => {
    if (!bindingCalibrateHotkey) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      const combo = comboFromKeyEvent(e);
      if (!combo) return;
      setCalibrateHotkey(combo);
      setBindingCalibrateHotkey(false);
      setStatus("Calibrate hotkey bound to " + combo);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [bindingCalibrateHotkey]);

  // Capture the next keypress when rebinding the "Detect" hotkey.
  useEffect(() => {
    if (!bindingDetectHotkey) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      const combo = comboFromKeyEvent(e);
      if (!combo) return;
      setDetectHotkey(combo);
      setBindingDetectHotkey(false);
      setStatus("Detect hotkey bound to " + combo);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [bindingDetectHotkey]);

  async function toggleHotkeysEnabled() {
    const next = !hotkeysEnabled;
    setHotkeysEnabled(next);
    try {
      if (!next) {
        await api.disableAllHotkeys();
        setStatus("All Marco hotkeys released — other apps can use those keys now.");
      } else {
        // Re-arm macro/loadout bindings + the overlay toggle + calibrate +
        // the DIM search hotkey (persisted by SettingsModal under its own
        // key, since it isn't part of this component's state).
        const bindings = await api.loadBindings();
        await api.registerHotkeys(bindings);
        if (overlayHotkey) await api.setOverlayHotkey(overlayHotkey, overlayHotkeyHideOnly);
        if (calibrateHotkey) await api.setCalibrateHotkey(calibrateHotkey);
        if (detectHotkey) await api.setDetectHotkey(detectHotkey);
        const dimSearchHotkey = localStorage.getItem("marco.dimSearchHotkey");
        if (dimSearchHotkey) await api.setDimSearchHotkey(dimSearchHotkey);
        setStatus("Marco hotkeys re-enabled.");
      }
    } catch (e) { setStatus("Failed: " + e); }
  }

  useEffect(() => {
    api.getWeaponDb()
      .then(db => setDbStatus(db.length + " weapons loaded (d2ttk database)"))
      .catch(e => setDbStatus("Weapon DB failed to load: " + e));

    const unRect = listen<[number, number, number, number]>("calibration-rect", (e) => {
      const [x, y, w, h] = e.payload;
      setRegion({ x, y, w, h });
      setCalibrating(false);
      setStatus("Capture region set: " + w + "×" + h + " at " + x + ", " + y);
    });
    const unCancel = listen("calibration-cancelled", () => setCalibrating(false));
    const unDetect = listen<boolean>("detection-state", (e) => setDetecting(e.payload));
    const unDetectOnce = listen<api.DetectOnceResult>("detect-once-result", (e) => {
      const r = e.payload;
      if (r.ok) {
        lastWeaponRef.current = { hash: r.hash ?? 0, name: r.name || "" };
        setStatus("Detected " + r.name + (r.score ? " (" + Math.round(r.score * 100) + "%)" : ""));
      } else {
        setStatus(r.text ? "No weapon matched (read: \"" + r.text + "\")" : "No weapon matched — nothing readable in the capture region");
      }
    });
    const unCommunity = listen<{ ok: boolean; error?: string }>("community-status", (e) => {
      setNeedsGodrollLogin(!e.payload.ok && e.payload.error === "login_required");
      if (!e.payload.ok) {
        const err = e.payload.error ?? "unknown";
        setStatus(
          err === "login_required"
            ? "Community godroll: log into godroll.tv in the GODROLL.tv tab first."
            : err === "not_enough_data"
              ? "Community godroll: not enough community rolls for this weapon."
              : "Community godroll failed: " + err,
        );
      }
    });
    return () => { unRect.then(f => f()); unCancel.then(f => f()); unDetect.then(f => f()); unDetectOnce.then(f => f()); unCommunity.then(f => f()); };
  }, []);

  /** Changing the mode re-optimises the currently shown weapon live. */
  async function changeOptimise(mode: string) {
    setOptimise(mode);
    const last = lastWeaponRef.current;
    if (last) {
      try { await api.showOverlayPanels(last.hash, last.name, mode, panels, source, profile); } catch { /* panels hidden */ }
    }
  }

  /** Switching data source re-renders the current weapon live. */
  async function changeSource(s: api.RollSource) {
    setSource(s);
    const last = lastWeaponRef.current;
    if (last) {
      setStatus(s === "community" ? "Loading community godroll…" : "Loading…");
      try {
        await api.showOverlayPanels(last.hash, last.name, optimise, panels, s, profile);
        setStatus("Overlay showing " + last.name);
      } catch (e) { setStatus("Failed: " + e); }
    }
  }

  function togglePanel(k: api.OverlayPanelKind) {
    setPanels(p => (p.includes(k) ? p.filter(x => x !== k) : [...p, k]));
  }

  async function calibrateRegion() {
    setCalibrating(true);
    setStatus("Drag a rectangle over where the weapon name appears (open the inspect screen first). Esc to cancel.");
    try { await api.startCalibrationOverlay("rect"); }
    catch (e) { setStatus("Failed: " + e); setCalibrating(false); }
  }

  async function runTestCapture() {
    if (!region) { setStatus("Set the capture region first"); return; }
    setTestBusy(true);
    setTest(null);
    try {
      const r = await api.ocrTestCapture(region);
      setTest(r);
      setStatus(r.match ? "Matched: " + r.match.name : r.text ? "No weapon matched" : "OCR read nothing — adjust the region");
    } catch (e) { setStatus("Test failed: " + e); }
    setTestBusy(false);
  }

  async function toggleDetection() {
    try {
      if (detecting) {
        await api.stopWeaponDetection();
        setStatus("Auto-detect stopped");
      } else {
        if (!region) { setStatus("Set the capture region first"); return; }
        if (panels.length === 0) { setStatus("Enable at least one panel first"); return; }
        await api.startWeaponDetection(region, 500, optimise, panels, source, profile);
        setStatus("Auto-detect running — inspect a weapon in Destiny 2 (borderless/windowed mode)");
      }
    } catch (e) { setStatus("Failed: " + e); }
  }

  async function applyOpacity(v: number) {
    setOpacity(v);
    try { await api.setOverlayOpacity(Math.round((v / 100) * 255)); } catch { /* overlay not created yet */ }
  }

  function updateRegion(field: keyof api.CaptureRegion, value: number) {
    if (!region || Number.isNaN(value)) return;
    setRegion({ ...region, [field]: value });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      <div>
        <h2 className="mb-1 text-sm font-semibold text-neutral-200">In-Game Roll Viewer</h2>
        <div className="text-[10px] text-neutral-600">{dbStatus}</div>
      </div>

      {status && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-neutral-400">
          <span className="min-w-0 break-all">{status}</span>
          {needsGodrollLogin && onOpenGodroll && (
            <button className={btn + " " + accent} onClick={onOpenGodroll}>Open GODROLL.tv tab</button>
          )}
        </div>
      )}

      {/* OCR capture region */}
      <div className="rounded border border-neutral-800 bg-neutral-900/50 p-3">
        <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span className="text-[11px] font-medium text-neutral-400">OCR capture region (weapon name area)</span>
          <span className="flex-1" />
          <div className="flex items-center gap-1.5">
            <button
              className={btn + (calibrating ? " " + accent : "")}
              onClick={calibrateRegion}
              title="Click to start calibration (Esc cancels the overlay)"
            >
              {region ? "Recalibrate" : "Calibrate"}
            </button>
            <button className={btn} disabled={!region || testBusy} onClick={runTestCapture}>
              {testBusy ? "Testing…" : "Test capture"}
            </button>
            <span className="mx-0.5 h-4 w-px bg-neutral-800" aria-hidden />
            <button
              className={btn + (bindingCalibrateHotkey ? " " + accent : "")}
              onClick={() => setBindingCalibrateHotkey(true)}
              title="Global hotkey to start calibration from anywhere, without alt-tabbing into Marco"
            >{bindingCalibrateHotkey ? "Press a key…" : "Key: " + (calibrateHotkey || "None")}</button>
            {bindingCalibrateHotkey && (
              <button className={btn} onClick={() => setBindingCalibrateHotkey(false)}>Cancel</button>
            )}
            {!bindingCalibrateHotkey && calibrateHotkey && (
              <button
                className="rounded border border-red-900 bg-red-950/30 px-1.5 py-0.5 text-[10px] text-red-400 hover:bg-red-950/60"
                title="Unbind the calibrate hotkey"
                onClick={() => { setCalibrateHotkey(""); setStatus("Calibrate hotkey cleared"); }}
              >{'\u2715'}</button>
            )}
          </div>
        </div>
        {region ? (
          <div className="flex items-center gap-2 text-[10px] text-neutral-500">
            {(["x", "y", "w", "h"] as const).map(f => (
              <label key={f} className="flex items-center gap-1">
                {f.toUpperCase()}
                <input
                  className={numCls}
                  type="number"
                  value={region[f]}
                  onChange={e => updateRegion(f, parseInt(e.target.value, 10))}
                />
              </label>
            ))}
          </div>
        ) : (
          <div className="text-[10px] text-neutral-600">
            Not set. Open a weapon's inspect screen in-game, then click Calibrate and drag a box around where the weapon's name is drawn.
          </div>
        )}
        {test && (
          <div className="mt-2 flex items-start gap-3 rounded border border-neutral-800 bg-neutral-950 p-2">
            <img src={"data:image/png;base64," + test.png} alt="capture" className="max-h-16 border border-neutral-700" />
            <div className="text-[10px]">
              <div className="text-neutral-400">OCR read: <span className="font-mono text-neutral-200">{test.text || "(nothing)"}</span></div>
              <div className={test.match ? "text-emerald-400" : "text-red-400"}>
                {test.match
                  ? "Matched " + test.match.name + " (" + Math.round(test.match.score * 100) + "%)"
                  : "No match ≥85%"}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Auto-detect + overlay options */}
      <div className="rounded border border-neutral-800 bg-neutral-900/50 p-3">
        <div className="mb-3 flex items-center gap-2">
          <span className="text-[11px] font-medium text-neutral-400">Auto-detect while playing</span>
          <span className="flex-1" />
          <button
            className={"rounded border px-2.5 py-1 text-[11px] font-medium transition-colors " + (detecting
              ? "border-purple-800 bg-purple-900/40 text-purple-200 hover:bg-purple-900/70"
              : "border-emerald-800 bg-emerald-900/30 text-emerald-300 hover:bg-emerald-900/60")}
            onClick={toggleDetection}
          >
            {detecting ? "Stop auto-detect" : "Start auto-detect"}
          </button>
        </div>
        {/* Display settings */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Field label="Opacity" className="col-span-2 sm:col-span-1">
            <div className="flex items-center gap-2">
              <input
                type="range" min={40} max={100} value={opacity}
                onChange={e => applyOpacity(Number(e.target.value))}
                className="w-full accent-purple-500"
              />
              <span className="w-8 shrink-0 font-mono text-[11px] text-neutral-300">{opacity}%</span>
            </div>
          </Field>
          <Field label="Panels" className="col-span-2 sm:col-span-1">
            <div className="flex flex-wrap gap-1.5">
              {ALL_PANELS.map(p => (
                <button
                  key={p.key}
                  className={btn + (panels.includes(p.key) ? " " + accent : "")}
                  onClick={() => togglePanel(p.key)}
                >{p.label}</button>
              ))}
            </div>
          </Field>
          <Field label="Source" hint="Community Godroll: most popular perks from godroll.tv community rolls (requires godroll.tv login)">
            <select
              className={selectCls + (source === "community" ? " border-yellow-700 text-yellow-200" : "")}
              value={source}
              onChange={e => changeSource(e.target.value as api.RollSource)}
            >
              <option value="d2ttk">D2TTK (PvP)</option>
              <option value="community">Community Godroll</option>
            </select>
          </Field>
          <Field label="Optimise" className={source === "community" ? "opacity-40 pointer-events-none" : ""}>
            <select className={selectCls} value={optimise} onChange={e => changeOptimise(e.target.value)}>
              {OPTIMISE_MODES.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </Field>
        </div>

        <div className="my-3 border-t border-neutral-800" />

        {/* Hotkeys */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Field label="Toggle key" hint="Global hotkey to show/hide the overlay from anywhere (Esc allowed, but may clash with the game's menu)">
            <div className="flex items-center gap-1.5">
              <button
                className={btn + " flex-1" + (bindingHotkey ? " " + accent : "")}
                onClick={() => setBindingHotkey(true)}
              >{bindingHotkey ? "Press a key…" : (overlayHotkey || "None")}</button>
              {bindingHotkey && (
                <button className={btn} onClick={() => setBindingHotkey(false)}>Cancel</button>
              )}
              {!bindingHotkey && overlayHotkey && (
                <button
                  className="shrink-0 rounded border border-red-900 bg-red-950/30 px-1.5 py-1 text-[10px] text-red-400 hover:bg-red-950/60"
                  title="Unbind the overlay toggle hotkey"
                  onClick={() => { setOverlayHotkey(""); setStatus("Overlay toggle hotkey cleared"); }}
                >{'\u2715'}</button>
              )}
            </div>
          </Field>
          <Field label="Detect key" hint="Global hotkey that does a single detect+show — the manual alternative to leaving auto-detect running. Only fires while Destiny 2 is focused.">
            <div className="flex items-center gap-1.5">
              <button
                className={btn + " flex-1" + (bindingDetectHotkey ? " " + accent : "")}
                onClick={() => setBindingDetectHotkey(true)}
              >{bindingDetectHotkey ? "Press a key…" : (detectHotkey || "None")}</button>
              {bindingDetectHotkey && (
                <button className={btn} onClick={() => setBindingDetectHotkey(false)}>Cancel</button>
              )}
              {!bindingDetectHotkey && detectHotkey && (
                <button
                  className="shrink-0 rounded border border-red-900 bg-red-950/30 px-1.5 py-1 text-[10px] text-red-400 hover:bg-red-950/60"
                  title="Unbind the detect hotkey"
                  onClick={() => { setDetectHotkey(""); setStatus("Detect hotkey cleared"); }}
                >{'\u2715'}</button>
              )}
            </div>
          </Field>
          <Field
            label="Hide only"
            hint="When on, the toggle key only hides the overlay — it won't bring it back. You'll need a weapon-inspect re-read (or the Hide overlay / Reset buttons) to show it again."
          >
            <button
              type="button"
              onClick={() => setOverlayHotkeyHideOnly(v => !v)}
              className={"flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors " + (overlayHotkeyHideOnly
                ? "border-emerald-700 bg-emerald-950/40 text-emerald-300 hover:bg-emerald-950/70"
                : "border-red-800 bg-red-950/40 text-red-300 hover:bg-red-950/70")}
            >
              <span aria-hidden className={"h-2 w-2 rounded-full " + (overlayHotkeyHideOnly ? "bg-emerald-400" : "bg-red-400")} />
              {overlayHotkeyHideOnly ? "On" : "Off"}
            </button>
          </Field>
          <Field label="Global hotkeys" hint="Turn OFF to release all of Marco's global shortcuts so another app can use those keys — without closing Marco.">
            <button
              className={btn + " w-fit" + (hotkeysEnabled ? "" : " border-amber-700 bg-amber-900/40 text-amber-200")}
              onClick={toggleHotkeysEnabled}
            >{hotkeysEnabled ? "ON" : "OFF"}</button>
          </Field>
        </div>

        <div className="my-3 border-t border-neutral-800" />

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          <button className={btn} onClick={() => api.hideOverlay().catch(() => {})}>Hide overlay</button>
          <button
            className={btn}
            title="Bring both panels back to default on-screen positions (fixes a panel lost off-screen or collapsed)"
            onClick={async () => {
              // Clear the saved (possibly collapsed/off-screen) layout, then reset.
              try { localStorage.removeItem("marco.overlayPos.stats"); localStorage.removeItem("marco.overlayPos.perks"); } catch { /* ignore */ }
              try {
                await api.resetOverlayLayout();
                const last = lastWeaponRef.current;
                if (last) await api.showOverlayPanels(last.hash, last.name, optimise, panels, source, profile);
                setStatus("Overlay layout reset.");
              } catch (e) { setStatus("Failed: " + e); }
            }}
          >Reset overlay layout</button>
        </div>

        <div className="mt-3 text-[10px] leading-relaxed text-neutral-600">
          Works in windowed/borderless fullscreen. Detection only runs while Destiny 2 is the focused window; the
          panels pop up when a weapon name is read and hide when you leave the inspect screen. Each panel drags
          independently by its title bar and resizes from its edges — positions are remembered. Press the toggle key
          (default Alt+X) anywhere to show/hide; ✕ or Esc on a focused panel also hides. Don't want continuous
          auto-detect running the whole session? Bind a Detect key to read the inspect screen just once, on demand.
        </div>
      </div>
    </div>
  );
}
