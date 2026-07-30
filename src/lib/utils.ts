import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn-svelte's standard class-merge helper — every copied ui/
 * component imports this. clsx handles conditional classes,
 * twMerge resolves Tailwind class conflicts (e.g. "p-2 p-4" -> "p-4"). */
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}

/** Standard shadcn-svelte (Svelte 5) prop-type helpers — every generated
 * ui/ component imports one or more of these from $lib/utils, not from
 * bits-ui. Bound to a real DOM ref instead of Svelte 4's exported
 * component-instance binding. */
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };
export type WithoutChild<T> = T extends { child?: unknown } ? Omit<T, 'child'> : T;
export type WithoutChildren<T> = T extends { children?: unknown } ? Omit<T, 'children'> : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
