<script lang="ts">
	import { onMount } from 'svelte';
	import type { ImportEvent } from '$lib/types';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import * as Dialog from '$lib/components/ui/dialog';
	import { t } from '$lib/i18n/index.svelte';
	import { localizeError, readResponseError } from '$lib/server-error';

	/**
	 * The one-file flow inside AddFilesDialog (formerly the whole of UploadDialog): convert → staging →
	 * a review step where the user edits title/domain/level (with the duplicate/quality warnings) →
	 * confirm or cancel. Exactly one of `file` / `youtubeUrl` is set; the conversion starts on mount
	 * because the choice was already made in the picker. The parent owns the <Dialog>; it asks
	 * isBusy() before closing and calls discard() so a staged-but-unconfirmed import never lingers.
	 */
	let {
		file = null,
		youtubeUrl = '',
		onImported,
		onClose,
		onBack
	}: {
		file?: File | null;
		youtubeUrl?: string;
		onImported: () => void;
		onClose: () => void;
		onBack: () => void;
	} = $props();

	type Phase = 'uploading' | 'confirming' | 'saving' | 'error';
	let phase = $state<Phase>('uploading');
	let statusLabel = $state('');
	let estimatedSeconds = $state<number | null>(null);
	let errorMessage = $state('');

	let importId = $state('');
	let title = $state('');
	let domain = $state('');
	let level = $state('undergraduate');
	let warnings = $state<string[]>([]);
	let discarded = false;

	// $derived, not a plain const — see +layout.svelte's identical STAGE_LABELS
	// comment: a bare object literal would call t() once at component init and
	// freeze at whatever locale was active then.
	let STAGE_LABELS = $derived<Record<string, string>>({
		queued: t('ImportFlow.stageQueued'),
		converting: t('ImportFlow.stageConverting'),
		postprocessing: t('ImportFlow.stagePostprocessing'),
		retrying: t('ImportFlow.stageRetrying'),
		fetching: t('ImportFlow.stageFetching'),
		parsing: t('ImportFlow.stageParsing')
	});

	/** Matches the original overlay-click guard: never let an outside click/Escape close the
	 * dialog mid-save (that request is already in flight and must finish, same reasoning as
	 * GenerationDialog's background generation not being cancellable by closing it). */
	export function isBusy(): boolean {
		return phase === 'saving';
	}

	async function cancelOnServer(id: string) {
		await fetch(`/api/library/import/${id}/cancel`, { method: 'POST' }).catch(() => {});
	}

	/** Drops the staged import (if the conversion got that far). */
	export async function discard(): Promise<void> {
		discarded = true;
		if (importId) await cancelOnServer(importId);
	}

	async function upload() {
		statusLabel = t('ImportFlow.uploading');
		estimatedSeconds = null;

		try {
			let res: Response;
			if (file) {
				const formData = new FormData();
				formData.append('file', file);
				res = await fetch('/api/import', { method: 'POST', body: formData });
			} else {
				res = await fetch('/api/import/youtube', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ url: youtubeUrl.trim() })
				});
			}
			// 413 is adapter-node's BODY_SIZE_LIMIT rejecting the body before
			// the route ever runs, so there is no SSE error event to read —
			// the status code is all the client gets. Name it instead of
			// showing a bare "İstek başarısız (413)".
			if (res.status === 413) throw new Error(t('ImportFlow.tooLarge'));
			if (!res.ok) throw new Error(await readResponseError(res));
			if (!res.body) throw new Error(t('Common.istekBasarisiz', { status: res.status }));

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
						// The user closed the dialog while this was converting: nobody will
						// ever review it, so drop the staged copy instead of leaking it.
						if (discarded) {
							void cancelOnServer(event.importId);
							return;
						}
						importId = event.importId;
						title = event.proposed.title;
						domain = event.proposed.domain;
						level = event.proposed.level;
						warnings = event.warnings;
						phase = 'confirming';
					} else if (event.type === 'error') {
						errorMessage = localizeError(event);
						phase = 'error';
					}
				}
			}
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : t('ImportFlow.uploadFailed');
			phase = 'error';
		}
	}

	onMount(() => {
		void upload();
	});

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
				// (confirm/+server.ts's fail('IMPORT_INDEX_FAILED', ...) body)
				// rather than the generic "kaydedilemedi" — the user needs to
				// know the file went back to staging, not just that something
				// failed.
				throw new Error(await readResponseError(res));
			}
			onImported();
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : t('ImportFlow.saveFailed');
			phase = 'error';
		}
	}

	async function cancelStaged() {
		await discard();
		onClose();
	}
</script>

{#if phase === 'uploading'}
	<p class="flex items-center gap-2 text-sm text-muted-foreground">
		<span class="inline-block size-3.5 animate-spin rounded-full border-2 border-border border-t-primary" aria-hidden="true"></span>
		{statusLabel}
	</p>
	{#if estimatedSeconds}
		<p class="text-xs text-muted-foreground">{t('ImportFlow.estimatedTime', { seconds: estimatedSeconds })}</p>
	{/if}
	<Dialog.Footer>
		<Button variant="outline" onclick={cancelStaged}>{t('Common.iptal')}</Button>
	</Dialog.Footer>
{:else if phase === 'confirming' || phase === 'saving'}
	{#if warnings.length > 0}
		<!-- One item per warning: convert.py now emits several full sentences
		     (broken font mapping, no headings, no paragraph breaks) where it
		     used to emit none, and joining them ran them together into one
		     unreadable paragraph. -->
		<ul class="list-disc space-y-1 ps-5 text-sm text-destructive">
			{#each warnings as warning (warning)}
				<!-- Our own warnings arrive as codes; converter warnings are
				     free text and fall through localizeError unchanged. -->
				<li>{localizeError({ code: warning, message: warning })}</li>
			{/each}
		</ul>
	{/if}
	<label class="flex flex-col gap-1.5 text-[13px] leading-[18px] font-medium">
		{t('ImportFlow.titleLabel')}
		<Input type="text" bind:value={title} />
	</label>
	<label class="flex flex-col gap-1.5 text-[13px] leading-[18px] font-medium">
		{t('ImportFlow.domainLabel')}
		<Input type="text" bind:value={domain} placeholder={t('ImportFlow.domainPlaceholder')} />
	</label>
	<label class="flex flex-col gap-1.5 text-[13px] leading-[18px] font-medium">
		{t('ImportFlow.levelLabel')}
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
	<p class="text-sm text-destructive" role="alert">{errorMessage}</p>
	<Dialog.Footer>
		<Button variant="outline" onclick={onBack}>{t('AddFilesDialog.back')}</Button>
		<Button variant="outline" onclick={cancelStaged}>{t('Common.kapat')}</Button>
	</Dialog.Footer>
{/if}
