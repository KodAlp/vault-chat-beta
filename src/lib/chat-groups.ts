export type ChatGroupKey = 'today' | 'yesterday' | 'last7' | 'last30' | 'older';

export const CHAT_GROUP_ORDER: ChatGroupKey[] = ['today', 'yesterday', 'last7', 'last30', 'older'];

export interface ChatGroup<T> {
	key: ChatGroupKey;
	items: T[];
}

function startOfDay(d: Date): number {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Which date bucket an ISO timestamp falls in, relative to `now` (local
 * calendar days, not rolling 24h windows). Future or unparseable dates land
 * in "today" / "older" respectively so a row never disappears. */
export function chatGroupKey(iso: string, now: Date = new Date()): ChatGroupKey {
	const ts = Date.parse(iso);
	if (Number.isNaN(ts)) return 'older';
	const dayMs = 86_400_000;
	const diffDays = Math.round((startOfDay(now) - startOfDay(new Date(ts))) / dayMs);
	if (diffDays <= 0) return 'today';
	if (diffDays === 1) return 'yesterday';
	if (diffDays <= 7) return 'last7';
	if (diffDays <= 30) return 'last30';
	return 'older';
}

/** Groups items by `updated_at` into the sidebar buckets, newest first within
 * each; empty buckets are omitted. */
export function groupChatsByDate<T extends { updated_at: string }>(
	chats: T[],
	now: Date = new Date()
): ChatGroup<T>[] {
	const sorted = [...chats].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
	const buckets = new Map<ChatGroupKey, T[]>();
	for (const chat of sorted) {
		const key = chatGroupKey(chat.updated_at, now);
		const list = buckets.get(key);
		if (list) list.push(chat);
		else buckets.set(key, [chat]);
	}
	return CHAT_GROUP_ORDER.filter((k) => buckets.has(k)).map((key) => ({ key, items: buckets.get(key)! }));
}
