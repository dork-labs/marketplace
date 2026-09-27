import { describe, expect, it, vi } from 'vitest';
import { activate } from '../../index.ts';
import { FleetTab } from '../fleet-tab.ts';

describe('activate', () => {
  it('registers the Flow tab under Add-ons and returns its cleanup', () => {
    const unregister = vi.fn();
    const registerSettingsTab = vi.fn(() => unregister);
    const cleanup = activate({ registerSettingsTab });
    expect(registerSettingsTab).toHaveBeenCalledTimes(1);
    expect(registerSettingsTab).toHaveBeenCalledWith('fleet', 'Flow', FleetTab, {
      group: 'Add-ons',
    });
    cleanup();
    expect(unregister).toHaveBeenCalledTimes(1);
  });
});
