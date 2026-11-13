import { screen, within } from '@testing-library/react';
import { expect } from 'vitest';

/**
 * Success answers with their version in „Technische Angaben“ (Entscheidung des Projektinhabers, 2026-11-13: „#355 F3,
 * Versionsnummern in Erfolgs- und Rückfragetexten: aus dem Sichtbereich, die Version steht in „Technische Angaben“.“).
 */

/** The collapsed blocks „Technische Angaben“ in `root`. */
export const technicalBlocks = (root: ParentNode): HTMLDetailsElement[] =>
  [...root.querySelectorAll('details')].filter((details) => details.querySelector('summary')?.textContent === 'Technische Angaben');

/** The text of `element` a user reads without opening a block „Technische Angaben“. */
export function visibleText(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  for (const details of technicalBlocks(copy)) details.remove();
  return copy.textContent ?? '';
}

/**
 * Checks one success notice: it says no „Version“, its block „Technische Angaben“ follows it, collapsed, and starts the
 * version with `version` (a number, then the entity tag or nothing).
 */
export function expectSaved(notice: HTMLElement, version: number): HTMLElement {
  expect(notice.textContent).not.toMatch(/Version/);
  const details = notice.nextElementSibling;
  expect(details?.tagName).toBe('DETAILS');
  expect((details as HTMLDetailsElement).open).toBe(false);
  expect(details?.querySelector('summary')?.textContent).toBe('Technische Angaben');
  expect(details?.querySelector('dt')?.textContent).toBe('Version');
  expect(details?.querySelector('dd')?.textContent).toMatch(new RegExp(`^${version}(?!\\d)`));
  return notice;
}

/** Waits for the success notice `text` (in `root`, or the whole page) and checks it with `expectSaved`. */
export async function findSaved(text: RegExp | string, version: number, root?: HTMLElement): Promise<HTMLElement> {
  const notice = await (root === undefined ? screen : within(root)).findByText(text);
  return expectSaved(notice, version);
}
