import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getReport, getReportSections } from '$lib/server/study-db';
import type { ReportSectionView, ReportView } from '$lib/types';

export const GET: RequestHandler = async ({ params }) => {
	const report = getReport(params.id);
	if (!report) error(404, 'Rapor bulunamadı');

	const sections: ReportSectionView[] = getReportSections(params.id).map((row) => ({
		id: row.id,
		heading: row.heading,
		body_markdown: row.body_markdown,
		source_paths: JSON.parse(row.source_paths_json) as string[]
	}));

	const view: ReportView = { id: report.id, title: report.title, model: report.model };
	return json({ report: view, sections });
};
