// One-time "Want to calibrate?" prompt shown on first visit to the firing
// range. Rendered by App.tsx when there's no existing input-settings
// localStorage entry and the meta.firstRunPromptDismissed flag is false.

type FirstRunPromptProps = {
  visible: boolean;
  onStart: () => void;
  onDismiss: () => void;
};

export function FirstRunPrompt({ visible, onStart, onDismiss }: FirstRunPromptProps) {
  if (!visible) return null;
  return (
    <div className="font-sans absolute inset-0 z-40 flex items-center justify-center bg-black/55 backdrop-blur-sm">
      <div className="max-w-[420px] px-[26px] py-[22px] rounded-[14px] text-[#edf6ff] bg-[rgba(7,11,16,0.72)] border border-white/[0.12] shadow-[0_24px_60px_rgba(0,0,0,0.45)] backdrop-blur-[18px] text-center font-[system-ui,sans-serif]">
        <h2 className="text-[22px] mb-2 font-semibold">Want to calibrate your aim?</h2>
        <p className="text-sm mb-5 opacity-[0.82] leading-[1.5]">
          We'll run a few short drills under two settings at a time and ask which felt
          better. You don't need to know any numbers — just trust your feel. Takes about
          two minutes.
        </p>
        <div className="flex gap-2.5 justify-center">
          <button
            type="button"
            className="px-[18px] py-[9px] rounded-full border border-[rgba(149,233,255,0.45)] bg-[rgba(149,233,255,0.22)] text-[#edf6ff] text-[13px] cursor-pointer font-semibold hover:bg-[rgba(149,233,255,0.32)] transition-colors"
            onClick={onStart}
          >
            Yes, let's calibrate
          </button>
          <button
            type="button"
            className="px-[18px] py-[9px] rounded-full border border-white/[0.16] bg-white/[0.06] text-[#edf6ff] text-[13px] cursor-pointer hover:bg-white/[0.12] transition-colors"
            onClick={onDismiss}
          >
            Maybe later
          </button>
        </div>
      </div>
    </div>
  );
}
