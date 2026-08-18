interface Props {
  onClose: () => void;
}

export default function WelcomeModal({ onClose }: Props) {
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="flex w-[400px] max-w-[90vw] flex-col items-center gap-4 rounded-lg border border-neutral-800 bg-neutral-900 px-6 py-7 text-center shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="text-3xl">🎉</div>
        <h2 className="text-lg font-semibold text-neutral-100">Welcome to Marco</h2>
        <p className="text-sm leading-relaxed text-neutral-400">
          Thanks for downloading Marco — hope you enjoy this dedicated Destiny 2 companion app.
        </p>
        <button
          className="mt-1 rounded border border-neutral-700 bg-neutral-800 px-4 py-1.5 text-sm font-medium text-neutral-100 hover:bg-neutral-700"
          onClick={onClose}
        >
          Let's go
        </button>
      </div>
    </div>
  );
}
