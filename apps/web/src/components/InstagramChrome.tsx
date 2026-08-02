/**
 * Instagram Reels UI mock, drawn over the caption preview.
 *
 * Proportions follow Meta's published safe-area guidance for a 1080x1920 Reel: roughly
 * 14% of the height at the top, 35% at the bottom, and 6% on each side. Within that, the
 * right rail is about 90px wide (8.3%) and the bottom-left metadata block about 200px
 * tall. Everything is expressed as a percentage so it holds at any preview size.
 *
 * The point is occlusion. A creator cannot tell from a dashed rectangle whether their
 * caption collides with the action rail; showing the actual chrome makes it obvious.
 */

interface Props {
  username: string;
  caption: string;
  audioTitle: string;
}

/**
 * Fractions of the frame Instagram's own UI covers.
 *
 * Meta publishes 14% top / 35% bottom / 6% sides. The bottom figure is the full
 * congested band — handle, Follow, caption and audio credit — not just the text.
 */
export const IG_OCCLUSION = {
  topPct: 0.14,
  bottomPct: 0.35,
  rightRailPct: 0.09,
  sidePct: 0.06,
} as const;

export function InstagramChrome({ username, caption, audioTitle }: Props) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 text-white">
      {/* Scrims. Instagram darkens both ends so its own white UI stays legible. */}
      <div className="absolute inset-x-0 top-0 h-[16%] bg-gradient-to-b from-black/60 via-black/25 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 h-[38%] bg-gradient-to-t from-black/75 via-black/35 to-transparent" />

      {/* Header */}
      <div className="absolute inset-x-0 top-0 flex items-center justify-between px-[4.5%] pt-[4%]">
        <span className="text-[clamp(12px,4cqw,20px)] font-semibold drop-shadow-md">Reels</span>
        <Camera />
      </div>

      {/*
        Right rail. Bottom-aligned just above the metadata block, which is where
        Instagram puts it — a rail centred vertically would misrepresent the collision
        risk for captions in the lower third.
      */}
      <div className="absolute right-[3%] bottom-[19%] flex flex-col items-center gap-[4.5%]">
        <Action icon={<Heart />} label="12.4K" />
        <Action icon={<Comment />} label="318" />
        <Action icon={<Share />} label="1,204" />
        <Action icon={<Bookmark />} />
        <Action icon={<Dots />} />
        {/* Audio thumbnail, square with a light border, sits at the foot of the rail. */}
        <div className="mt-[8%] h-[clamp(20px,7cqw,38px)] w-[clamp(20px,7cqw,38px)] rounded-[7px] border-2 border-white/90 bg-gradient-to-br from-fuchsia-500 via-rose-400 to-amber-400 shadow-md" />
      </div>

      {/* Bottom-left metadata: handle, caption, audio credit. */}
      <div className="absolute inset-x-0 bottom-0 px-[4.5%] pb-[4%]">
        <div className="mb-[2.2%] flex items-center gap-[2.5%]">
          <div className="h-[clamp(18px,6.5cqw,32px)] w-[clamp(18px,6.5cqw,32px)] shrink-0 rounded-full border-2 border-white/90 bg-gradient-to-br from-orange-400 via-rose-500 to-fuchsia-600" />
          <span className="text-[clamp(11px,3.4cqw,17px)] font-semibold drop-shadow-md">
            {username}
          </span>
          <span className="rounded-[6px] border border-white/90 px-[7px] py-[1.5px] text-[clamp(9px,2.7cqw,13px)] font-semibold">
            Follow
          </span>
        </div>

        {/* Caption is clipped to two lines by Instagram, with the rail keeping it narrow. */}
        <p className="mr-[18%] line-clamp-2 text-[clamp(10px,3cqw,15px)] leading-snug drop-shadow-md">
          {caption}
        </p>

        <div className="mt-[2.5%] flex items-center gap-[2%]">
          <Note />
          <span className="mr-[20%] truncate text-[clamp(9px,2.7cqw,13px)] drop-shadow-md">
            {audioTitle}
          </span>
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-[1.2%] mx-[4.5%] h-[2.5px] rounded-full bg-white/25">
        <div className="h-full w-1/3 rounded-full bg-white/95" />
      </div>
    </div>
  );
}

function Action({ icon, label }: { icon: React.ReactNode; label?: string }) {
  return (
    <div className="flex flex-col items-center gap-[3px]">
      {icon}
      {label && (
        <span className="text-[clamp(8px,2.3cqw,12px)] font-semibold drop-shadow-md">{label}</span>
      )}
    </div>
  );
}

/* Inline SVGs rather than an icon package: six glyphs do not justify a dependency, and
   these need to scale with the container-query units used above. */
const ICON = 'h-[clamp(18px,6.5cqw,32px)] w-[clamp(18px,6.5cqw,32px)] drop-shadow-md';

const Heart = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={ICON}>
    <path d="M12 20.7s-7.5-4.6-9.3-9A5.1 5.1 0 0 1 12 6.4a5.1 5.1 0 0 1 9.3 5.3c-1.8 4.4-9.3 9-9.3 9Z" />
  </svg>
);
const Comment = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={ICON}>
    <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 20.5l1.6-4.8A8.3 8.3 0 0 1 3.6 11a8.4 8.4 0 0 1 9-8.4 8.4 8.4 0 0 1 8.4 8.9Z" />
  </svg>
);
const Share = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={ICON}>
    <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z" />
  </svg>
);
const Bookmark = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={ICON}>
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
  </svg>
);
const Dots = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={ICON}>
    <circle cx="5" cy="12" r="1.5" />
    <circle cx="12" cy="12" r="1.5" />
    <circle cx="19" cy="12" r="1.5" />
  </svg>
);
const Camera = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={ICON}>
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
    className="h-[clamp(10px,3.2cqw,15px)] w-[clamp(10px,3.2cqw,15px)] shrink-0 drop-shadow-md"
  >
    <path d="M9 18V5l12-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="16" r="3" />
  </svg>
);
