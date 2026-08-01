/**
 * Instagram Reels UI mock, drawn over the caption preview.
 *
 * The point is occlusion: abstract "safe area" rectangles do not tell a creator whether
 * their caption collides with the action rail or the audio ticker. Rendering the actual
 * chrome does. Proportions are taken from a 1080x1920 Reels frame and expressed as
 * percentages so they hold at any preview size.
 */

interface Props {
  username: string;
  caption: string;
  audioTitle: string;
  /** Dim the video so the mock UI reads clearly. */
  dim?: boolean;
}

/**
 * Occupied bands as fractions of the frame — kept in sync with the layout below.
 *
 * The rail is a 3.5% right margin plus ~6cqw icons, so ~10% of the width. A wider
 * figure here fires the collision warning on captions that are actually clear.
 */
export const IG_OCCLUSION = {
  topPct: 0.11,
  bottomPct: 0.26,
  rightRailPct: 0.12,
} as const;

export function InstagramChrome({ username, caption, audioTitle, dim }: Props) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 text-white">
      {dim && <div className="absolute inset-0 bg-black/10" />}

      {/* Top gradient + header */}
      <div className="absolute inset-x-0 top-0 h-[14%] bg-gradient-to-b from-black/55 to-transparent" />
      <div className="absolute inset-x-0 top-0 flex items-center justify-between px-[4%] pt-[3.5%]">
        <span className="text-[clamp(11px,3.4cqw,17px)] font-semibold drop-shadow">Reels</span>
        <Camera />
      </div>

      {/* Right action rail */}
      <div className="absolute right-[3.5%] bottom-[13%] flex flex-col items-center gap-[5%]">
        <Action icon={<Heart />} label="12.4K" />
        <Action icon={<Comment />} label="318" />
        <Action icon={<Share />} label="1,204" />
        <Action icon={<Bookmark />} />
        <Action icon={<Dots />} />
        {/* Rotating album art, as Instagram shows for the audio track. */}
        <div className="mt-[6%] h-[clamp(18px,7cqw,34px)] w-[clamp(18px,7cqw,34px)] rounded-[6px] border-2 border-white/85 bg-gradient-to-br from-fuchsia-500 to-amber-400" />
      </div>

      {/* Bottom gradient + metadata */}
      <div className="absolute inset-x-0 bottom-0 h-[30%] bg-gradient-to-t from-black/70 via-black/30 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 px-[4%] pb-[5%]">
        <div className="mb-[2%] flex items-center gap-[2%]">
          <div className="h-[clamp(16px,6cqw,30px)] w-[clamp(16px,6cqw,30px)] rounded-full border border-white/70 bg-gradient-to-br from-orange-400 to-pink-500" />
          <span className="text-[clamp(10px,3.1cqw,15px)] font-semibold drop-shadow">{username}</span>
          <span className="rounded-[4px] border border-white/80 px-[6px] py-[1px] text-[clamp(8px,2.4cqw,12px)] font-medium">
            Follow
          </span>
        </div>

        <p className="mr-[20%] line-clamp-2 text-[clamp(9px,2.8cqw,14px)] leading-snug drop-shadow">
          {caption}
        </p>

        <div className="mt-[2.5%] flex items-center gap-[1.5%]">
          <Note />
          <span className="truncate text-[clamp(8px,2.5cqw,12px)] drop-shadow">{audioTitle}</span>
        </div>
      </div>

      {/* Scrub bar */}
      <div className="absolute inset-x-0 bottom-[1.5%] mx-[4%] h-[2px] rounded-full bg-white/30">
        <div className="h-full w-1/3 rounded-full bg-white/90" />
      </div>
    </div>
  );
}

function Action({ icon, label }: { icon: React.ReactNode; label?: string }) {
  return (
    <div className="flex flex-col items-center gap-[2px]">
      {icon}
      {label && <span className="text-[clamp(7px,2.1cqw,11px)] font-medium drop-shadow">{label}</span>}
    </div>
  );
}

/* Inline SVGs rather than an icon package: five glyphs do not justify a dependency,
   and these need to scale with the container query units used above. */
const ICON = 'h-[clamp(16px,6cqw,30px)] w-[clamp(16px,6cqw,30px)] drop-shadow';

const Heart = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" className={ICON}>
    <path d="M12 20.7s-7.5-4.6-9.3-9A5.1 5.1 0 0 1 12 6.4a5.1 5.1 0 0 1 9.3 5.3c-1.8 4.4-9.3 9-9.3 9Z" />
  </svg>
);
const Comment = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" className={ICON}>
    <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 20.5l1.6-4.8A8.3 8.3 0 0 1 3.6 11a8.4 8.4 0 0 1 9-8.4 8.4 8.4 0 0 1 8.4 8.9Z" />
  </svg>
);
const Share = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" className={ICON}>
    <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z" />
  </svg>
);
const Bookmark = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" className={ICON}>
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
  </svg>
);
const Dots = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={ICON}>
    <circle cx="5" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="19" cy="12" r="1.6" />
  </svg>
);
const Camera = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" className={ICON}>
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
    <circle cx="12" cy="13" r="4" />
  </svg>
);
const Note = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    className="h-[clamp(9px,3cqw,14px)] w-[clamp(9px,3cqw,14px)] shrink-0 drop-shadow"
  >
    <path d="M9 18V5l12-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="16" r="3" />
  </svg>
);
