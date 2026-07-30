<script lang="ts">
	import { onMount } from 'svelte';
	import { settings } from '$lib/settings.svelte';
	import { slidesGeneration, startSlidesGeneration } from '$lib/slides-generation.svelte';
	import type { SlidesGenerationRequest } from '$lib/types';

	let { chatId }: { chatId: string } = $props();

	let open = $state(false);
	let domains = $state<string[]>([]);
	let selectedDomain = $state('');
	let useChatContext = $state(true);
	let prompt = $state('');

	let alreadyGenerating = $derived(slidesGeneration.status.phase === 'generating');

	onMount(async () => {
		try {
			const res = await fetch('/api/domains');
			if (res.ok) domains = (await res.json()) as string[];
		} catch {
			// domain list stays empty — dropdown just shows "Tüm domainler"
		}
	});

	function openDialog() {
		if (alreadyGenerating) return;
		open = true;
	}

	function closeDialog() {
		open = false;
	}

	function generate() {
		if (!prompt.trim() || alreadyGenerating) return;
		const body: SlidesGenerationRequest = {
			domains: selectedDomain ? [selectedDomain] : undefined,
			chatId: useChatContext ? chatId : undefined,
			prompt: prompt.trim(),
			model: settings.reasoningModel
		};
		open = false;
		void startSlidesGeneration(body);
	}
</script>

<button class="trigger" onclick={openDialog} disabled={alreadyGenerating} title="Slayt oluştur">
	🖼️<span>Slayt</span>
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
			<h2>Slayt Oluştur</h2>

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
				Sunum hangi konuda olsun?
				<textarea
					bind:value={prompt}
					placeholder="örn. Kernel mimarileri hakkında kısa bir sunum"
				></textarea>
			</label>

			<div class="actions">
				<button onclick={closeDialog}>İptal</button>
				<button class="primary" onclick={generate} disabled={!prompt.trim()}>Oluştur</button>
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

	.trigger span {
		font-size: 0.65rem;
	}

	.trigger:hover {
		color: var(--accent);
	}

	.trigger:disabled {
		opacity: 0.4;
		cursor: not-allowed;
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
	textarea {
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
