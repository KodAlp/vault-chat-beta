<script lang="ts">
	import type { ImportEvent } from '$lib/types';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import * as Dialog from '$lib/components/ui/dialog';

	let { onImported }: { onImported: () => void } = $props();

	let open = $state(false);
	type Phase = 'idle' | 'uploading' | 'confirming' | 'saving' | 'error';
	let phase = $state<Phase>('idle');
	let statusLabel = $state('');
	let errorMessage = $state('');

	let selectedFile = $state<File | null>(null);
	let importId = $state('');
	let title = $state('');
	let domain = $state('');
	let level = $state('undergraduate');
	let warnings = $state<string[]>([]);

	const STAGE_LABELS: Record<string, string> = {
		queued: 'Sırada...',
		converting: 'Dönüştürülüyor...',
		postprocessing: 'İşleniyor...'
	};

	function openDialog() {
		open = true;
		phase = 'idle';
		selectedFile = null;
		errorMessage = '';
	}

	function onFileChange(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		selectedFile = input.files?.[0] ?? null;
	}

	async function upload() {
		if (!selectedFile) return;
		phase = 'uploading';
		statusLabel = 'Yükleniyor...';

		const formData = new FormData();
		formData.append('file', selectedFile);

		try {
			const res = await fetch('/api/import', { method: 'POST', body: formData });
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
					const event = JSON.parse(line.slice(5)) as ImportEvent;
					if (event.type === 'progress') {
						statusLabel = STAGE_LABELS[event.stage] ?? event.stage;
					} else if (event.type === 'ready') {
						importId = event.importId;
						title = event.proposed.title;
						domain = event.proposed.domain;
						level = event.proposed.level;
						warnings = event.warnings;
						phase = 'confirming';
					} else if (event.type === 'error') {
						errorMessage = event.message;
						phase = 'error';
					}
				}
			}
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Yükleme başarısız';
			phase = 'error';
		}
	}

	async function confirm() {
		if (!title.trim() || !domain.trim()) return;
		phase = 'saving';
		try {
			const res = await fetch(`/api/library/import/${importId}/confirm`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title: title.trim(), domain: domain.trim(), level })
			});
			if (!res.ok) throw new Error('Kaydedilemedi');
			open = false;
			onImported();
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Kaydedilemedi';
			phase = 'error';
		}
	}

	async function cancelStaged() {
		if (importId) {
			await fetch(`/api/library/import/${importId}/cancel`, { method: 'POST' }).catch(() => {});
		}
		open = false;
	}
</script>

<Button variant="outline" class="mb-1.5 w-full" onclick={openDialog}>+ Yükle</Button>

<Dialog.Root
	{open}
	onOpenChange={(next) => {
		if (next) {
			open = true;
			return;
		}
		// Matches the original overlay-click guard: never let an outside
		// click/Escape close the dialog mid-save (that request is already
		// in flight and must finish, same reasoning as GenerationDialog's
		// background generation not being cancellable by closing it).
		if (phase === 'saving') return;
		void cancelStaged();
	}}
>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Belge Yükle</Dialog.Title>
		</Dialog.Header>

		{#if phase === 'idle'}
			<label class="flex flex-col gap-1 text-sm">
				Dosya (DOCX / PPTX / XLSX / HTML / EPUB / basit PDF)
				<Input type="file" onchange={onFileChange} accept=".docx,.pptx,.xlsx,.html,.htm,.epub,.pdf" />
			</label>
			<Dialog.Footer>
				<Button variant="outline" onclick={cancelStaged}>İptal</Button>
				<Button onclick={upload} disabled={!selectedFile}>Yükle</Button>
			</Dialog.Footer>
		{:else if phase === 'uploading'}
			<p class="flex items-center gap-2 text-sm text-muted-foreground">
				<span class="inline-block size-3.5 animate-spin rounded-full border-2 border-border border-t-primary" aria-hidden="true"></span>
				{statusLabel}
			</p>
		{:else if phase === 'confirming' || phase === 'saving'}
			{#if warnings.length > 0}
				<p class="text-sm text-destructive">{warnings.join(' ')}</p>
			{/if}
			<label class="flex flex-col gap-1 text-sm">
				Başlık
				<Input type="text" bind:value={title} />
			</label>
			<label class="flex flex-col gap-1 text-sm">
				Domain
				<Input type="text" bind:value={domain} placeholder="örn. math" />
			</label>
			<label class="flex flex-col gap-1 text-sm">
				Seviye
				<Select.Root type="single" bind:value={level}>
					<Select.Trigger class="w-full">{level}</Select.Trigger>
					<Select.Content>
						<Select.Item value="undergraduate" label="undergraduate">undergraduate</Select.Item>
						<Select.Item value="graduate" label="graduate">graduate</Select.Item>
						<Select.Item value="phd" label="phd">phd</Select.Item>
					</Select.Content>
				</Select.Root>
			</label>
			<Dialog.Footer>
				<Button variant="outline" onclick={cancelStaged} disabled={phase === 'saving'}>İptal</Button>
				<Button onclick={confirm} disabled={phase === 'saving' || !title.trim() || !domain.trim()}>
					{phase === 'saving' ? 'Kaydediliyor...' : 'Kaydet'}
				</Button>
			</Dialog.Footer>
		{:else if phase === 'error'}
			<p class="text-sm text-destructive">{errorMessage}</p>
			<Dialog.Footer>
				<Button variant="outline" onclick={cancelStaged}>Kapat</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
