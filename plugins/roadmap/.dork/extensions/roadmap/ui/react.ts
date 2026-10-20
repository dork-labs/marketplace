/**
 * The host's React, reached lazily.
 *
 * DorkOS puts its own React on `globalThis.React` and bundles this extension
 * with `react` as an external, so the extension must never carry a React of its
 * own (two Reacts break hooks). Nothing here touches `React` until a component
 * renders, so the bundle can be imported where no `React` global exists.
 *
 * @module @dorkos/roadmap/extension/ui/react
 */

import type * as ReactTypes from 'react';

/** The host's React global. */
declare const React: typeof ReactTypes;

/** `React.createElement`, resolved when called. */
export const h = ((...args: Parameters<typeof ReactTypes.createElement>) =>
  React.createElement(...args)) as typeof ReactTypes.createElement;

/** `React.useState`, resolved when called. */
export const useState = ((initial: unknown) =>
  React.useState(initial)) as typeof ReactTypes.useState;

/** `React.useEffect`, resolved when called. */
export const useEffect: typeof ReactTypes.useEffect = (effect, deps) =>
  React.useEffect(effect, deps);

/** `React.useRef`, resolved when called. */
export const useRef = ((initial: unknown) => React.useRef(initial)) as typeof ReactTypes.useRef;

/** `React.useId`, resolved when called. */
export const useId: typeof ReactTypes.useId = () => React.useId();

/** A component's children or a rendered value. */
export type Node = ReactTypes.ReactNode;
