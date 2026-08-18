import { useState, useEffect } from "react";
import * as api from "../lib/api";
import { TAB_LABELS, type TabId, type TabPrefs } from "../lib/tabOrder";
import { THEMES, type ThemeId, applyTheme, loadTheme, saveTheme } from "../lib/theme";
import { tryUnlockExtraFeatures, lockExtraFeatures } from "../lib/extraFeatures";
import type { UpdateState } from "../lib/useUpdater";
import CreditsModal from "./CreditsModal";

const APP_VERSION = "1.0.0"; // auto-bumped by scripts/bump-version.mjs on every `pnpm tauri build`

const btn = "rounded border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-40 transition-colors";

const DIM_SEARCH_HOTKEY_KEY = "marco.dimSearchHotkey";

/** Same combo-capture format used elsewhere (OverlayPanel, LoadoutPanel), so the Rust-side Shortcut parser accepts it. */
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
  onClose: () => void;
  tabPrefs: TabPrefs;
  onTabPrefsChange: (prefs: TabPrefs) => void;
  extraFeaturesUnlocked: boolean;
  onExtraFeaturesUnlockedChange: (unlocked: boolean) => void;
  update: UpdateState;
  onCheckForUpdates: () => void;
  onInstallUpdate: () => void;
  onRestart: () => void;
}

