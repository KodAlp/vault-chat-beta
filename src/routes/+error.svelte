<script lang="ts">
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button';
	import { t } from '$lib/i18n/index.svelte';
	import { localizeError } from '$lib/server-error';

	let isNotFound = $derived(page.status === 404);
	// A coded 404 (e.g. a deleted vault) names what's missing; only an
	// unmatched route gets the generic "page not found" copy.
	let hasSpecificCode = $derived(!!page.error?.code && page.error.code !== 'ROUTE_NOT_FOUND');
</script>

<div class="wrap">
	<div class="card">
		<p class="status font-mono">{page.status}</p>
		<h1 class="font-display">
			{isNotFound ? t('ErrorPage.notFoundTitle') : t('ErrorPage.title')}
		</h1>
		<p class="body">
			{isNotFound && !hasSpecificCode ? t('ErrorPage.notFoundBody') : localizeError(page.error)}
		</p>
		<div class="actions">
			<Button href="/" variant="default">{t('ErrorPage.home')}</Button>
			<Button variant="ghost" onclick={() => history.back()}>{t('ErrorPage.back')}</Button>
		</div>
	</div>
</div>

<style>
	.wrap {
		display: flex;
		min-height: 100%;
		align-items: center;
		justify-content: center;
		padding: 2rem 1rem;
	}

	.card {
		max-width: 28rem;
		width: 100%;
		text-align: center;
	}

	.status {
		margin: 0 0 0.75rem;
		font-size: 0.8125rem;
		color: var(--text-muted);
	}

	h1 {
		margin: 0 0 0.75rem;
		font-size: 1.5rem;
		font-weight: 480;
		color: var(--text);
	}

	.body {
		margin: 0 0 2rem;
		font-size: 1rem;
		line-height: 1.5;
		color: var(--text-muted);
	}

	.actions {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
	}
</style>
