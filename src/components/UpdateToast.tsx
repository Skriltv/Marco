import type { UpdateState } from "../lib/useUpdater";

interface Props {
  update: UpdateState;
  onInstall: () => void;
  onRestart: () => void;
  onDismiss: () => void;
}

/** Quiet bottom-right toast shown when a background update check (see useUpdater's
 * autoCheckOnMount) finds a newer version. Stays out of the way otherwise —
 * doesn't render at all for "idle" / "checking" / "up-to-date" / "error". */
export default function UpdateToast({ update, onInstall, onRestart, onDismiss }: Props) {
  if (update.kind !== "available" && update.kind !== "downloading" && update.kind !== "ready") {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 w-72 rounded-lg border border-neutral-800 bg-neutral-900 p-3 shadow-2xl">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-neutral-100">
            {update.kind === "ready" ? "Update ready" : "New update"}
          </p>
          <p className="mt-0.5 text-xs text-neutral-400">
            {update.kind === "available" && `Marco v${update.version} is available.`}
            {update.kind === "downloading" && "Downloading..."}
            {update.kind === "ready" && "Restart to finish installing."}
          </p>
        </div>
        {update.kind === "available" && (
          <button
            onClick={onDismiss}
            aria-label="Dismiss"
            className="shrink-0 rounded px-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
          >
            ✕
          </button>
        )}
      </div>
      <div className="mt-2 flex justify-end">
        {update.kind === "available" && (
          <button
            onClick={onInstall}
            className="rounded border border-purple-800 bg-purple-900/40 px-3 py-1.5 text-sm text-purple-200 hover:bg-purple-900/70 transition-colors"
          >
            Download
          </button>
        )}
        {update.kind === "downloading" && (
          <span className="text-sm text-neutral-400">Downloading...</span>
        )}
        {update.kind === "ready" && (
          <button
            onClick={onRestart}
            className="rounded border border-purple-800 bg-purple-900/40 px-3 py-1.5 text-sm text-purple-200 hover:bg-purple-900/70 transition-colors"
          >
            Restart now
          </button>
        )}
      </div>
    </div>
  );
}
