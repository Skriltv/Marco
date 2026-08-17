interface Props {
  onClose: () => void;
}

const CONTRIBUTORS = ["Skril", "Aste", "Poofafysh"];

export default function CreditsModal({ onClose }: Props) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex w-[360px] max-w-[90vw] flex-col rounded-lg border border-neutral-800 bg-neutral-900 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-4">
          <h2 className="text-base font-semibold text-neutral-100">Credits</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
            aria-label="Close credits"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-3 px-5 py-5">
          <p className="text-sm text-neutral-400">Marco is built and maintained by</p>
          <ul className="flex flex-col gap-2">
            {CONTRIBUTORS.map(name => (
              <li
                key={name}
                className="rounded border border-neutral-800 bg-neutral-950/40 px-3 py-2 text-sm font-medium text-neutral-100"
              >
                {name}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-neutral-500">Thanks for playing along with us.</p>
        </div>
      </div>
    </div>
  );
}
