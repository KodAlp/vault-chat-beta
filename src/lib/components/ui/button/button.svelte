<script lang="ts" module>
	import { type VariantProps, tv } from "tailwind-variants";
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";

	export const buttonVariants = tv({
		base: "rounded-[var(--radius-md)] border border-transparent bg-clip-padding text-[15px] leading-5 tracking-[-0.23px] font-medium active:scale-[0.97] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg:not([class*='size-'])]:size-4 group/button inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-[background-color,transform,color] duration-[var(--duration-fast)] outline-none select-none disabled:pointer-events-none disabled:scale-100 disabled:bg-[var(--fill-hover)] disabled:text-[var(--label-tertiary)] disabled:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0",
		variants: {
			variant: {
				default: "bg-primary text-primary-foreground hover:bg-[var(--accent-hover)]",
				outline: "bg-transparent text-foreground shadow-[inset_0_0_0_1px_var(--separator-strong)] hover:bg-accent aria-expanded:bg-accent",
				secondary: "bg-secondary text-secondary-foreground shadow-[inset_0_0_0_1px_var(--separator)] hover:bg-[var(--fill-hover)] aria-expanded:bg-[var(--fill-hover)]",
				ghost: "hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground",
				destructive: "bg-transparent text-destructive shadow-[inset_0_0_0_1px_var(--separator-strong)] hover:bg-accent focus-visible:ring-destructive/30",
				link: "text-primary underline-offset-4 hover:underline",
			},
			size: {
				default: "h-8 gap-1.5 px-3 has-data-[icon=inline-end]:pe-2 has-data-[icon=inline-start]:ps-2",
				xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pe-1.5 has-data-[icon=inline-start]:ps-1.5 [&_svg:not([class*='size-'])]:size-3",
				sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[13px] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pe-1.5 has-data-[icon=inline-start]:ps-1.5 [&_svg:not([class*='size-'])]:size-3.5",
				lg: "h-11 gap-1.5 rounded-[var(--radius-lg)] px-5 text-[17px] leading-[22px] has-data-[icon=inline-end]:pe-4 has-data-[icon=inline-start]:ps-4",
				icon: "size-8",
				"icon-xs": "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
				"icon-sm": "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
				"icon-lg": "size-9",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>["variant"];
	export type ButtonSize = VariantProps<typeof buttonVariants>["size"];

	export type ButtonProps = WithElementRef<HTMLButtonAttributes> &
		WithElementRef<HTMLAnchorAttributes> & {
			variant?: ButtonVariant;
			size?: ButtonSize;
			/** Shows an inline spinner and forces disabled — for an async
			 * action (kaydet/sil/generate) whose button should give immediate
			 * feedback instead of looking unresponsive until the request
			 * settles. Reuses the same animate-spin ring already used for
			 * UploadDialog/ImportObsidianDialog's own status spinners, just on
			 * border-current so it matches whatever variant's text color is. */
			loading?: boolean;
		};
</script>

<script lang="ts">
	let {
		class: className,
		variant = "default",
		size = "default",
		ref = $bindable(null),
		href = undefined,
		type = "button",
		disabled,
		loading = false,
		children,
		...restProps
	}: ButtonProps = $props();

	let isDisabled = $derived(disabled || loading);
</script>

{#snippet spinner()}
	<span
		class="inline-block size-3.5 shrink-0 animate-spin rounded-full border-2 border-current/30 border-t-current"
		aria-hidden="true"
	></span>
{/snippet}

{#if href}
	<a
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		href={isDisabled ? undefined : href}
		aria-disabled={isDisabled}
		aria-busy={loading}
		role={isDisabled ? "link" : undefined}
		tabindex={isDisabled ? -1 : undefined}
		{...restProps}
	>
		{#if loading}{@render spinner()}{/if}
		{@render children?.()}
	</a>
{:else}
	<button
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		{type}
		disabled={isDisabled}
		aria-busy={loading}
		{...restProps}
	>
		{#if loading}{@render spinner()}{/if}
		{@render children?.()}
	</button>
{/if}
