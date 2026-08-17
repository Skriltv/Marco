export type TabId = "loadouts" | "macros" | "dim" | "godroll" | "overlay" | "redeem";

// Redeem is deliberately NOT included here — it stays pinned in its fixed
// spot in the tab bar (past the account picker) and is not reorderable or
// hideable. These are the only tabs Settings' "Tab Order" section manages.
export const ALL_TAB_IDS: TabId[] = ["loadouts", "macros", "dim", "godroll", "overlay"];

export const TAB_LABELS: Record<TabId, string> = {
  loadouts: "Loadouts",
  macros: "Macros",
  dim: "DIM",
  godroll: "Destiny Sites",
  overlay: "Overlay",
  redeem: "Redeem",
};

const TAB_ORDER_KEY = "marco.tabOrder";
const HIDDEN_TABS_KEY = "marco.hiddenTabs";

export interface TabPrefs {
  order: TabId[];
  hidden: TabId[];
}

function isTabId(v: unknown): v is TabId {
  return typeof v === "string" && (ALL_TAB_IDS as string[]).includes(v);
}

export function loadTabPrefs(): TabPrefs {
  let order: TabId[] = [];
  try {
    const raw = localStorage.getItem(TAB_ORDER_KEY);
    if (raw) order = (JSON.parse(raw) as unknown[]).filter(isTabId);
  } catch { /* corrupt/missing — fall through to default order below */ }

  // Any tab id not present yet (fresh install, or a future Marco version
  // adding a new tab) gets appended at the end so it still shows up rather
  // than silently vanishing.
  for (const id of ALL_TAB_IDS) if (!order.includes(id)) order.push(id);

  let hidden: TabId[] = [];
  try {
    const raw = localStorage.getItem(HIDDEN_TABS_KEY);
    if (raw) hidden = (JSON.parse(raw) as unknown[]).filter(isTabId);
  } catch { /* corrupt/missing — default to nothing hidden */ }

  // Never let every tab end up hidden (e.g. from a bad save) — that would
  // strand the user on a blank tab bar with no way to click into Settings'
  // "unhide" controls except via a tab that isn't there.
  if (hidden.length >= order.length) hidden = [];

  return { order, hidden };
}

export function saveTabPrefs(prefs: TabPrefs) {
  try {
    localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(prefs.order));
    localStorage.setItem(HIDDEN_TABS_KEY, JSON.stringify(prefs.hidden));
  } catch { /* best-effort */ }
}
