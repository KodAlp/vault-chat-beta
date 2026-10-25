import type { RequestHandler } from './$types';
import { readSkillRaw, writeSkill, patchSkillFrontmatter, deleteSkill } from '#lib/server/userSkills.js';
import { AppError, fail, toCodedError } from '#lib/server/app-error.js';
import type { ErrorCode } from '#lib/errors.js';

export const GET: RequestHandler = async ({ params }) => {
	const raw = readSkillRaw(params.name);
	if (raw === undefined) fail('NOT_FOUND', { entity: 'skill' }, 404);
	return Response.json({ name: params.name, raw });
};

export const PUT: RequestHandler = async ({ params, request }) => {
	const body = (await request.json()) as { raw: string };
	try {
		writeSkill(params.name, body.raw);
	} catch (err) {
		if (err instanceof AppError) fail(err.code, err.params, err.status);
		const coded = toCodedError(err);
		fail(coded.code as ErrorCode, coded.params, 400);
	}
	return Response.json({ ok: true });
};

/** Quick-toggle path for the settings list — enable switch / priority
 * input, without round-tripping the full file body. */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const body = (await request.json()) as Partial<{ enabled: boolean; priority: number }>;
	try {
		patchSkillFrontmatter(params.name, body);
	} catch (err) {
		if (err instanceof AppError) fail(err.code, err.params, err.status);
		const coded = toCodedError(err);
		fail(coded.code as ErrorCode, coded.params, 400);
	}
	return Response.json({ ok: true });
};

export const DELETE: RequestHandler = async ({ params }) => {
	const deleted = deleteSkill(params.name);
	if (!deleted) fail('NOT_FOUND', { entity: 'skill' }, 404);
	return Response.json({ ok: true });
};
