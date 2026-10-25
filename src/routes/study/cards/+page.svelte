<script lang="ts">
	import { page } from '$app/state';
	import { resolveBackHref } from '#lib/back-link.js';
	import { t } from '#lib/i18n/index.svelte.js';
	import CardReview from '#lib/components/CardReview.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// See back-link.ts — falls back to the vault's chat list, not "/", when
	// this page was opened directly (no `from`, e.g. a bookmark).
	let backHref = $derived(
		resolveBackHref(page.url.searchParams.get('from'), data.vaultId ? `/vault/${data.vaultId}` : '/')
	);
	let here = $derived(page.url.pathname + page.url.search);

	// See study/quiz/[id]/+page.svelte's comment on quizQuery — an empty
	// `vault=` param is not the same as an absent one.
	let cardsQuery = $derived(data.vaultId ? `?vault=${encodeURIComponent(data.vaultId)}` : '');
</script>

<CardReview
	fetchUrl={`/api/study/cards/queue${cardsQuery}`}
	vaultId={data.vaultId}
	{backHref}
	{here}
	titleFallback={t('CardsStudyPage.title')}
/>
