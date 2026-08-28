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
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';

	const SCOPE_LABELS: Record<UserSkillScope, string> = {
		chat: 'Sohbet',
		quiz: 'Test',
		flashcards: 'Kartlar',
		mindmap: 'Zihin haritası',
		report: 'Rapor',
		slides: 'Slayt'
	};

	const PREVIEW_SCOPES: UserSkillScope[] = ['chat', 'quiz', 'flashcards', 'report', 'mindmap', 'slides'];

	const TEMPLATE = `---
description: Bu skill ne yapar? (zorunlu)
scope: all
enabled: true
priority: 50
---
Kurallar, tercihler, yasaklar... serbest markdown.
`;

	let skills = $state<UserSkillStatus[]>([]);
	let loadError = $state('');

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
			loadError = 'Skill listesi alınamadı.';
		}
	}

	onMount(refresh);

	function scopeChips(scope: UserSkillStatus['scope']): string[] {
		return scope === 'all' ? ['Tümü'] : scope.map((s) => SCOPE_LABELS[s]);
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
			loadError = `"${skill.name}" güncellenemedi.`;
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
			loadError = `"${skill.name}" güncellenemedi.`;
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
			loadError = `"${skill.name}" yüklenemedi.`;
		}
	}

	function openNewEditor() {
		editorError = '';
		editorName = '';
		editorRaw = TEMPLATE;
		editorIsNew = true;
		editorOpen = true;
	}

	async function saveEditor() {
		const name = editorName.trim();
		if (!name) {
			editorError = 'İsim gerekli.';
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
				editorError = body?.message ?? 'Kaydedilemedi.';
				return;
			}
			editorOpen = false;
			await refresh();
		} catch {
			editorError = 'Kaydedilemedi.';
		} finally {
			editorSaving = false;
		}
	}

	async function removeSkill(skill: UserSkillStatus) {
		if (!confirm(`"${skill.name}" silinsin mi?`)) return;
		try {
			const res = await fetch(`/api/skills/${encodeURIComponent(skill.name)}`, { method: 'DELETE' });
			if (!res.ok) throw new Error();
			await refresh();
		} catch {
			loadError = `"${skill.name}" silinemedi.`;
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
			previewText = 'Önizleme alınamadı.';
		} finally {
			previewLoading = false;
		}
	}
</script>

<svelte:head>
	<title>Kullanıcı Skill'leri — Vault Agent Toolkit</title>
</svelte:head>

<div class="mx-auto max-w-3xl px-4 pt-6 pb-12">
	<div class="mb-3 flex items-baseline gap-4">
		<a href="/settings" class="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2">
			<ArrowLeftIcon size={14} aria-hidden="true" /> Ayarlar
		</a>
		<h1 class="font-display text-xl font-medium">Kullanıcı Skill'leri</h1>
	</div>

	<p class="mb-5 text-sm text-muted-foreground">
		<code class="rounded bg-muted px-1 py-0.5 text-xs">data/skills/</code> içine bıraktığın markdown
		dosyaları sohbet, test ve bilgi kartı üretimini özelleştirir. Matematik biçimi ve kaynak
		doğrulama kuralları her zaman en son uygulanır — bir skill bunları geçersiz kılamaz.
	</p>

	{#if loadError}
		<p class="mb-4 text-sm text-destructive">{loadError}</p>
	{/if}

	<div class="mb-5 flex flex-wrap items-center justify-between gap-3">
		<Button onclick={openNewEditor}>+ Yeni skill</Button>
		<div class="flex gap-1.5">
			<Select.Root type="single" bind:value={previewScope}>
				<Select.Trigger class="w-44">{SCOPE_LABELS[previewScope]}</Select.Trigger>
				<Select.Content>
					{#each PREVIEW_SCOPES as scope (scope)}
						<Select.Item value={scope} label={SCOPE_LABELS[scope]}>{SCOPE_LABELS[scope]}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
			<Button variant="outline" onclick={runPreview}>Önizleme</Button>
		</div>
	</div>

	<div class="flex flex-col gap-3">
		{#each skills as skill (skill.relPath)}
			<Card.Root>
				<Card.Content class="flex flex-wrap justify-between gap-4">
					<div class="min-w-[220px] flex-1">
						<div class="flex flex-wrap items-center gap-1.5">
							<strong class="text-sm">{skill.name}</strong>
							{#each scopeChips(skill.scope) as chip (chip)}
								<Badge variant="outline">{chip}</Badge>
							{/each}
							{#if skill.parseError}
								<Badge variant="destructive" title={skill.parseError}>hata</Badge>
							{/if}
							{#if skill.truncated}
								<Badge class="bg-amber-500/20 text-amber-700 dark:text-amber-400">kısaltıldı</Badge>
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
							Etkin
						</label>
						<label class="flex items-center gap-1.5 text-xs">
							Öncelik
							<Input
								type="number"
								min="0"
								max="100"
								value={skill.priority}
								onchange={(e) => changePriority(skill, Number(e.currentTarget.value))}
								class="h-7 w-16"
							/>
						</label>
						<Button size="sm" variant="outline" onclick={() => openEditor(skill)}>Düzenle</Button>
						<Button size="sm" variant="destructive" onclick={() => removeSkill(skill)}>Sil</Button>
					</div>
				</Card.Content>
			</Card.Root>
		{:else}
			<p class="text-sm text-muted-foreground">
				Henüz skill yok. "_examples/" klasöründeki örnekler devre dışı olarak geldi — düzenleyip
				etkinleştirebilirsin.
			</p>
		{/each}
	</div>
</div>

<Dialog.Root bind:open={editorOpen}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{editorIsNew ? 'Yeni skill' : editorName}</Dialog.Title>
		</Dialog.Header>

		{#if editorIsNew}
			<label class="flex flex-col gap-1 text-sm">
				İsim (kebab-case)
				<Input type="text" bind:value={editorName} placeholder="örn. math-notation" />
			</label>
		{/if}

		<label class="flex flex-col gap-1 text-sm">
			İçerik (frontmatter + markdown)
			<Textarea bind:value={editorRaw} spellcheck="false" class="min-h-64 font-mono text-[0.82rem]" />
		</label>

		{#if editorError}
			<p class="text-sm text-destructive">{editorError}</p>
		{/if}

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (editorOpen = false)}>İptal</Button>
			<Button onclick={saveEditor} disabled={editorSaving}>
				{editorSaving ? 'Kaydediliyor...' : 'Kaydet'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={previewOpen}>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Önizleme — {SCOPE_LABELS[previewScope]}</Dialog.Title>
		</Dialog.Header>
		{#if previewLoading}
			<p class="text-sm text-muted-foreground">Yükleniyor...</p>
		{:else}
			<pre class="max-h-[60vh] overflow-y-auto rounded-lg bg-muted p-3.5 font-mono text-xs whitespace-pre-wrap">{previewText}</pre>
		{/if}
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (previewOpen = false)}>Kapat</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
