import type { RequestHandler } from './$types';
import { getCard, updateCardSchedule } from '#lib/server/study-db.js';
import { schedule, type Grade } from '#lib/server/schedule.js';
import { vaultFromId } from '#lib/server/requestVault.js';
import { fail } from '#lib/server/app-error.js';

const VALID_GRADES: Grade[] = ['again', 'hard', 'good', 'easy'];

export const POST: RequestHandler = async ({ params, request }) => {
	const body = (await request.json()) as { grade: Grade; vault?: string };
	const v = vaultFromId(body.vault);

	const card = getCard(v, params.id);
	if (!card) fail('NOT_FOUND', { entity: 'card' }, 404);

	if (!VALID_GRADES.includes(body.grade)) fail('VALIDATION_INVALID', { field: 'grade' });

	const next = schedule(
		{
			ease: card.ease,
			interval_days: card.interval_days,
			due_at: card.due_at,
			reps: card.reps,
			lapses: card.lapses
		},
		body.grade
	);
	updateCardSchedule(v, card.id, next);
	return Response.json({ ok: true });
};
