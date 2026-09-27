import { describe, expect, it, vi } from 'vitest';
import { activate } from '../../index.ts';
import { FleetTab } from '../fleet-tab.ts';
import { FlowIcon } from '../flow-icon.ts';

describe('activate', () => {
  it('registers the Flow tab under Add-ons and the Flow panel, and returns their cleanup', () => {
    const removeTab = vi.fn();
    const removePanel = vi.fn();
    const registerSettingsTab = vi.fn(() => removeTab);
    const registerComponent = vi.fn(() => removePanel);
    const cleanup = activate({ registerSettingsTab, registerComponent, navigate: vi.fn() });
    expect(registerSettingsTab).toHaveBeenCalledTimes(1);
    expect(registerSettingsTab).toHaveBeenCalledWith('fleet', 'Flow', FleetTab, {
      group: 'Add-ons',
    });
    expect(registerComponent).toHaveBeenCalledTimes(1);
    expect(registerComponent).toHaveBeenCalledWith('right-panel', 'panel', expect.any(Function), {
      label: 'Flow',
      icon: FlowIcon,
    });
    cleanup();
    expect(removeTab).toHaveBeenCalledTimes(1);
    expect(removePanel).toHaveBeenCalledTimes(1);
  });
});
