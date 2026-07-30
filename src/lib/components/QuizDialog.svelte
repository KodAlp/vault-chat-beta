<script lang="ts">
	import { onMount } from 'svelte';
	import { settings } from '$lib/settings.svelte';
	import { quizGeneration, startQuizGeneration } from '$lib/quiz-generation.svelte';
	import type { QuizGenerationRequest } from '$lib/types';

	let { chatId }: { chatId: string } = $props();

	let open = $state(false);
	let domains = $state<string[]>([]);
	let selectedDomain = $state('');
	let useChatContext = $state(true);
	let prompt = $state('');
	let mc = $state(6);
	let tf = $state(2);
	let openCount = $state(2);

	let alreadyGenerating = $derived(quizGeneration.status.phase === 'generating');

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

	/**
	 * Fires the generation request into the shared background store and
	 * closes immediately — this used to await the whole SSE stream inline,
	 * blocking the dialog (and the overlay behind it) open for the 20s-2min
	 * a real generation takes, which read as the page being frozen. Now the
	 * request keeps running regardless of whether this dialog (or even this
	 * page) stays open; QuizGenerationStatus shows live progress elsewhere.
	 */
	function generate() {
		if (!prompt.trim() || mc + tf + openCount <= 0 || alreadyGenerating) return;
		const body: QuizGenerationRequest = {
			domains: selectedDomain ? [selectedDomain] : undefined,
			chatId: useChatContext ? chatId : undefined,
			prompt: prompt.trim(),
			composition: { mc, tf, open: openCount },
			model: settings.reasoningModel
		};
		open = false;
		void startQuizGeneration(body);
	}
</script>

<button class="trigger" onclick={openDialog} disabled={alreadyGenerating} title="Test oluştur">
	📝<span>Test</span>
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
			<h2>Test Oluştur</h2>

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
				Ne tür bir test istiyorsun?
				<textarea
					bind:value={prompt}
					placeholder="örn. Türev ve limit kavramları üzerine orta zorlukta bir test"
				></textarea>
			</label>

			<div class="composition">
				<label>
					Çoktan seçmeli
					<input type="number" min="0" max="20" bind:value={mc} />
				</label>
				<label>
					Doğru/Yanlış
					<input type="number" min="0" max="20" bind:value={tf} />
				</label>
				<label>
					Açık uçlu
					<input type="number" min="0" max="20" bind:value={openCount} />
				</label>
			</div>

			<div class="actions">
				<button onclick={closeDialog}>İptal</button>
				<button class="primary" onclick={generate} disabled={!prompt.trim() || mc + tf + openCount <= 0}>
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
		color: var(--muted-foreground);
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
		color: var(--primary);
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
		background: var(--background);
		color: var(--foreground);
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
	textarea,
	input[type='number'] {
		background: var(--background);
		color: var(--foreground);
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

	.composition {
		display: flex;
		gap: 0.75rem;
		margin-bottom: 1rem;
	}

	.composition label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.8rem;
		flex: 1;
	}

	.composition input {
		width: 100%;
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
		color: var(--foreground);
		cursor: pointer;
		font-size: 0.9rem;
	}

	.actions button.primary {
		background: var(--primary);
		color: var(--primary-foreground);
		border-color: var(--primary);
		font-weight: 600;
	}

	.actions button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
