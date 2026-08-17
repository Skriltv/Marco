import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import * as api from "./lib/api";
import MacroPanel from "./components/MacroPanel";
import LoadoutPanel from "./components/LoadoutPanel";
import EmbeddedSitePanel, { type SitePanelSite } from "./components/EmbeddedSitePanel";
import RedeemPanel from "./components/RedeemPanel";
import OverlayPanel from "./components/OverlayPanel";
import SettingsModal from "./components/SettingsModal";
import WelcomeModal from "./components/WelcomeModal";
import { type Account, ACCOUNTS_KEY, ACTIVE_ACCOUNT_KEY, MAIN_ID, loadAccounts, profileForAccount, slugify } from "./lib/accounts";
import { type TabId, TAB_LABELS, loadTabPrefs, saveTabPrefs, type TabPrefs } from "./lib/tabOrder";
import { isExtraFeaturesUnlocked } from "./lib/extraFeatures";

const WELCOME_SEEN_KEY = "marco.welcomeSeen";

const DIM_SITES: SitePanelSite[] = [
  { id: "dim", webviewLabel: "dim", title: "Destiny Item Manager", url: "https://app.destinyitemmanager.com" },
];

const GODROLL_SITES: SitePanelSite[] = [
  { id: "godroll", webviewLabel: "godroll", title: "Godroll.tv", url: "https://godroll.tv" },
  { id: "d2ttk", webviewLabel: "godroll-d2ttk", title: "D2TTK", url: "https://d2ttk.com" },
  { id: "d2armorpicker", webviewLabel: "godroll-d2armorpicker", title: "D2ArmorPicker", url: "https://d2armorpicker.com" },
  { id: "d2checkpoint", webviewLabel: "godroll-d2checkpoint", title: "D2Checkpoint", url: "https://d2checkpoint.com" },
];

