/**
 * The host's React, reached lazily.
 *
 * DorkOS puts its own React on `globalThis.React` and bundles this extension
 * with `react` as an external, so the extension must never carry a React of its
 * own (two Reacts break hooks). The DorkOS extension test harness also imports
 * the built bundle in Node, where no `React` global exists, so nothing here
 * touches `React` until a component renders.
 *
 * @module @dorkos/flow/extension/ui/react
 */

import type * as ReactTypes from 'react';

/** The host's React global (`apps/client/src/main.tsx` sets it). */
declare const React: typeof ReactTypes;

/**
 * `React.createElement`, resolved when called.
 *
 * @returns The element.
 */
export const h = ((...args: Parameters<typeof ReactTypes.createElement>) =>
  React.createElement(...args)) as typeof ReactTypes.createElement;

/**
 * `React.useState`, resolved when called.
 *
 * @returns The state and its setter.
 */
export const useState = ((initial: unknown) =>
  React.useState(initial)) as typeof ReactTypes.useState;

/**
 * `React.useEffect`, resolved when called.
 */
export const useEffect: typeof ReactTypes.useEffect = (effect, deps) =>
  React.useEffect(effect, deps);

/**
 * `React.useRef`, resolved when called.
 *
 * @returns The ref.
 */
export const useRef = ((initial: unknown) => React.useRef(initial)) as typeof ReactTypes.useRef;

/**
 * `React.useId`, resolved when called.
 *
 * @returns A stable id for this component.
 */
export const useId: typeof ReactTypes.useId = () => React.useId();

/** A component's children or a rendered value. */
export type Node = ReactTypes.ReactNode;

/** Inline style props. */
export type Style = ReactTypes.CSSProperties;

/** A keyboard event from a host element. */
export type KeyEvent = ReactTypes.KeyboardEvent<HTMLElement>;
