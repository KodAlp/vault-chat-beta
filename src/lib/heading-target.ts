/**
 * Citation → heading anchor. A cited chunk carries its breadcrumb
 * (`heading_path`, indexer/chunk.ts's findHeadingPath: "Topic > H2 > H3"),
 * but the rendered note has no heading ids, so the viewer finds the heading by
 * its text. The breadcrumb holds the raw Markdown title (`**x**`, `` `y` ``)
 * while the page shows the rendered text, hence the normalization.
 */

export interface RenderedHeading {
	level: number;
	text: string;
}

export function normalizeHeading(s: string): string {
	return s
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[*_`~#$\\]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.toLocaleLowerCase();
}

/** Index of the heading the breadcrumb points at, or -1. The first segment is
 * the note's title (not a section heading) and is skipped; a breadcrumb with
 * no section is the note's opening and has no anchor. When the last title
 * repeats (two "Example" sections), the one whose enclosing headings match the
 * earlier segments wins, else the first. */
export function pickHeadingIndex(headings: RenderedHeading[], headingPath: string): number {
	const segments = headingPath.split(' > ').slice(1).map(normalizeHeading).filter(Boolean);
	if (segments.length === 0) return -1;
	const last = segments[segments.length - 1];
	const candidates = headings.flatMap((h, i) => (normalizeHeading(h.text) === last ? [i] : []));
	if (candidates.length <= 1) return candidates[0] ?? -1;

	const score = (i: number): number => {
		let level = headings[i].level;
		let seg = segments.length - 2;
		let matched = 0;
		for (let j = i - 1; j >= 0 && seg >= 0; j--) {
			if (headings[j].level >= level) continue;
			level = headings[j].level;
			if (normalizeHeading(headings[j].text) === segments[seg]) matched++;
			seg--;
		}
		return matched;
	};
	let best = candidates[0];
	for (const i of candidates) if (score(i) > score(best)) best = i;
	return best;
}

/** The rendered `<h2>`–`<h6>` element the breadcrumb points at, or null. */
export function findHeadingElement(root: ParentNode, headingPath: string): HTMLElement | null {
	const els = [...root.querySelectorAll<HTMLElement>('h2, h3, h4, h5, h6')];
	const i = pickHeadingIndex(
		els.map((el) => ({ level: Number(el.tagName[1]), text: el.textContent ?? '' })),
		headingPath
	);
	return i >= 0 ? els[i] : null;
}
