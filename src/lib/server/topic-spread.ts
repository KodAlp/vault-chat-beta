/**
 * Which distinct topics (frontmatter `domains`) the sources of one answer come from. When there are
 * several, the question may have meant only one of them (e.g. "Heap" as data structure vs. memory
 * region), so the chat offers to ask again within a single topic. Pure: no SvelteKit/DB imports.
 */

/** "genel" marks a note without a topic; it is never a topic of its own. */
const NO_TOPIC = 'genel';

export function topicSpread(chunks: { domains: string[] }[], opts: { min?: number; max?: number } = {}): string[] {
	const min = opts.min ?? 3;
	const max = opts.max ?? 4;
	const seen = new Set<string>();
	const topics: string[] = [];
	for (const chunk of chunks) {
		const first = chunk.domains.map((d) => d.trim()).find((d) => d !== '' && d.toLowerCase() !== NO_TOPIC);
		if (first === undefined) continue;
		const key = first.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		topics.push(first);
	}
	return topics.length < min ? [] : topics.slice(0, max);
}
