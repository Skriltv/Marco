import { useCallback, useEffect, useState } from "react";
import { check as checkForUpdate, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date" }
  | { kind: "available"; version: string }
  | { kind: "downloading" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

/**
 * Shared update-check state for both the bottom-right toast (App.tsx) and
 * the Settings > Updates panel, so they stay in sync and only check once.
 */
export function useUpdater(autoCheckOnMount: boolean) {
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);

  const checkForUpdates = useCallback(async (silent = false) => {
    if (!silent) setState({ kind: "checking" });
    try {
      const result = await checkForUpdate();
      if (!result?.available) {
        if (!silent) setState({ kind: "up-to-date" });
        return;
      }
      setPendingUpdate(result);
      setState({ kind: "available", version: result.version });
    } catch (e) {
      // A silent (launch-time) check failing — e.g. no release published
      // yet — shouldn't surface as a scary error the user never asked for.
      if (!silent) setState({ kind: "error", message: String(e) });
    }
  }, []);

  const installUpdate = useCallback(async () => {
    setState({ kind: "downloading" });
    try {
      let update = pendingUpdate;
      if (!update) {
        update = await checkForUpdate();
        if (!update?.available) {
          setState({ kind: "up-to-date" });
          return;
        }
      }
      await update.downloadAndInstall();
      setState({ kind: "ready" });
    } catch (e) {
      setState({ kind: "error", message: String(e) });
    }
  }, [pendingUpdate]);

  const restart = useCallback(() => {
    relaunch().catch(() => {});
  }, []);

  useEffect(() => {
    if (autoCheckOnMount) checkForUpdates(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { state, checkForUpdates, installUpdate, restart };
}
