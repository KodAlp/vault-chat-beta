<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Card from '$lib/components/ui/card';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { t } from '$lib/i18n/index.svelte';

	/** Mirrors smalltalk-store.ts's PhraseListItem — that module is server-only. */
	interface Phrase {
		id: number;
		text: string;
		source: 'seed' | 'auto' | 'user';
		kind: 'smalltalk' | 'question';
		blocked: boolean;
		hits: number;
		createdAt: string;
		lastHitAt: string | null;
	}

	let phrases = $state<Phrase[]>([]);
	let loaded = $state(false);
	let loadError = $state('');
	let actionError = $state('');
	let busy = $state(false);
	let gateActive = $state(true);

	async function load() {
		try {
			const res = await fetch('/api/smalltalk');
			if (!res.ok) throw new Error();
			const body = (await res.json()) as { phrases: Phrase[]; gateActive?: boolean };
			phrases = body.phrases;
			gateActive = body.gateActive !== false;
			loadError = '';
		} catch {
			loadError = t('SmallTalkSettingsPage.loadError');
		} finally {
			loaded = true;
		}
	}

	async function remove(id: number) {
		actionError = '';
		busy = true;
		try {
			const res = await fetch(`/api/smalltalk/${id}`, { method: 'DELETE' });
			if (!res.ok) throw new Error();
			await load();
		} catch {
			actionError = t('SmallTalkSettingsPage.deleteError');
		} finally {
			busy = false;
		}
	}

	let clearConfirmOpen = $state(false);

	async function confirmClearAll() {
		clearConfirmOpen = false;
		actionError = '';
		busy = true;
		try {
			const res = await fetch('/api/smalltalk', { method: 'DELETE' });
			if (!res.ok) throw new Error();
			await load();
		} catch {
			actionError = t('SmallTalkSettingsPage.deleteError');
		} finally {
			busy = false;
		}
	}

	function sourceLabel(p: Phrase): string {
		if (p.source === 'auto') return t('SmallTalkSettingsPage.sourceAuto');
		if (p.source === 'seed') return t('SmallTalkSettingsPage.sourceSeed');
		return t('SmallTalkSettingsPage.sourceUser');
	}

	onMount(load);
</script>

<svelte:head>
	<title>{t('SmallTalkSettingsPage.title')} — Vault Agent Toolkit</title>
</svelte:head>

<div>

	<p class="mb-5 text-sm text-muted-foreground">{t('SmallTalkSettingsPage.intro')}</p>

	{#if loaded && !gateActive}
		<p class="mb-4 text-sm text-muted-foreground">{t('SmallTalkSettingsPage.gateInactive')}</p>
	{/if}
	{#if loadError}
		<p class="mb-4 text-sm text-destructive">{loadError}</p>
	{/if}
	{#if actionError}
		<p class="mb-4 text-sm text-destructive">{actionError}</p>
	{/if}

	{#if loaded && !loadError}
		{#if phrases.length === 0}
			<p class="text-sm text-muted-foreground">{t('SmallTalkSettingsPage.empty')}</p>
		{:else}
			<div class="mb-4 flex justify-end">
				<Button variant="outline" disabled={busy} onclick={() => (clearConfirmOpen = true)}>{t('SmallTalkSettingsPage.clearAll')}</Button>
			</div>
			<div class="flex flex-col gap-2">
				{#each phrases as p (p.id)}
					<Card.Root>
						<Card.Content class="flex flex-wrap items-center justify-between gap-3">
							<div class="min-w-[200px] flex-1">
								<div class="flex flex-wrap items-center gap-1.5">
									<strong class="text-sm break-words">{p.text}</strong>
									<Badge variant="outline">{sourceLabel(p)}</Badge>
									{#if p.kind === 'question'}
										<Badge variant="outline">{t('SmallTalkSettingsPage.kindQuestion')}</Badge>
									{/if}
									{#if p.blocked}
										<Badge variant="outline">{t('SmallTalkSettingsPage.blocked')}</Badge>
									{/if}
									{#if p.hits > 0}
										<span class="text-xs text-muted-foreground">{t('SmallTalkSettingsPage.hits', { count: p.hits })}</span>
									{/if}
								</div>
							</div>
							<Button variant="ghost" size="sm" disabled={busy} onclick={() => remove(p.id)}>{t('SmallTalkSettingsPage.delete')}</Button>
						</Card.Content>
					</Card.Root>
				{/each}
			</div>
		{/if}
	{/if}
</div>

<AlertDialog.Root open={clearConfirmOpen} onOpenChange={(open) => (clearConfirmOpen = open)}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{t('SmallTalkSettingsPage.clearConfirm')}</AlertDialog.Title>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{t('Common.vazgec')}</AlertDialog.Cancel>
			<AlertDialog.Action
				variant="destructive"
				onclick={(e) => {
					e.preventDefault();
					confirmClearAll();
				}}
			>
				{t('SmallTalkSettingsPage.clearAll')}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
