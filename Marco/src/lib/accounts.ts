// Shared with App.tsx's account switcher (DIM/Godroll/Overlay) so every tab
// that supports multiple logins reads/writes the exact same saved account
// list and profile-folder ids.

export const ACCOUNTS_KEY = "marco.accounts";
export const ACTIVE_ACCOUNT_KEY = "marco.activeAccount";

/** The built-in first account's id. It maps to the default (pre-existing)
 * browser session so whoever was already signed in before stays signed in. */
export const MAIN_ID = "Main";

/** id = immutable profile-folder key (never changes); name = display, freely editable. */
export interface Account { id: string; name: string; }

export function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "account";
}

export function loadAccounts(): Account[] {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    const list = raw ? (JSON.parse(raw) as (string | Account)[]) : [];
    // Migrate the older plain-string format; the old string doubled as the
    // profile key Rust slugged, so it becomes the immutable id verbatim.
    const migrated = list.map(a => (typeof a === "string" ? { id: a, name: a } : a));
    return migrated.length ? migrated : [{ id: MAIN_ID, name: "Main" }];
  } catch { return [{ id: MAIN_ID, name: "Main" }]; }
}

/** Profile folder key for a given account id — undefined means "Main" (shared default session). */
export function profileForAccount(id: string): string | undefined {
  return id === MAIN_ID ? undefined : id;
}