export default function App() {
  useEffect(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      getCurrentWindow().show().catch(() => {});
    }));
  }, []);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showWelcome, setShowWelcome] = useState(() => !localStorage.getItem(WELCOME_SEEN_KEY));
  function dismissWelcome() {
    localStorage.setItem(WELCOME_SEEN_KEY, "1");
    setShowWelcome(false);
 } 
  const [extraFeaturesUnlocked, setExtraFeaturesUnlocked] = useState(isExtraFeaturesUnlocked);

  const [tab, setTab] = useState<TabId>("loadouts");
  const [tabPrefs, setTabPrefs] = useState<TabPrefs>(loadTabPrefs);
  useEffect(() => { saveTabPrefs(tabPrefs); }, [tabPrefs]);

  useEffect(() => {
    const un = listen<string>("switch-tab", (e) => {
      const id = e.payload as TabId;
      if (tabPrefs.order.includes(id)) setTab(id);
    });
    return () => { un.then(f => f()); };
  }, []);
  const visibleTabs = tabPrefs.order.filter(id => !tabPrefs.hidden.includes(id));
  useEffect(() => {
    if (tabPrefs.hidden.includes(tab) && visibleTabs.length > 0) setTab(visibleTabs[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabPrefs]);

  const [accounts, setAccounts] = useState<Account[]>(loadAccounts);
  const [activeId, setActiveId] = useState<string>(
    () => localStorage.getItem(ACTIVE_ACCOUNT_KEY) ?? MAIN_ID,
  );
  const [addingAccount, setAddingAccount] = useState(false);
  const [renamingAccount, setRenamingAccount] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts)); }, [accounts]);
  useEffect(() => { localStorage.setItem(ACTIVE_ACCOUNT_KEY, activeId); }, [activeId]);

  const activeAccount = accounts.find(a => a.id === activeId) ?? accounts[0];

  const profile = profileForAccount(activeAccount.id);

  function addAccount(name: string) {
    const trimmed = name.trim();
    setAddingAccount(false);
    if (!trimmed) return;
    let id = slugify(trimmed);
    while (accounts.some(a => a.id === id) || id === MAIN_ID.toLowerCase()) id += "-2";
    setAccounts([...accounts, { id, name: trimmed }]);
    setActiveId(id);
  }

  function renameActiveAccount(name: string) {
    setRenamingAccount(false);
    const trimmed = name.trim();
    if (!trimmed) return;
    setAccounts(accounts.map(a => (a.id === activeAccount.id ? { ...a, name: trimmed } : a)));
  }

  async function removeActiveAccount() {
    setConfirmRemove(false);
    if (activeAccount.id === MAIN_ID) return;
    const removed = activeAccount.id;
    setAccounts(accounts.filter(a => a.id !== removed));
    setActiveId(MAIN_ID);
    try { await api.deleteProfile(removed); } catch { /* folder may be locked until restart */ }
  }

  const tabCls = (t: TabId) => `px-4 py-1.5 text-xs font-semibold uppercase tracking-wide border-b-2 transition-colors cursor-default ${
    tab === t ? "border-purple-400 text-purple-300" : "border-transparent text-neutral-500 hover:text-neutral-300"
  }`;

  async function minimize() { await getCurrentWindow().minimize(); }
  async function closeWin() { await getCurrentWindow().close(); }

  const show = (t: TabId) => ({ display: tab === t ? "flex" : "none" }) as const;

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      {/* Title bar */}
      <div data-tauri-drag-region className="flex h-8 shrink-0 items-center justify-between border-b border-neutral-800 bg-neutral-900/60 px-3 select-none">
        <span className="text-xs font-semibold tracking-wide text-neutral-200">Marco</span>
        <div className="flex items-center gap-1" data-tauri-drag-region={false}>
          <button onClick={minimize} className="rounded px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200">–</button>
          <button onClick={closeWin} className="rounded px-2 py-0.5 text-xs text-neutral-500 hover:bg-red-900/50 hover:text-red-300">✕</button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center border-b border-neutral-800 bg-neutral-900/60 px-4" data-tauri-drag-region={false}>
        {visibleTabs.map(id => (
          <button key={id} className={tabCls(id)} onClick={() => setTab(id)}>{TAB_LABELS[id]}</button>
        ))}
        <span className="flex-1" />
        <div className="mr-3 flex items-center gap-1 text-[11px]">
          <span className="text-neutral-600">Account:</span>
          {addingAccount || renamingAccount ? (
            <input
              autoFocus
              className="w-24 rounded border border-purple-600 bg-neutral-950 px-1.5 py-0.5 text-[11px] text-neutral-100 focus:outline-none"
              placeholder="Account name"
              defaultValue={renamingAccount ? activeAccount.name : ""}
              onBlur={e => (renamingAccount ? renameActiveAccount(e.target.value) : addAccount(e.target.value))}
              onKeyDown={e => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") { setAddingAccount(false); setRenamingAccount(false); }
              }}
            />
          ) : (
            <select
              className="rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-[11px] text-neutral-200 focus:border-purple-500 focus:outline-none"
              value={activeAccount.id}
              onChange={e => { setConfirmRemove(false); setActiveId(e.target.value); }}
            >
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
          <button
            title="Rename this account"
            className="rounded border border-neutral-700 bg-neutral-800 px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-700"
            onClick={() => { setConfirmRemove(false); setAddingAccount(false); setRenamingAccount(true); }}
          >✎</button>
          <button
            title="Add account"
            className="rounded border border-neutral-700 bg-neutral-800 px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-700"
            onClick={() => { setConfirmRemove(false); setRenamingAccount(false); setAddingAccount(true); }}
          >+</button>
          {activeAccount.id !== MAIN_ID && (
            confirmRemove ? (
              <button
                title="Really remove this account and its saved logins?"
                className="rounded border border-red-800 bg-red-950/60 px-1.5 py-0.5 text-red-300 hover:bg-red-900"
                onClick={removeActiveAccount}
              >remove?</button>
            ) : (
              <button
                title="Remove this account (deletes its saved logins)"
                className="rounded border border-neutral-700 bg-neutral-800 px-1.5 py-0.5 text-neutral-400 hover:bg-red-950/50 hover:text-red-300"
                onClick={() => setConfirmRemove(true)}
              >✕</button>
            )
          )}
        </div>
        <button className={tabCls("redeem")} onClick={() => setTab("redeem")}>Redeem</button>
      </div>

      {/* Tab content — all mounted, only the active one is shown */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden" style={show("loadouts")}>
          <LoadoutPanel />
        </div>
        <div className="flex min-h-0 flex-1 overflow-hidden" style={show("macros")}>
          <MacroPanel />
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden" style={show("overlay")}>
          <OverlayPanel profile={profile} onOpenGodroll={() => setTab("godroll")} />
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden" style={show("redeem")}>
          <RedeemPanel active={tab === "redeem" && !settingsOpen} accounts={accounts} />
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden" style={show("dim")}>
          <EmbeddedSitePanel storageKey="marco.dimSite" sites={DIM_SITES} active={tab === "dim" && !settingsOpen} profile={profile} accounts={extraFeaturesUnlocked ? accounts : undefined} />
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden" style={show("godroll")}>
          <EmbeddedSitePanel storageKey="marco.godrollSite" sites={GODROLL_SITES} active={tab === "godroll" && !settingsOpen} profile={profile} />
        </div>
      </div>

      {/* Status bar */}
      <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-neutral-800 bg-neutral-900/60 px-3 text-[11px] text-neutral-500">
        <span>{TAB_LABELS[tab]}</span>
        <span className="flex-1" />
        <button
          onClick={() => setSettingsOpen(true)}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-neutral-800 hover:text-neutral-200"
        >
          <span aria-hidden>⚙</span> settings
        </button>
        <span>Marco v1.0.0</span>
      </footer>

      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          tabPrefs={tabPrefs}
          onTabPrefsChange={setTabPrefs}
          extraFeaturesUnlocked={extraFeaturesUnlocked}
          onExtraFeaturesUnlockedChange={setExtraFeaturesUnlocked}
        />
      )}

      {showWelcome && <WelcomeModal onClose={dismissWelcome} />}
    </div>
  );
}