export default function SettingsModal({
  onClose, tabPrefs, onTabPrefsChange, extraFeaturesUnlocked, onExtraFeaturesUnlockedChange,
  update, onCheckForUpdates, onInstallUpdate, onRestart,
}: Props) {
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  const [uninstallError, setUninstallError] = useState("");
  const [bungieApiKey, setBungieApiKey] = useState("");
  const [apiKeySaved, setApiKeySaved] = useState(false);
  const [extraFeaturesCode, setExtraFeaturesCode] = useState("");
  const [extraFeaturesMsg, setExtraFeaturesMsg] = useState("");
  const [dimSearchHotkey, setDimSearchHotkey] = useState(() => localStorage.getItem(DIM_SEARCH_HOTKEY_KEY) ?? "");
  const [bindingDimSearch, setBindingDimSearch] = useState(false);
  const [dimSearchStatus, setDimSearchStatus] = useState("");
  const [theme, setTheme] = useState<ThemeId>(loadTheme);
  const [creditsOpen, setCreditsOpen] = useState(false);

  function chooseTheme(id: ThemeId) {
    setTheme(id);
    saveTheme(id);
    applyTheme(id);
  }

  function moveTab(id: TabId, dir: -1 | 1) {
    const order = [...tabPrefs.order];
    const idx = order.indexOf(id);
    const swapWith = idx + dir;
    if (idx < 0 || swapWith < 0 || swapWith >= order.length) return;
    [order[idx], order[swapWith]] = [order[swapWith], order[idx]];
    onTabPrefsChange({ ...tabPrefs, order });
  }

  function toggleTabHidden(id: TabId) {
    const isHidden = tabPrefs.hidden.includes(id);
    // Keep at least one tab visible — otherwise there'd be nothing left in
    // the bar to click to get back in and undo it.
    if (!isHidden && tabPrefs.hidden.length >= tabPrefs.order.length - 1) return;
    const hidden = isHidden ? tabPrefs.hidden.filter(h => h !== id) : [...tabPrefs.hidden, id];
    onTabPrefsChange({ ...tabPrefs, hidden });
  }

  useEffect(() => {
    setBungieApiKey(api.loadBungieApiKey());
  }, []);

  // Persist + (re)register the DIM search hotkey whenever it changes.
  useEffect(() => { localStorage.setItem(DIM_SEARCH_HOTKEY_KEY, dimSearchHotkey); }, [dimSearchHotkey]);
  useEffect(() => {
    if (!dimSearchHotkey) { setDimSearchStatus(""); api.setDimSearchHotkey(null).catch(() => {}); return; }
    api.setDimSearchHotkey(dimSearchHotkey)
      .then(() => setDimSearchStatus(""))
      .catch(e => setDimSearchStatus(String(e)));
  }, [dimSearchHotkey]);

  // Capture the next keypress while binding the DIM search hotkey.
  useEffect(() => {
    if (!bindingDimSearch) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.key === "Escape") { setBindingDimSearch(false); return; }
      const combo = comboFromKeyEvent(e);
      if (!combo) return;
      setDimSearchHotkey(combo);
      setBindingDimSearch(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [bindingDimSearch]);

  function handleApiKeyChange(value: string) {
    setBungieApiKey(value);
    api.saveBungieApiKey(value);
    setApiKeySaved(true);
    setTimeout(() => setApiKeySaved(false), 2000);
  }

  function handleUnlockExtraFeatures() {
    if (tryUnlockExtraFeatures(extraFeaturesCode)) {
      onExtraFeaturesUnlockedChange(true);
      setExtraFeaturesCode("");
      setExtraFeaturesMsg("Unlocked.");
    } else {
      setExtraFeaturesMsg("That key doesn't match — try again.");
    }
  }

  function handleLockExtraFeatures() {
    lockExtraFeatures();
    onExtraFeaturesUnlockedChange(false);
    setExtraFeaturesMsg("");
  }

  async function handleUninstall() {
    setUninstallError("");
    try {
      await api.uninstallApp();
      // App exits itself on success (see uninstall_app in Rust).
    } catch (e) {
      setUninstallError(String(e));
      setConfirmingUninstall(false);
    }
  }

  function updateStatusText(): string {
    switch (update.kind) {
      case "idle": return "";
      case "checking": return "Checking...";
      case "up-to-date": return "You're on the latest version.";
      case "available": return "Update available: v" + update.version;
      case "downloading": return "Downloading update...";
      case "ready": return "Update installed — restart to finish.";
      case "error": return "Couldn't check for updates: " + update.message;
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-[480px] max-w-[90vw] flex-col rounded-lg border border-neutral-800 bg-neutral-900 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header - Fixed */}
        <div className="flex shrink-0 items-center justify-between border-b border-neutral-800 px-5 py-4">
          <h2 className="text-base font-semibold text-neutral-100">Settings</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
            aria-label="Close settings"
          >
            ✕
          </button>
        </div>

        {/* Content Body - Scrollable */}
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
          {/* Data locations */}
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-neutral-100">Data</h3>
            <p className="text-sm text-neutral-400">Where Marco keeps its files:</p>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between rounded border border-neutral-800 bg-neutral-950/40 px-3 py-3">
                <div>
                  <span className="text-sm font-semibold text-neutral-100">Macro Folder</span>
                  <p className="mt-1 text-sm text-neutral-400">.ahk scripts · bindings · version backups</p>
                </div>
                <button className={btn} onClick={() => api.openMacrosFolder().catch(() => {})}>
                  Open
                </button>
              </div>

              <div className="flex items-center justify-between rounded border border-neutral-800 bg-neutral-950/40 px-3 py-3">
                <div>
                  <span className="text-sm font-semibold text-neutral-100">App Location</span>
                  <p className="mt-1 text-sm text-neutral-400">folder next to the Marco executable</p>
                </div>
                <button className={btn} onClick={() => api.openAppFolder().catch(() => {})}>
                  Open
                </button>
              </div>
            </div>
          </section>

          <div className="border-t border-neutral-800" />

          {/* Appearance */}
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-neutral-100">Appearance</h3>
            <p className="text-sm text-neutral-400">Pick a background theme.</p>

            <div className="grid grid-cols-4 gap-3 rounded border border-neutral-800 bg-neutral-950/40 p-3">
              {THEMES.map(t => (
                <button
                  key={t.id}
                  title={t.label}
                  onClick={() => chooseTheme(t.id)}
                  className="flex flex-col items-center gap-1.5"
                >
                  <span
                    className={`h-9 w-9 rounded-full ring-offset-2 ring-offset-neutral-950 transition-all ${
                      theme === t.id ? "ring-2 ring-white" : "ring-0 hover:ring-2 hover:ring-neutral-600"
                    }`}
                    style={{ backgroundColor: t.swatch }}
                  />
                  <span className={`text-[11px] ${theme === t.id ? "text-neutral-100" : "text-neutral-500"}`}>
                    {t.label}
                  </span>
                </button>
              ))}
            </div>
          </section>

          <div className="border-t border-neutral-800" />

          {/* Tab order / visibility */}
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-neutral-100">Tab Order</h3>
            <p className="text-sm text-neutral-400">
              Reorder or hide tabs in the top bar. (Redeem stays put on the right.)
            </p>

            <div className="flex flex-col gap-1.5">
              {tabPrefs.order.map((id, idx) => {
                const hidden = tabPrefs.hidden.includes(id);
                return (
                  <div
                    key={id}
                    className={`flex items-center justify-between rounded border border-neutral-800 bg-neutral-950/40 px-3 py-2 ${hidden ? "opacity-50" : ""}`}
                  >
                    <span className="text-sm text-neutral-100">{TAB_LABELS[id]}</span>
                    <div className="flex items-center gap-1">
                      <button
                        title="Move up"
                        disabled={idx === 0}
                        className="rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-700 disabled:opacity-30"
                        onClick={() => moveTab(id, -1)}
                      >↑</button>
                      <button
                        title="Move down"
                        disabled={idx === tabPrefs.order.length - 1}
                        className="rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-700 disabled:opacity-30"
                        onClick={() => moveTab(id, 1)}
                      >↓</button>
                      <button
                        title={hidden ? "Off — tab is hidden. Click to show it." : "On — tab is visible. Click to hide it."}
                        onClick={() => toggleTabHidden(id)}
                        className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors ${
                          hidden
                            ? "border-red-800 bg-red-950/40 text-red-300 hover:bg-red-950/70"
                            : "border-emerald-700 bg-emerald-950/40 text-emerald-300 hover:bg-emerald-950/70"
                        }`}
                      >
                        <span
                          aria-hidden
                          className={`h-2 w-2 rounded-full ${hidden ? "bg-red-400" : "bg-emerald-400"}`}
                        />
                        {hidden ? "Off" : "On"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <div className="border-t border-neutral-800" />

          {/* Global hotkeys to quickly open panels */}
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-neutral-100">Hotkeys</h3>
            <p className="text-sm text-neutral-400">Global hotkeys to quickly open panels.</p>

            <div className="flex items-center justify-between rounded border border-neutral-800 bg-neutral-950/40 px-3 py-3">
              <div>
                <span className="text-sm font-semibold text-neutral-100">DIM — Search</span>
                <p className="mt-1 text-sm text-neutral-400">
                  Bring Marco to the front and focus DIM's search box
                </p>
                {dimSearchStatus && (
                  <p className="mt-1 text-sm text-red-400">{dimSearchStatus}</p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  className={
                    btn +
                    (bindingDimSearch ? " border-purple-800 bg-purple-900/40 text-purple-200" : "") +
                    (dimSearchStatus ? " border-red-800" : "")
                  }
                  onClick={() => setBindingDimSearch(true)}
                >
                  {bindingDimSearch ? "Press a key…" : (dimSearchHotkey || "Bind")}
                </button>
                {bindingDimSearch && (
                  <button className={btn} onClick={() => setBindingDimSearch(false)}>Cancel</button>
                )}
                {!bindingDimSearch && dimSearchHotkey && (
                  <button
                    className="rounded border border-red-900 bg-red-950/30 px-1.5 py-0.5 text-[10px] text-red-400 hover:bg-red-950/60"
                    title="Unbind the DIM search hotkey"
                    onClick={() => { setDimSearchHotkey(""); setDimSearchStatus(""); }}
                  >
                    {'\u2715'}
                  </button>
                )}
              </div>
            </div>
          </section>

          <div className="border-t border-neutral-800" />

          {/* Bungie API Key - Positioned above Updates */}
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-neutral-100">Bungie API Key</h3>
            <p className="text-sm text-neutral-400">
              (Dev Purposes) Connect a Bungie API key (register one at{" "}
              <button
                type="button"
                className="text-neutral-200 underline hover:text-white focus:outline-none"
                onClick={() => api.openUrl("https://www.bungie.net/en/Application").catch(() => {})}
              >
                bungie.net/en/Application
              </button>
              )
            </p>

            <div className="flex flex-col gap-1.5">
              <input
                type="password"
                className="w-full rounded border border-neutral-800 bg-neutral-950 p-2.5 font-mono text-xs text-neutral-100 placeholder-neutral-600 focus:border-purple-500 focus:outline-none"
                placeholder="Paste Bungie API Key..."
                value={bungieApiKey}
                onChange={e => handleApiKeyChange(e.target.value)}
                spellCheck={false}
              />
              <div className="flex items-center justify-between text-xs">
                <span className="text-neutral-500">
                  {apiKeySaved && <span className="text-emerald-400 font-medium">✓ Saved</span>}
                </span>
                {bungieApiKey && (
                  <button
                    className="text-neutral-400 hover:text-red-400 transition-colors ml-2 shrink-0"
                    onClick={() => handleApiKeyChange("")}
                  >
                    Clear key
                  </button>
                )}
              </div>
            </div>
          </section>

          <div className="border-t border-neutral-800" />

          {/* Extra Features unlock — hidden features (e.g. the DIM login
              export/import bar) stay off until this code is entered. */}
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-neutral-100">Test Features</h3>
            <p className="text-sm text-neutral-400">
              Enter an unlock key to reveal test features.
            </p>

            {extraFeaturesUnlocked ? (
              <div className="flex items-center justify-between rounded border border-emerald-900 bg-emerald-950/30 px-3 py-2.5">
                <span className="flex items-center gap-1.5 text-sm text-emerald-300">
                  <span aria-hidden className="h-2 w-2 rounded-full bg-emerald-400" />
                  Unlocked
                </span>
                <button className={btn} onClick={handleLockExtraFeatures}>Lock</button>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    className="w-full rounded border border-neutral-800 bg-neutral-950 p-2.5 font-mono text-xs text-neutral-100 placeholder-neutral-600 focus:border-purple-500 focus:outline-none"
                    placeholder="Enter unlock key..."
                    value={extraFeaturesCode}
                    onChange={e => { setExtraFeaturesCode(e.target.value); setExtraFeaturesMsg(""); }}
                    onKeyDown={e => { if (e.key === "Enter") handleUnlockExtraFeatures(); }}
                    spellCheck={false}
                  />
                  <button className={btn + " shrink-0"} onClick={handleUnlockExtraFeatures}>Unlock</button>
                </div>
                {extraFeaturesMsg && (
                  <span className={extraFeaturesMsg.startsWith("Unlocked") ? "text-xs text-emerald-400" : "text-xs text-red-400"}>
                    {extraFeaturesMsg}
                  </span>
                )}
              </div>
            )}
          </section>

          <div className="border-t border-neutral-800" />

          {/* Updates */}
          <section className="flex flex-col gap-2 pb-2">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-sm font-semibold text-neutral-100">Updates</h3>
                <p className="mt-0.5 text-sm text-neutral-400">Marco v{APP_VERSION}</p>
              </div>
              {update.kind === "available" ? (
                <button
                  className={btn + " border-purple-800 bg-purple-900/40 hover:bg-purple-900/70 text-purple-200"}
                  onClick={onInstallUpdate}
                >
                  Download &amp; install v{update.version}
                </button>
              ) : update.kind === "ready" ? (
                <button
                  className={btn + " border-purple-800 bg-purple-900/40 hover:bg-purple-900/70 text-purple-200"}
                  onClick={onRestart}
                >
                  Restart now
                </button>
              ) : (
                <button
                  className={btn}
                  disabled={update.kind === "checking" || update.kind === "downloading"}
                  onClick={onCheckForUpdates}
                >
                  {update.kind === "checking" ? "Checking..." : "Check for updates"}
                </button>
              )}
            </div>
            {update.kind !== "idle" && (
              <p className="text-sm text-neutral-400">{updateStatusText()}</p>
            )}

            <div className="mt-1 flex items-center justify-between">
              <p className="text-sm text-neutral-400">
                {confirmingUninstall ? "Uninstall Marco? This closes the app and opens the uninstaller." : "Remove Marco from this computer."}
              </p>
              {confirmingUninstall ? (
                <div className="flex gap-2">
                  <button
                    className={btn}
                    onClick={() => setConfirmingUninstall(false)}
                  >
                    Cancel
                  </button>
                  <button
                    className={btn + " border-red-800 bg-red-900/40 hover:bg-red-900/70 text-red-200"}
                    onClick={handleUninstall}
                  >
                    Confirm uninstall
                  </button>
                </div>
              ) : (
                <button
                  className={btn + " border-red-900/60 text-red-300 hover:bg-red-900/30"}
                  onClick={() => setConfirmingUninstall(true)}
                >
                  Uninstall
                </button>
              )}
            </div>
            {uninstallError && (
              <p className="text-sm text-red-400">Couldn't uninstall: {uninstallError}</p>
            )}
          </section>

          <div className="border-t border-neutral-800" />

          {/* Credits */}
          <section className="flex flex-col gap-2 pb-2">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-neutral-100">Credits</h3>
                <p className="mt-0.5 text-sm text-neutral-400">Who made Marco</p>
              </div>
              <button className={btn} onClick={() => setCreditsOpen(true)}>
                View credits
              </button>
            </div>
          </section>
        </div>
      </div>

      {creditsOpen && <CreditsModal onClose={() => setCreditsOpen(false)} />}
    </div>
  );
}