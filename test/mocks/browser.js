// Browser API mock for testing
import { vi } from 'vitest';

export default {
  tabs: {
    query: vi.fn(),
    remove: vi.fn(),
    move: vi.fn(),
  },
  windows: {
    getAll: vi.fn(),
    getCurrent: vi.fn(),
    remove: vi.fn(),
  },
  storage: {
    local: {
      get: vi.fn(),
      set: vi.fn(),
    },
  },
  notifications: {
    create: vi.fn(),
  },
  contextMenus: {
    create: vi.fn(),
    onClicked: { addListener: vi.fn() },
  },
  commands: {
    onCommand: { addListener: vi.fn() },
  },
  runtime: {
    onMessage: { addListener: vi.fn() },
    onInstalled: { addListener: vi.fn() },
    sendMessage: vi.fn(),
  },
};
