// --- Extra Features unlock ---
export const UNLOCK_CODE = "marcotest";

const UNLOCKED_STORAGE_KEY = "marco.extraFeaturesUnlocked";

export function isExtraFeaturesUnlocked(): boolean {
  try {
    return localStorage.getItem(UNLOCKED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Checks `code` against UNLOCK_CODE (case-insensitive, trims whitespace) and persists the result if it matches. */
export function tryUnlockExtraFeatures(code: string): boolean {
  const ok = code.trim().toLowerCase() === UNLOCK_CODE.trim().toLowerCase();
  if (ok) {
    try { localStorage.setItem(UNLOCKED_STORAGE_KEY, "1"); } catch { /* ignore */ }
  }
  return ok;
}

export function lockExtraFeatures(): void {
  try { localStorage.removeItem(UNLOCKED_STORAGE_KEY); } catch { /* ignore */ }
}
