import type { UiLanguage } from "../shared/i18n/index.ts";

/**
 * The sidebar entry's title, kept in step with the panel's language.
 *
 * The entry is registered in `contribute()`, which runs before the panel exists and
 * cannot wait for the server; the panel changes the language long after. This is the
 * one line between them: the entry point says how to retitle, the panel asks for it.
 */
let apply: ((language: UiLanguage) => void) | null = null;

export function onRetitle(next: (language: UiLanguage) => void): void {
  apply = next;
}

export function retitle(language: UiLanguage): void {
  apply?.(language);
}
