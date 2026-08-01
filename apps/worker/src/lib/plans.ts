export type PlanId = 'free' | 'creator' | 'pro' | 'studio';

export interface Plan {
  id: PlanId;
  label: string;
  /** Monthly price in paise, as Razorpay expects. */
  amountPaise: number;
  reelsPerMonth: number;
  watermark: boolean;
  presets: 'basic' | 'all';
  maxDurationSeconds: number;
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    label: 'Free',
    amountPaise: 0,
    reelsPerMonth: 5,
    watermark: true,
    presets: 'basic',
    maxDurationSeconds: 60,
  },
  creator: {
    id: 'creator',
    label: 'Creator',
    amountPaise: 19900,
    reelsPerMonth: 30,
    watermark: false,
    presets: 'basic',
    maxDurationSeconds: 90,
  },
  pro: {
    id: 'pro',
    label: 'Pro',
    amountPaise: 49900,
    reelsPerMonth: 100,
    watermark: false,
    presets: 'all',
    maxDurationSeconds: 180,
  },
  studio: {
    id: 'studio',
    label: 'Studio',
    amountPaise: 99900,
    reelsPerMonth: 300,
    watermark: false,
    presets: 'all',
    maxDurationSeconds: 600,
  },
};

export function planFor(id: string | null | undefined): Plan {
  return PLANS[(id ?? 'free') as PlanId] ?? PLANS.free;
}

/** Quota windows are calendar-month-ish: 30 days from the recorded period start. */
export function periodExpired(periodStart: string | Date): boolean {
  const start = typeof periodStart === 'string' ? new Date(periodStart) : periodStart;
  return Date.now() - start.getTime() >= 30 * 86_400_000;
}
