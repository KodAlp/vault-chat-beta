<script lang="ts">
	import type { ImportEvent } from '$lib/types';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import * as Dialog from '$lib/components/ui/dialog';
	import { t } from '$lib/i18n/index.svelte';

	let { onImported }: { onImported: () => void } = $props();

	let open = $state(false);
	type Phase = 'idle' | 'uploading' | 'confirming' | 'saving' | 'error';
	let phase = $state<Phase>('idle');
	let statusLabel = $state('');
	let estimatedSeconds = $state<number | null>(null);
	let errorMessage = $state('');

	type Source = 'file' | 'youtube';
	let source = $state<Source>('file');
	let selectedFile = $state<File | null>(null);
	let youtubeUrl = $state('');
	// İ5 (Aşama 8): rights checkbox, YouTube only — a local file the user
	// picks is already theirs; a YouTube URL is fetched from outside.
	let rightsConfirmed = $state(false);
	let importId = $state('');
	let title = $state('');
	let domain = $state('');
	let level = $state('undergraduate');
	let warnings = $state<string[]>([]);

	// $derived, not a plain const — see +layout.svelte's identical STAGE_LABELS
	// comment: a bare object literal would call t() once at component init and
	// freeze at whatever locale was active then.
	let STAGE_LABELS = $derived<Record<string, string>>({
		queued: t('UploadDialog.stageQueued'),
		converting: t('UploadDialog.stageConverting'),
		postprocessing: t('UploadDialog.stagePostprocessing'),
		fetching: t('UploadDialog.stageFetching'),
		parsing: t('UploadDialog.stageParsing')
	});

	function openDialog() {
		open = true;
		phase = 'idle';
		source = 'file';
		selectedFile = null;
		youtubeUrl = '';
		rightsConfirmed = false;
		estimatedSeconds = null;
		errorMessage = '';
	}

	function onFileChange(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		selectedFile = input.files?.[0] ?? null;
	}

	function fileFormData(): FormData {
		const formData = new FormData();
		if (selectedFile) formData.append('file', selectedFile);
		return formData;
	}

	async function upload() {
		if (source === 'file' && !selectedFile) return;
		if (source === 'youtube' && (!youtubeUrl.trim() || !rightsConfirmed)) return;
		phase = 'uploading';
		statusLabel = t('UploadDialog.uploading');
		estimatedSeconds = null;

		try {
			const res =
				source === 'file'
					? await fetch('/api/import', { method: 'POST', body: fileFormData() })
					: await fetch('/api/import/youtube', {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ url: youtubeUrl.trim() })
						});
			// 413 is adapter-node's BODY_SIZE_LIMIT rejecting the body before
			// the route ever runs, so there is no SSE error event to read —
			// the status code is all the client gets. Name it instead of
			// showing a bare "İstek başarısız (413)".
			if (res.status === 413) throw new Error(t('UploadDialog.tooLarge'));
			if (!res.ok || !res.body) throw new Error(t('Common.istekBasarisiz', { status: res.status }));

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
						if (event.estimatedSeconds) estimatedSeconds = event.estimatedSeconds;
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
			errorMessage = err instanceof Error ? err.message : t('UploadDialog.uploadFailed');
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
			if (!res.ok) {
				// #11: a failed-indexing rollback surfaces a specific reason here
				// (confirm/+server.ts's error(500, ...) body) rather than the
				// generic "kaydedilemedi" — the user needs to know the file went
				// back to staging, not just that something failed.
				const body = await res.json().catch(() => null);
				throw new Error(typeof body?.message === 'string' ? body.message : t('UploadDialog.saveFailed'));
			}
			open = false;
			onImported();
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : t('UploadDialog.saveFailed');
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

<Button variant="outline" class="mb-1.5 w-full" onclick={openDialog}>{t('UploadDialog.trigger')}</Button>

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
			<Dialog.Title>{t('UploadDialog.dialogTitle')}</Dialog.Title>
		</Dialog.Header>

		{#if phase === 'idle'}
			<div class="flex gap-1.5">
				<Button
					variant={source === 'file' ? 'default' : 'outline'}
					size="sm"
					onclick={() => (source = 'file')}
				>
					{t('UploadDialog.sourceFile')}
				</Button>
				<Button
					variant={source === 'youtube' ? 'default' : 'outline'}
					size="sm"
					onclick={() => (source = 'youtube')}
				>
					{t('UploadDialog.sourceYoutube')}
				</Button>
			</div>
			{#if source === 'file'}
				<label class="flex flex-col gap-1 text-sm">
					{t('UploadDialog.fileLabel')}
					<Input type="file" onchange={onFileChange} accept=".docx,.pptx,.xlsx,.html,.htm,.epub,.pdf,.md,.tex" />
				</label>
			{:else}
				<label class="flex flex-col gap-1 text-sm">
					{t('UploadDialog.youtubeLabel')}
					<Input
						type="url"
						bind:value={youtubeUrl}
						placeholder={t('UploadDialog.youtubePlaceholder')}
					/>
				</label>
				<label class="flex items-start gap-2 text-xs text-muted-foreground">
					<input type="checkbox" bind:checked={rightsConfirmed} class="mt-0.5" />
					{t('UploadDialog.youtubeRightsConfirm')}
				</label>
			{/if}
			<Dialog.Footer>
				<Button variant="outline" onclick={cancelStaged}>{t('Common.iptal')}</Button>
				<Button
					onclick={upload}
					disabled={source === 'file' ? !selectedFile : !youtubeUrl.trim() || !rightsConfirmed}
				>
					{t('UploadDialog.upload')}
				</Button>
			</Dialog.Footer>
		{:else if phase === 'uploading'}
			<p class="flex items-center gap-2 text-sm text-muted-foreground">
				<span class="inline-block size-3.5 animate-spin rounded-full border-2 border-border border-t-primary" aria-hidden="true"></span>
				{statusLabel}
			</p>
			{#if estimatedSeconds}
				<p class="text-xs text-muted-foreground">{t('UploadDialog.estimatedTime', { seconds: estimatedSeconds })}</p>
			{/if}
		{:else if phase === 'confirming' || phase === 'saving'}
			{#if warnings.length > 0}
				<!-- One item per warning: convert.py now emits several full sentences
				     (broken font mapping, no headings, no paragraph breaks) where it
				     used to emit none, and joining them ran them together into one
				     unreadable paragraph. -->
				<ul class="list-disc space-y-1 pl-5 text-sm text-destructive">
					{#each warnings as warning (warning)}
						<li>{warning}</li>
					{/each}
				</ul>
			{/if}
			<label class="flex flex-col gap-1 text-sm">
				{t('UploadDialog.titleLabel')}
				<Input type="text" bind:value={title} />
			</label>
			<label class="flex flex-col gap-1 text-sm">
				{t('UploadDialog.domainLabel')}
				<Input type="text" bind:value={domain} placeholder={t('UploadDialog.domainPlaceholder')} />
			</label>
			<label class="flex flex-col gap-1 text-sm">
				{t('UploadDialog.levelLabel')}
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
				<Button variant="outline" onclick={cancelStaged} disabled={phase === 'saving'}>{t('Common.iptal')}</Button>
				<Button onclick={confirm} disabled={phase === 'saving' || !title.trim() || !domain.trim()}>
					{phase === 'saving' ? t('Common.kaydediliyor') : t('Common.kaydet')}
				</Button>
			</Dialog.Footer>
		{:else if phase === 'error'}
			<p class="text-sm text-destructive">{errorMessage}</p>
			<Dialog.Footer>
				<Button variant="outline" onclick={cancelStaged}>{t('Common.kapat')}</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
