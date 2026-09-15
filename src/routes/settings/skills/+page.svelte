<script lang="ts">
	import { onMount } from 'svelte';
	import type { UserSkillStatus, UserSkillScope } from '$lib/types';
	import { MAX_SKILL_FILE_CHARS } from '$lib/skill-limits';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Badge } from '$lib/components/ui/badge';
	import * as Card from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import { t } from '$lib/i18n/index.svelte';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';

	let SCOPE_LABELS = $derived<Record<UserSkillScope, string>>({
		chat: t('SkillsSettingsPage.scopeChat'),
		quiz: t('SkillsSettingsPage.scopeQuiz'),
		flashcards: t('SkillsSettingsPage.scopeFlashcards'),
		mindmap: t('SkillsSettingsPage.scopeMindmap'),
		report: t('SkillsSettingsPage.scopeReport'),
		slides: t('SkillsSettingsPage.scopeSlides')
	});

	const PREVIEW_SCOPES: UserSkillScope[] = ['chat', 'quiz', 'flashcards', 'report', 'mindmap', 'slides'];

	let TEMPLATE = $derived(`---
description: ${t('SkillsSettingsPage.templateDescription')}
scope: all
enabled: true
priority: 50
---
${t('SkillsSettingsPage.templateBody')}
`);

	let skills = $state<UserSkillStatus[]>([]);
	let loadError = $state('');
	let zipUploading = $state(false);
	let zipUploadError = $state('');

	let editorOpen = $state(false);
	let editorName = $state('');
	let editorIsNew = $state(false);
	let editorRaw = $state('');
	let editorError = $state('');
	let editorSaving = $state(false);

	let previewScope = $state<UserSkillScope>('chat');
	let previewText = $state('');
	let previewLoading = $state(false);
	let previewOpen = $state(false);

	async function refresh() {
		try {
			const res = await fetch('/api/skills');
			if (!res.ok) throw new Error();
			skills = ((await res.json()) as { skills: UserSkillStatus[] }).skills;
		} catch {
			loadError = t('SkillsSettingsPage.loadError');
		}
	}

	onMount(refresh);

	function scopeChips(scope: UserSkillStatus['scope']): string[] {
		return scope === 'all' ? [t('SkillsSettingsPage.scopeAll')] : scope.map((s) => SCOPE_LABELS[s]);
	}

	function budgetClass(charCount: number): 'green' | 'amber' | 'red' {
		const pct = charCount / MAX_SKILL_FILE_CHARS;
		if (pct >= 1) return 'red';
		if (pct >= 0.7) return 'amber';
		return 'green';
	}

	async function toggleEnabled(skill: UserSkillStatus) {
		try {
			const res = await fetch(`/api/skills/${encodeURIComponent(skill.name)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ enabled: !skill.enabled })
			});
			if (!res.ok) throw new Error();
			await refresh();
		} catch {
			loadError = t('SkillsSettingsPage.updateFailed', { name: skill.name });
		}
	}

	async function changePriority(skill: UserSkillStatus, value: number) {
		try {
			const res = await fetch(`/api/skills/${encodeURIComponent(skill.name)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ priority: value })
			});
			if (!res.ok) throw new Error();
			await refresh();
		} catch {
			loadError = t('SkillsSettingsPage.updateFailed', { name: skill.name });
		}
	}

	async function openEditor(skill: UserSkillStatus) {
		editorError = '';
		try {
			const res = await fetch(`/api/skills/${encodeURIComponent(skill.name)}`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { name: string; raw: string };
			editorName = data.name;
			editorRaw = data.raw;
			editorIsNew = false;
			editorOpen = true;
		} catch {
			loadError = t('SkillsSettingsPage.loadSkillFailed', { name: skill.name });
		}
	}

	function openNewEditor() {
		editorError = '';
		editorName = '';
		editorRaw = TEMPLATE;
		editorIsNew = true;
		editorOpen = true;
	}

	// Lets a skill be authored elsewhere and dropped in as a .md file instead
	// of pasted by hand — reads straight into editorRaw, same as typing.
	function handleFileUpload(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			editorRaw = String(reader.result ?? '');
			if (editorIsNew && !editorName.trim()) {
				editorName = file.name.replace(/\.(md|markdown)$/i, '');
			}
		};
		reader.onerror = () => {
			editorError = t('SkillsSettingsPage.uploadFileFailed');
		};
		reader.readAsText(file);
		input.value = '';
	}

	// Folder-structured skill upload (SKILL.md + references/scripts/...) —
	// a separate endpoint from the plain-.md handleFileUpload above, since a
	// zip produces a whole skill (parsed/validated/extracted server-side),
	// not just text dropped into the open editor.
	async function handleZipUpload(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		zipUploading = true;
		zipUploadError = '';
		try {
			const formData = new FormData();
			formData.append('file', file);
			const res = await fetch('/api/skills/upload-zip', { method: 'POST', body: formData });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { message?: string } | null;
				zipUploadError = body?.message ?? t('Common.kaydedilemedi');
				return;
			}
			await refresh();
		} catch {
			zipUploadError = t('Common.kaydedilemedi');
		} finally {
			zipUploading = false;
			input.value = '';
		}
	}

	async function saveEditor() {
		const name = editorName.trim();
		if (!name) {
			editorError = t('SkillsSettingsPage.nameRequired');
			return;
		}
		editorSaving = true;
		editorError = '';
		try {
			const res = await fetch(`/api/skills/${encodeURIComponent(name)}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ raw: editorRaw })
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { message?: string } | null;
				editorError = body?.message ?? t('Common.kaydedilemedi');
				return;
			}
			editorOpen = false;
			await refresh();
		} catch {
			editorError = t('Common.kaydedilemedi');
		} finally {
			editorSaving = false;
		}
	}

	async function removeSkill(skill: UserSkillStatus) {
		if (!confirm(t('SkillsSettingsPage.deleteConfirm', { name: skill.name }))) return;
		try {
			const res = await fetch(`/api/skills/${encodeURIComponent(skill.name)}`, { method: 'DELETE' });
			if (!res.ok) throw new Error();
			await refresh();
		} catch {
			loadError = t('SkillsSettingsPage.deleteFailed', { name: skill.name });
		}
	}

	async function runPreview() {
		previewLoading = true;
		previewOpen = true;
		try {
			const res = await fetch(`/api/skills/preview?scope=${previewScope}`);
			if (!res.ok) throw new Error();
			previewText = ((await res.json()) as { prompt: string }).prompt;
		} catch {
			previewText = t('SkillsSettingsPage.previewFailed');
		} finally {
			previewLoading = false;
		}
	}
</script>

<svelte:head>
	<title>{t('SkillsSettingsPage.title')} — Vault Agent Toolkit</title>
</svelte:head>

<div class="mx-auto max-w-3xl px-4 pt-6 pb-12">
	<div class="mb-3 flex items-baseline gap-4">
		<a href="/settings" class="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2">
			<ArrowLeftIcon size={14} aria-hidden="true" /> {t('Common.ayarlar')}
		</a>
		<h1 class="font-display text-xl font-medium">{t('SkillsSettingsPage.title')}</h1>
	</div>

	<p class="mb-5 text-sm text-muted-foreground">
		<code class="rounded bg-muted px-1 py-0.5 text-xs">data/skills/</code>
		{t('SkillsSettingsPage.intro')}
	</p>

	{#if loadError}
		<p class="mb-4 text-sm text-destructive">{loadError}</p>
	{/if}
	{#if zipUploadError}
		<p class="mb-4 text-sm text-destructive">{zipUploadError}</p>
	{/if}

	<div class="mb-5 flex flex-wrap items-center justify-between gap-3">
		<div class="flex flex-wrap items-center gap-1.5">
			<Button onclick={openNewEditor}>{t('SkillsSettingsPage.newSkill')}</Button>
			<Button variant="outline" disabled={zipUploading} class="relative overflow-hidden">
				{zipUploading ? t('Common.yukleniyor') : t('SkillsSettingsPage.uploadZip')}
				<input
					type="file"
					accept=".zip,application/zip"
					disabled={zipUploading}
					onchange={handleZipUpload}
					class="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
				/>
			</Button>
		</div>
		<div class="flex gap-1.5">
			<Select.Root type="single" bind:value={previewScope}>
				<Select.Trigger class="w-44">{SCOPE_LABELS[previewScope]}</Select.Trigger>
				<Select.Content>
					{#each PREVIEW_SCOPES as scope (scope)}
						<Select.Item value={scope} label={SCOPE_LABELS[scope]}>{SCOPE_LABELS[scope]}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
			<Button variant="outline" onclick={runPreview}>{t('SkillsSettingsPage.preview')}</Button>
		</div>
	</div>

	<div class="flex flex-col gap-3">
		{#each skills as skill (skill.relPath)}
			<Card.Root>
				<Card.Content class="flex flex-wrap justify-between gap-4">
					<div class="min-w-[220px] flex-1">
						<div class="flex flex-wrap items-center gap-1.5">
							<strong class="text-sm">{skill.name}</strong>
							{#if skill.isFolder}
								<Badge variant="outline" title={skill.files?.join(', ')}>
									📁 {t('SkillsSettingsPage.folderBadge', { count: skill.files?.length ?? 0 })}
								</Badge>
							{/if}
							{#each scopeChips(skill.scope) as chip (chip)}
								<Badge variant="outline">{chip}</Badge>
							{/each}
							{#if skill.parseError}
								<Badge variant="destructive" title={skill.parseError}>{t('SkillsSettingsPage.errorBadge')}</Badge>
							{/if}
							{#if skill.truncated}
								<Badge class="bg-amber-500/20 text-amber-700 dark:text-amber-400">{t('SkillsSettingsPage.truncatedBadge')}</Badge>
							{/if}
						</div>
						<p class="mt-1 mb-2 text-sm text-muted-foreground">{skill.description ?? skill.relPath}</p>
						<div class="h-1 w-40 overflow-hidden rounded-full bg-muted">
							<div
								class={[
									'h-full',
									budgetClass(skill.charCount) === 'green' && 'bg-emerald-600',
									budgetClass(skill.charCount) === 'amber' && 'bg-amber-500',
									budgetClass(skill.charCount) === 'red' && 'bg-destructive'
								]}
								style="width: {Math.min(100, (skill.charCount / MAX_SKILL_FILE_CHARS) * 100)}%"
							></div>
						</div>
						<span class="text-xs text-muted-foreground">{skill.charCount} / {MAX_SKILL_FILE_CHARS}</span>
					</div>

					<div class="flex flex-wrap items-center gap-3">
						<label class="flex cursor-pointer items-center gap-1.5 text-xs">
							<input type="checkbox" checked={skill.enabled} onchange={() => toggleEnabled(skill)} class="accent-primary" />
							{t('SkillsSettingsPage.enabledLabel')}
						</label>
						<label class="flex items-center gap-1.5 text-xs">
							{t('SkillsSettingsPage.priorityLabel')}
							<Input
								type="number"
								min="0"
								max="100"
								value={skill.priority}
								onchange={(e) => changePriority(skill, Number(e.currentTarget.value))}
								class="h-7 w-16"
							/>
						</label>
						<Button size="sm" variant="outline" onclick={() => openEditor(skill)}>{t('SkillsSettingsPage.edit')}</Button>
						<Button size="sm" variant="destructive" onclick={() => removeSkill(skill)}>{t('Common.sil')}</Button>
					</div>
				</Card.Content>
			</Card.Root>
		{:else}
			<p class="text-sm text-muted-foreground">
				{t('SkillsSettingsPage.empty')}
			</p>
		{/each}
	</div>
</div>

<Dialog.Root bind:open={editorOpen}>
	<Dialog.Content class="sm:max-w-lg max-h-[85vh] overflow-y-auto">
		<Dialog.Header>
			<Dialog.Title>{editorIsNew ? t('SkillsSettingsPage.newSkillDialogTitle') : editorName}</Dialog.Title>
		</Dialog.Header>

		{#if editorIsNew}
			<label class="flex flex-col gap-1 text-sm">
				{t('SkillsSettingsPage.nameLabel')}
				<Input type="text" bind:value={editorName} placeholder={t('SkillsSettingsPage.namePlaceholder')} />
			</label>
		{/if}

		<div class="flex flex-col gap-1 text-sm">
			<div class="flex items-center justify-between gap-2">
				<label for="skill-editor-content">{t('SkillsSettingsPage.contentLabel')}</label>
				<label class="cursor-pointer text-xs text-muted-foreground underline underline-offset-2">
					{t('SkillsSettingsPage.uploadFile')}
					<input type="file" accept=".md,.markdown,text/markdown" class="sr-only" onchange={handleFileUpload} />
				</label>
			</div>
			<Textarea
				id="skill-editor-content"
				bind:value={editorRaw}
				spellcheck="false"
				class="min-h-64 max-h-[55vh] overflow-y-auto font-mono text-[0.82rem]"
			/>
		</div>

		{#if editorError}
			<p class="text-sm text-destructive">{editorError}</p>
		{/if}

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (editorOpen = false)}>{t('Common.iptal')}</Button>
			<Button onclick={saveEditor} disabled={editorSaving}>
				{editorSaving ? t('Common.kaydediliyor') : t('Common.kaydet')}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={previewOpen}>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>{t('SkillsSettingsPage.previewDialogTitle', { scope: SCOPE_LABELS[previewScope] })}</Dialog.Title>
		</Dialog.Header>
		{#if previewLoading}
			<p class="text-sm text-muted-foreground">{t('Common.yukleniyor')}</p>
		{:else}
			<pre class="max-h-[60vh] overflow-y-auto rounded-lg bg-muted p-3.5 font-mono text-xs whitespace-pre-wrap">{previewText}</pre>
		{/if}
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (previewOpen = false)}>{t('Common.kapat')}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
