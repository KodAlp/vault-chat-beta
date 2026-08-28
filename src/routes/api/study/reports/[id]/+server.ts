import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getReport, getReportSections, deleteReport } from '$lib/server/study-db';
import { vaultFromUrl, vaultFromId } from '$lib/server/requestVault';
import type { ReportSectionView, ReportView } from '$lib/types';

export const GET: RequestHandler = async ({ params, url }) => {
	const v = vaultFromUrl(url);
	const report = getReport(v, params.id);
	if (!report) error(404, 'Rapor bulunamadı');

	const sections: ReportSectionView[] = getReportSections(v, params.id).map((row) => ({
		id: row.id,
		heading: row.heading,
		body_markdown: row.body_markdown,
		source_paths: JSON.parse(row.source_paths_json) as string[]
	}));

	const view: ReportView = { id: report.id, title: report.title, model: report.model };
	return json({ report: view, sections });
};

export const DELETE: RequestHandler = async ({ params, request }) => {
	const body = (await request.json().catch(() => ({}))) as { vault?: string };
	const v = vaultFromId(body.vault);
	if (!getReport(v, params.id)) error(404, 'Rapor bulunamadı');
	deleteReport(v, params.id);
	return json({ ok: true });
};
