<script lang="ts">
	import { page } from '$app/state';
	import { resolveBackHref } from '$lib/back-link';
	import { t } from '$lib/i18n/index.svelte';
	import CardReview from '$lib/components/CardReview.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// See back-link.ts — falls back to the vault's chat list, not "/", when
	// this page was opened directly (no `from`, e.g. a bookmark).
	let backHref = $derived(
		resolveBackHref(page.url.searchParams.get('from'), data.vaultId ? `/vault/${data.vaultId}` : '/')
	);
	let here = $derived(page.url.pathname + page.url.search);
	let deckQuery = $derived(data.vaultId ? `?vault=${encodeURIComponent(data.vaultId)}` : '');
</script>

<!-- Reviews this ONE deck's cards (getDeckCards — unfiltered by due date),
     not the flat cross-deck due queue — see study-db.ts's doc comment for
     why: a deck you explicitly opened should show its material now, not
     wait for spaced-repetition timing. Fixes İdeas.txt: math and Svelte
     cards used to be reviewable only jumbled together in one queue. -->
<CardReview
	fetchUrl={`/api/study/decks/${data.deckId}/cards${deckQuery}`}
	vaultId={data.vaultId}
	{backHref}
	{here}
	titleFallback={t('CardsStudyPage.title')}
	emptyMessage={t('CardsStudyPage.deckEmpty')}
/>
