<script lang="ts">
	import { Switch as SwitchPrimitive } from "bits-ui";
	import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		checked = $bindable(false),
		size = "default",
		...restProps
	}: WithoutChildrenOrChild<SwitchPrimitive.RootProps> & {
		size?: "sm" | "default";
	} = $props();
</script>

<SwitchPrimitive.Root
	bind:ref
	bind:checked
	data-slot="switch"
	data-size={size}
	class={cn(
		"shrink-0 rounded-full border border-transparent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=default]:h-[26px] data-[size=default]:w-[42px] data-[size=sm]:h-[18px] data-[size=sm]:w-[30px] dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-[state=checked]:bg-primary data-[state=unchecked]:bg-[var(--fill-pressed)] data-[state=unchecked]:shadow-[inset_0_0_0_1px_var(--border-control)] peer group/switch relative inline-flex items-center transition-all outline-none after:absolute after:-inset-x-3 after:-inset-y-2 data-disabled:cursor-not-allowed data-disabled:opacity-50",
		className
	)}
	{...restProps}
>
	<SwitchPrimitive.Thumb
		data-slot="switch-thumb"
		class="rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.3)] group-data-[size=default]/switch:size-5 group-data-[size=sm]/switch:size-3.5 group-data-[size=default]/switch:data-[state=checked]:translate-x-[19px] group-data-[size=sm]/switch:data-[state=checked]:translate-x-[14px] group-data-[size=default]/switch:data-[state=unchecked]:translate-x-[3px] group-data-[size=sm]/switch:data-[state=unchecked]:translate-x-[2px] pointer-events-none block ring-0 transition-transform rtl:data-[state=checked]:-translate-x-[19px]"
	/>
</SwitchPrimitive.Root>
