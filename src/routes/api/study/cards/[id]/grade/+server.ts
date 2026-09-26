import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getCard, updateCardSchedule } from '$lib/server/study-db';
import { schedule, type Grade } from '$lib/server/schedule';
import { vaultFromId } from '$lib/server/requestVault';
import { fail } from '$lib/server/app-error';

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
	return json({ ok: true });
};
