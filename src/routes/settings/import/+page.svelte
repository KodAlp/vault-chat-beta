<script lang="ts">
	import UploadDialog from '$lib/components/UploadDialog.svelte';
	import BatchUploadDialog from '$lib/components/BatchUploadDialog.svelte';
	import LinksImportDialog from '$lib/components/LinksImportDialog.svelte';
	import LibraryImportDialog from '$lib/components/LibraryImportDialog.svelte';
	import * as Card from '$lib/components/ui/card';
	import { READY_SOURCES, SOON_SOURCES, type ReadySource } from '$lib/library-import-sources';
	import { t } from '$lib/i18n/index.svelte';

	// The card that opened the dialog; null = closed. The dialog is created per click so every
	// import starts from a clean folder step.
	let active = $state<ReadySource | null>(null);
</script>

<svelte:head>
	<title>{t('SettingsNav.importLibrary')} — Vault Chat</title>
</svelte:head>

<div class="page">
	<p class="intro">{t('LibraryImport.pageIntro')}</p>

	<section aria-labelledby="li-apps">
		<h2 id="li-apps" class="vc-group-title">{t('LibraryImport.appsHeading')}</h2>
		<ul class="grid">
			{#each READY_SOURCES as src (src.id)}
				<li>
					<button type="button" class="card ready" onclick={() => (active = src)}>
						<span class="tile" aria-hidden="true">{src.initial}</span>
						<span class="text">
							<span class="name">{t(`LibraryImport.source_${src.id}`)}</span>
							<span class="desc">{t(`LibraryImport.source_${src.id}_desc`)}</span>
						</span>
						<span class="vc-badge accent">{t('LibraryImport.badgeReady')}</span>
					</button>
				</li>
			{/each}
		</ul>

		<p class="soon-intro">{t('LibraryImport.soonIntro')}</p>
		<ul class="grid">
			{#each SOON_SOURCES as src (src.id)}
				<li>
					<div class="card soon" aria-disabled="true">
						<span class="tile" aria-hidden="true">{src.initial}</span>
						<span class="text">
							<span class="name">{src.name}</span>
							<span class="desc">{t(`LibraryImport.soon_${src.id}`)}</span>
						</span>
						<span class="vc-badge">{t('LibraryImport.badgeSoon')}</span>
					</div>
				</li>
			{/each}
		</ul>
	</section>

	<section aria-labelledby="li-files">
		<h2 id="li-files" class="vc-group-title">{t('LibraryImport.filesHeading')}</h2>
		<p class="soon-intro">{t('LibraryImport.filesIntro')}</p>
		<Card.Root class="mb-4">
			<Card.Header>
				<Card.Title level={3}>{t('LibraryImport.file_upload_title')}</Card.Title>
				<Card.Description>{t('LibraryImport.file_upload_desc')}</Card.Description>
			</Card.Header>
			<Card.Content>
				<UploadDialog onImported={() => {}} />
			</Card.Content>
		</Card.Root>
		<Card.Root class="mb-4">
			<Card.Header>
				<Card.Title level={3}>{t('LibraryImport.file_batch_title')}</Card.Title>
				<Card.Description>{t('LibraryImport.file_batch_desc')}</Card.Description>
			</Card.Header>
			<Card.Content>
				<BatchUploadDialog onImported={() => {}} />
			</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Header>
				<Card.Title level={3}>{t('LibraryImport.file_links_title')}</Card.Title>
				<Card.Description>{t('LibraryImport.file_links_desc')}</Card.Description>
			</Card.Header>
			<Card.Content>
				<LinksImportDialog />
			</Card.Content>
		</Card.Root>
	</section>
</div>

{#if active}
	<LibraryImportDialog source={active} onclose={() => (active = null)} />
{/if}

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: var(--space-6, 24px);
	}
	.intro,
	.soon-intro {
		margin: 0;
		font: 400 15px/21px var(--font-sans);
		color: var(--label-secondary);
	}
	.soon-intro {
		margin-block: var(--space-4) var(--space-3);
		font-size: 13px;
		line-height: 18px;
	}
	.vc-group-title {
		padding-inline: 0;
		margin: 0 0 var(--space-3);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 15rem), 1fr));
		gap: var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.card {
		appearance: none;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-2);
		width: 100%;
		height: 100%;
		padding: var(--space-3) var(--space-4);
		border: 0;
		border-radius: var(--radius-lg);
		background: var(--bg-elevated);
		box-shadow: inset 0 0 0 1px var(--separator);
		color: var(--label);
		text-align: start;
		font: inherit;
	}
	.card.ready {
		cursor: pointer;
		transition: background-color var(--duration-fast), box-shadow var(--duration-fast);
	}
	.card.ready:hover {
		background: var(--fill-hover);
		box-shadow: inset 0 0 0 1px var(--separator-strong);
	}
	.card.ready:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}
	.card.soon {
		opacity: 0.7;
		cursor: default;
	}
	.tile {
		display: inline-grid;
		place-items: center;
		width: 32px;
		height: 32px;
		border-radius: var(--radius-md);
		background: var(--accent-soft);
		color: var(--accent-text);
		font: 600 13px/1 var(--font-sans);
		flex: none;
	}
	.soon .tile {
		background: var(--fill-control);
		color: var(--label-secondary);
	}
	.text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		flex: 1;
	}
	.name {
		font: 600 15px/20px var(--font-sans);
		overflow-wrap: anywhere;
	}
	.desc {
		font: 400 13px/18px var(--font-sans);
		color: var(--label-secondary);
		overflow-wrap: anywhere;
	}
</style>
