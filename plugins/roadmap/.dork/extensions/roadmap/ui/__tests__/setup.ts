/**
 * The panel runs on the host's React global (`globalThis.React`); the tests
 * provide it the same way, and unmount after each test since vitest globals
 * are off.
 */

import * as React from 'react';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
});
