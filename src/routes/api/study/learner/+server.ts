import type { RequestHandler } from './$types';
import { computeLearnerProfile } from '#lib/server/learner-store.js';
import { vaultFromUrl } from '#lib/server/requestVault.js';

/**
 * F1b — the learner profile of a vault: for the whole vault, each domain and each note, how the quiz answers look (`quiz`), how
 * well the reviewed cards are remembered (`retention`) and, only when questions carry a level, the basic/applied split (`bands`).
 * Read-only: computed from what is stored right now and never written. Recording a snapshot is an explicit act
 * (scripts/learner-report.ts --snapshot), not a side effect of opening a page.
 */
export const GET: RequestHandler = ({ url }) => {
	return Response.json(computeLearnerProfile(vaultFromUrl(url)));
};
