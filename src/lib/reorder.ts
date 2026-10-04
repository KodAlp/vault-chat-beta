/** Returns a copy of `list` with the item at `from` moved to index `to`
 * (both clamped to the list). Used by drag-to-reorder lists. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
	const out = [...list];
	if (out.length === 0) return out;
	const f = Math.max(0, Math.min(out.length - 1, from));
	const t = Math.max(0, Math.min(out.length - 1, to));
	if (f === t) return out;
	const [item] = out.splice(f, 1);
	out.splice(t, 0, item);
	return out;
}
