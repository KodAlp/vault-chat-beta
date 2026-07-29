<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { settings } from '$lib/settings.svelte';
	import type { QuizGenerationEvent, QuizGenerationRequest } from '$lib/types';

	let { chatId }: { chatId: string } = $props();

	let open = $state(false);
	let domains = $state<string[]>([]);
	let selectedDomain = $state('');
	let useChatContext = $state(true);
	let prompt = $state('');
	let mc = $state(6);
	let tf = $state(2);
	let openCount = $state(2);
	let generating = $state(false);
	let stage = $state('');
	let errorMessage = $state('');

	const STAGE_LABELS: Record<string, string> = {
		retrieving: 'Kaynaklar aranıyor...',
		generating: 'Sorular üretiliyor...',
		validating: 'Doğrulanıyor...',
		retrying: 'Doğrulama başarısız, tekrar deneniyor...'
	};

	onMount(async () => {
		try {
			const res = await fetch('/api/domains');
			if (res.ok) domains = (await res.json()) as string[];
		} catch {
			// domain list stays empty — dropdown just shows "Tüm domainler"
		}
	});

	function openDialog() {
		open = true;
		errorMessage = '';
		stage = '';
	}

	function closeDialog() {
		if (generating) return;
		open = false;
	}

	async function generate() {
		if (!prompt.trim() || mc + tf + openCount <= 0) return;
		generating = true;
		errorMessage = '';
		stage = 'retrieving';

		try {
			const body: QuizGenerationRequest = {
				domains: selectedDomain ? [selectedDomain] : undefined,
				chatId: useChatContext ? chatId : undefined,
				prompt: prompt.trim(),
				composition: { mc, tf, open: openCount },
				model: settings.reasoningModel
			};
			const res = await fetch('/api/generate/quiz', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok || !res.body) throw new Error(`İstek başarısız (${res.status})`);

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const parts = buffer.split('\n\n');
				buffer = parts.pop() ?? '';
				for (const part of parts) {
					const line = part.trim();
					if (!line.startsWith('data:')) continue;
					const event = JSON.parse(line.slice(5)) as QuizGenerationEvent;
					if (event.type === 'progress') stage = event.stage;
					else if (event.type === 'done') {
						open = false;
						goto(`/study/quiz/${event.quizId}`);
					} else if (event.type === 'error') {
						errorMessage = event.message;
					}
				}
			}
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Bilinmeyen hata';
		} finally {
			generating = false;
		}
	}
</script>

<button class="trigger" onclick={openDialog} title="Test oluştur">📝<span>Test</span></button>

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
				<select bind:value={selectedDomain} disabled={generating}>
					<option value="">Tüm domainler</option>
					{#each domains as d (d)}
						<option value={d}>{d}</option>
					{/each}
				</select>
			</label>

			<label class="checkbox-field">
				<input type="checkbox" bind:checked={useChatContext} disabled={generating} />
				Bu konuşmayı bağlam olarak kullan
			</label>

			<label class="field">
				Ne tür bir test istiyorsun?
				<textarea
					bind:value={prompt}
					disabled={generating}
					placeholder="örn. Türev ve limit kavramları üzerine orta zorlukta bir test"
				></textarea>
			</label>

			<div class="composition">
				<label>
					Çoktan seçmeli
					<input type="number" min="0" max="20" bind:value={mc} disabled={generating} />
				</label>
				<label>
					Doğru/Yanlış
					<input type="number" min="0" max="20" bind:value={tf} disabled={generating} />
				</label>
				<label>
					Açık uçlu
					<input type="number" min="0" max="20" bind:value={openCount} disabled={generating} />
				</label>
			</div>

			{#if generating}
				<p class="progress">{STAGE_LABELS[stage] ?? 'İşleniyor...'}</p>
			{/if}
			{#if errorMessage}
				<p class="error">{errorMessage}</p>
			{/if}

			<div class="actions">
				<button onclick={closeDialog} disabled={generating}>İptal</button>
				<button
					class="primary"
					onclick={generate}
					disabled={generating || !prompt.trim() || mc + tf + openCount <= 0}
				>
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

	.trigger span {
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

	.progress {
		color: var(--muted);
		font-size: 0.85rem;
	}

	.error {
		color: var(--error);
		font-size: 0.85rem;
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
