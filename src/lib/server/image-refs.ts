/**
 * Pure logic behind "orphaned converted images" cleanup: which converted-image
 * file names does a Markdown text refer to, and which stored files are
 * orphans. No filesystem access here — converted-image-cleanup.ts walks the
 * vault and calls these.
 *
 * Only names matching CONVERTED_IMAGE_NAME_RE-shaped tokens are ever
 * considered. Obsidian imports put arbitrarily named files in the same
 * `_meta/attachments/` folder; since they can never match that shape, no
 * decision made in this module can ever select one for deletion.
 */

/** Same shape as converted-images.ts CONVERTED_IMAGE_NAME_RE (kept as a copy so this module stays
 * import-free); the two are pinned together by a test. */
export const CONVERTED_NAME_RE = /^[0-9a-f]{16}\.(png|jpe?g)$/;

// A converted name inside a longer hex run (e.g. a 64-char sha256 followed by ".png") is not ours:
// the lookbehind/lookahead on word characters rejects it.
const NAME_TOKEN_RE = /(?<![0-9A-Za-z_])[0-9a-f]{16}\.(?:png|jpe?g)(?![0-9A-Za-z_])/gi;
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;

/**
 * Every converted-image name mentioned in `md` outside fenced code blocks.
 *
 * Deliberately matches the bare file name anywhere in the text instead of
 * parsing `![alt](path)`: the name is a content hash, so the folder part of a
 * link (any `../` depth, URL-encoded segments, spaces, an `<img src>` a user
 * typed by hand, an `![[name]]` embed) is irrelevant, and a looser match can
 * only make us KEEP a file we could have deleted — never delete one a note
 * still shows. Fenced code is skipped because an example inside a fence is not
 * rendered, so it must not keep an image alive forever.
 */
export function extractConvertedImageRefs(md: string): Set<string> {
	const out = new Set<string>();
	let fence: string | null = null;
	for (const line of md.split(/\r?\n/)) {
		const m = FENCE_RE.exec(line);
		if (m) {
			if (fence === null) fence = m[1][0];
			else if (m[1][0] === fence) fence = null;
			continue;
		}
		if (fence !== null) continue;
		for (const hit of line.matchAll(NAME_TOKEN_RE)) out.add(hit[0].toLowerCase());
	}
	return out;
}

export interface StoredImage {
	name: string;
	mtimeMs: number;
}

/**
 * Names in `stored` that nothing references and that are old enough to be
 * safe. The age floor protects an import in flight: its image is copied into
 * the vault before the note that links it is written, and in that window the
 * image is legitimately unreferenced. A name that does not match the
 * converted-image shape is never returned, whatever the other arguments say.
 */
export function orphanedImages(stored: StoredImage[], referenced: ReadonlySet<string>, nowMs: number, minAgeMs: number): string[] {
	return stored
		.filter((s) => CONVERTED_NAME_RE.test(s.name) && !referenced.has(s.name) && nowMs - s.mtimeMs >= minAgeMs)
		.map((s) => s.name);
}

/** Of `candidates` (images a discarded note used), those that no remaining note refers to. */
export function unreferencedCandidates(candidates: Iterable<string>, referencedElsewhere: ReadonlySet<string>): string[] {
	return [...candidates].filter((n) => CONVERTED_NAME_RE.test(n) && !referencedElsewhere.has(n));
}
