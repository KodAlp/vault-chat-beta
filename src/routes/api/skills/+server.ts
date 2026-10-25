import type { RequestHandler } from './$types';
import { listAllUserSkillFiles } from '#lib/server/userSkills.js';

export const GET: RequestHandler = async () => {
	return Response.json({ skills: listAllUserSkillFiles() });
};
