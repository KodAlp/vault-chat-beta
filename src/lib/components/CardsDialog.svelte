<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { settings } from '$lib/settings.svelte';
	import { cardGeneration, startCardGeneration } from '$lib/card-generation.svelte';
	import type { CardGenerationRequest } from '$lib/types';

	let { chatId }: { chatId: string } = $props();

	let open = $state(false);
	let domains = $state<string[]>([]);
	let selectedDomain = $state('');
	let useChatContext = $state(true);
	let prompt = $state('');
	let count = $state(10);
	let dueCount = $state(0);

	let alreadyGenerating = $derived(cardGeneration.status.phase === 'generating');

	onMount(async () => {
		try {
			const res = await fetch('/api/domains');
			if (res.ok) domains = (await res.json()) as string[];
		} catch {
			// domain list stays empty — dropdown just shows "Tüm domainler"
		}
		void refreshDueCount();
	});

	async function refreshDueCount() {
		try {
			const res = await fetch('/api/study/cards/due-count');
			if (res.ok) dueCount = ((await res.json()) as { count: number }).count;
		} catch {
			// badge just stays at its last known value
		}
	}

	function openDialog() {
		open = true;
	}

	function closeDialog() {
		open = false;
	}

	function review() {
		open = false;
		goto('/study/cards');
	}

	/** Fires into the shared background store and closes immediately — same
	 * reasoning as QuizDialog.svelte's generate(): a real generation takes
	 * 20s-2min, an open dialog for that whole span reads as a frozen page. */
	function generate() {
		if (!prompt.trim() || count <= 0 || alreadyGenerating) return;
		const body: CardGenerationRequest = {
			domains: selectedDomain ? [selectedDomain] : undefined,
			chatId: useChatContext ? chatId : undefined,
			prompt: prompt.trim(),
			count,
			model: settings.reasoningModel
		};
		open = false;
		void startCardGeneration(body);
	}
</script>

<button class="trigger" onclick={openDialog} title="Bilgi kartları">
	<span class="icon-wrap">
		🗂️
		{#if dueCount > 0}
			<span class="badge">{dueCount > 99 ? '99+' : dueCount}</span>
		{/if}
	</span>
	<span>Kartlar</span>
</button>

{#if open}
	<div
		class="overlay"
		onclick={closeDialog}
		onkeydown={(e) => e.key === 'Escape' && closeDialog()}
		role="presentation"
	>
		<div
			class="dialog"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal="true"
			tabindex="-1"
		>
			<h2>Bilgi Kartları</h2>

			{#if dueCount > 0}
				<button class="review-cta" onclick={review}>
					İncele ({dueCount} kart bekliyor)
				</button>
			{/if}

			<label class="field">
				Domain (opsiyonel)
				<select bind:value={selectedDomain}>
					<option value="">Tüm domainler</option>
					{#each domains as d (d)}
						<option value={d}>{d}</option>
					{/each}
				</select>
			</label>

			<label class="checkbox-field">
				<input type="checkbox" bind:checked={useChatContext} />
				Bu konuşmayı bağlam olarak kullan
			</label>

			<label class="field">
				Ne konuda kart istiyorsun?
				<textarea
					bind:value={prompt}
					placeholder="örn. Türev ve limit kavramları üzerine bilgi kartları"
				></textarea>
			</label>

			<label class="field count-field">
				Kart sayısı
				<input type="number" min="1" max="30" bind:value={count} />
			</label>

			<div class="actions">
				<button onclick={closeDialog}>İptal</button>
				<button class="primary" onclick={generate} disabled={!prompt.trim() || count <= 0}>
					Oluştur
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.trigger {
		background: transparent;
		border: none;
		color: var(--muted);
		font-size: 0.9rem;
		cursor: pointer;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.15rem;
		padding: 0;
	}

	.icon-wrap {
		position: relative;
		display: inline-flex;
	}

	.badge {
		position: absolute;
		top: -0.4rem;
		right: -0.6rem;
		background: var(--accent);
		color: var(--accent-fg);
		font-size: 0.6rem;
		font-weight: 700;
		line-height: 1;
		border-radius: 999px;
		padding: 0.15rem 0.35rem;
	}

	.trigger span:last-child {
		font-size: 0.65rem;
	}

	.trigger:hover {
		color: var(--accent);
	}

	.overlay {
		position: fixed;
		inset: 0;
		background: rgb(0 0 0 / 0.4);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
	}

	.dialog {
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 1.25rem;
		width: min(480px, 90vw);
		max-height: 85vh;
		overflow-y: auto;
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
	}

	.dialog h2 {
		margin: 0 0 1rem;
		font-size: 1.1rem;
	}

	.review-cta {
		display: block;
		width: 100%;
		margin-bottom: 1rem;
		padding: 0.6rem 0.9rem;
		border-radius: 8px;
		border: 1px solid var(--accent);
		background: transparent;
		color: var(--accent);
		font-weight: 600;
		cursor: pointer;
		font-size: 0.9rem;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.85rem;
		margin-bottom: 0.9rem;
	}

	.checkbox-field {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.85rem;
		margin-bottom: 0.9rem;
		cursor: pointer;
	}

	select,
	textarea,
	input[type='number'] {
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.4rem 0.5rem;
		font-family: var(--font-sans);
		font-size: 0.9rem;
	}

	textarea {
		resize: vertical;
		min-height: 4rem;
	}

	.count-field input {
		width: 6rem;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 1rem;
	}

	.actions button {
		padding: 0.45rem 1rem;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: transparent;
		color: var(--fg);
		cursor: pointer;
		font-size: 0.9rem;
	}

	.actions button.primary {
		background: var(--accent);
		color: var(--accent-fg);
		border-color: var(--accent);
		font-weight: 600;
	}

	.actions button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
