export interface CardSchedule {
	ease: number;
	interval_days: number;
	due_at: string;
	reps: number;
	lapses: number;
}

export type Grade = 'again' | 'hard' | 'good' | 'easy';

const MIN_EASE = 1.3;
const MAX_EASE = 3.0;

function dueAtAfterDays(now: Date, days: number): string {
	return new Date(now.getTime() + days * 86_400_000).toISOString();
}

/**
 * SM-2 (ease no longer only ratchets down). `again`/`hard` lower ease, `easy` raises it, `good` leaves
 * it unchanged — the earlier version only ever lowered ease (`again`
 * -0.2, nothing else moved it), a one-way ratchet: a card mistapped a few
 * times got pushed to the 1.3 floor permanently and could never recover
 * even after being reliably remembered again, artificially inflating review
 * load as a deck grew. Pure function, no I/O — study-db.ts calls this and
 * persists the result.
 */
export function schedule(card: CardSchedule, grade: Grade, now: Date = new Date()): CardSchedule {
	switch (grade) {
		case 'again':
			return {
				ease: Math.max(MIN_EASE, card.ease - 0.2),
				interval_days: 0,
				due_at: now.toISOString(),
				reps: card.reps,
				lapses: card.lapses + 1
			};
		case 'hard': {
			const ease = Math.max(MIN_EASE, card.ease - 0.15);
			const interval_days = Math.max(1, Math.round(card.interval_days * 1.2));
			return {
				ease,
				interval_days,
				due_at: dueAtAfterDays(now, interval_days),
				reps: card.reps + 1,
				lapses: card.lapses
			};
		}
		case 'good': {
			const interval_days = Math.max(1, Math.round(card.interval_days * card.ease));
			return {
				ease: card.ease,
				interval_days,
				due_at: dueAtAfterDays(now, interval_days),
				reps: card.reps + 1,
				lapses: card.lapses
			};
		}
		case 'easy': {
			const ease = Math.min(MAX_EASE, card.ease + 0.15);
			const interval_days = Math.max(1, Math.round(card.interval_days * card.ease * 1.3));
			return {
				ease,
				interval_days,
				due_at: dueAtAfterDays(now, interval_days),
				reps: card.reps + 1,
				lapses: card.lapses
			};
		}
	}
}

/** New cards start here (set at creation, not via schedule()) — due
 * immediately so a freshly generated deck shows up in the queue right away. */
export function newCardSchedule(now: Date = new Date()): CardSchedule {
	return { ease: 2.5, interval_days: 1, due_at: now.toISOString(), reps: 0, lapses: 0 };
}
