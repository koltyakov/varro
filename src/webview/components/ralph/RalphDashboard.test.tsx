import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type { RalphIteration, RalphRun } from '../../../shared/ralph';
import { RalphDashboard } from './RalphDashboard';
import type { ProviderLimitStatus } from '../../../shared/protocol';

const getRunMock = vi.hoisted(() => vi.fn());
const pauseMock = vi.hoisted(() => vi.fn());
const resumeMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const stopMock = vi.hoisted(() => vi.fn());
const getProviderLimitMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/stores/ralph-store', () => ({
  ralphStore: {
    getRun: getRunMock,
  },
}));

vi.mock('../../lib/state', () => ({
  getProviderLimit: getProviderLimitMock,
  getActiveUsageLimitNotice: vi.fn((sessionId: string) => currentUsageLimits[sessionId] || null),
  state: {
    get sessionStatus() {
      return currentSessionStatus;
    },
    get failedSessionIds() {
      return currentFailedSessionIds;
    },
  },
}));

vi.mock('./ralph-runner', () => ({
  ralphRunner: {
    pause: pauseMock,
    resume: resumeMock,
    stop: stopMock,
  },
}));

vi.mock('./RalphIterationCard', () => ({
  RalphIterationCard: (props: { iteration: RalphIteration }) => (
    <div class="ralph-iter-card-mock">iter {props.iteration.index}</div>
  ),
}));

type ResizeObserverInstance = {
  callback: ResizeObserverCallback;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

let currentRun: RalphRun | null = null;
let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;
let resizeObserverInstances: ResizeObserverInstance[] = [];
const originalResizeObserver = globalThis.ResizeObserver;
let currentSessionStatus: Record<string, unknown> = {};
let currentUsageLimits: Record<string, unknown> = {};
let currentFailedSessionIds: string[] = [];

function providerLimit(overrides: Partial<ProviderLimitStatus> = {}): ProviderLimitStatus {
  return {
    providerID: 'openai',
    modelID: 'gpt-5',
    status: 'available',
    source: 'provider',
    checkedAt: 200,
    windows: [
      {
        id: 'daily',
        label: 'Daily',
        unit: 'requests',
        remaining: 8,
        limit: 100,
        resetAt: Date.now() + 60_000,
        percent: 92,
      },
    ],
    ...overrides,
  } as ProviderLimitStatus;
}

function iteration(index: number): RalphIteration {
  return {
    index,
    childSessionId: null,
    status: 'passed',
    startedAt: null,
    endedAt: null,
    filesChanged: [],
    verification: {},
  };
}

function run(
  overrides: Omit<Partial<RalphRun>, 'config'> & { config?: Partial<RalphRun['config']> } = {}
): RalphRun {
  const { config: configOverrides, ...rest } = overrides;

  return {
    config: {
      managerSessionId: 'manager-1',
      planDocPath: 'docs/PLAN.md',
      iterations: 4,
      promptTemplate: 'follow the plan',
      permissionMode: 'default',
      model: null,
      agent: null,
      createdAt: 100,
      ...configOverrides,
    },
    status: 'running',
    currentIteration: 2,
    iterations: [iteration(1), iteration(2)],
    updatedAt: 200,
    ...rest,
  };
}

function renderDashboard() {
  cleanup = render(() => RalphDashboard({ sessionId: 'manager-1' }), container!);
}

function setElementWidths(element: HTMLElement, offsetWidth: number, clientWidth: number) {
  Object.defineProperty(element, 'offsetWidth', { configurable: true, value: offsetWidth });
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: clientWidth });
}

beforeEach(() => {
  currentRun = null;
  getRunMock.mockReset();
  getRunMock.mockImplementation(() => currentRun);
  pauseMock.mockReset();
  resumeMock.mockReset();
  resumeMock.mockResolvedValue(undefined);
  stopMock.mockReset();
  getProviderLimitMock.mockReset();
  getProviderLimitMock.mockReturnValue(null);
  resizeObserverInstances = [];
  currentSessionStatus = {};
  currentUsageLimits = {};
  currentFailedSessionIds = [];
  class ResizeObserverMock {
    callback: ResizeObserverCallback;
    observe = vi.fn();
    disconnect = vi.fn();

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      resizeObserverInstances.push(this);
    }
  }
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  if (originalResizeObserver) {
    globalThis.ResizeObserver = originalResizeObserver;
  } else {
    delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  }
});

describe('RalphDashboard', () => {
  it('renders the missing-run fallback and updates the scrollbar inset', () => {
    renderDashboard();

    const listScroll = container?.querySelector('.ralph-dashboard-list-scroll');
    expect(container?.textContent).toContain('Ralph run not found.');
    expect(resizeObserverInstances).toHaveLength(1);
    expect(listScroll).toBeInstanceOf(HTMLDivElement);

    setElementWidths(listScroll as HTMLDivElement, 152, 120);
    resizeObserverInstances[0]?.callback([], {} as ResizeObserver);

    expect(
      listScroll?.parentElement?.style.getPropertyValue('--ralph-dashboard-scrollbar-inset')
    ).toBe('32px');

    const disconnectSpy = resizeObserverInstances[0]?.disconnect;
    cleanup?.();
    cleanup = undefined;

    expect(disconnectSpy).toHaveBeenCalledTimes(1);
  });

  it('renders running metadata, reverses iterations, and wires pause/stop actions', () => {
    currentRun = run({
      status: 'running',
      config: {
        iterations: 5,
        model: { providerID: 'openai', modelID: 'gpt-5', variant: 'low' },
        agent: 'builder',
      },
      iterations: [iteration(1), iteration(2), iteration(3)],
    });
    getProviderLimitMock.mockReturnValue(providerLimit());

    renderDashboard();

    expect(container?.querySelector('.ralph-dashboard-plan')?.textContent).toBe('PLAN.md');
    expect(container?.querySelector('.ralph-dashboard-plan')?.getAttribute('title')).toBe(
      'docs/PLAN.md'
    );
    expect(container?.querySelector('.ralph-dashboard-status')?.textContent).toBe('running');
    expect(container?.querySelector('.ralph-dashboard-stop-reason')).toBeNull();
    expect(container?.querySelector('.ralph-dashboard-meta')?.textContent).toContain(
      'Iterations: 3 / 5'
    );
    expect(container?.querySelector('.ralph-dashboard-meta')?.textContent).toContain(
      'Model: openai/gpt-5 (Low)'
    );
    expect(container?.querySelector('.ralph-dashboard-meta')?.textContent).toContain(
      'Agent: builder'
    );
    expect(container?.querySelector('.ralph-dashboard-provider-limits')?.textContent).toContain(
      'Limits: D 8%'
    );
    expect(
      container?.querySelector('.ralph-dashboard-provider-limits')?.getAttribute('title')
    ).toContain('Daily: 8 / 100 left');
    expect(container?.querySelector('.ralph-dashboard-provider-limit')?.className).toContain(
      'error'
    );
    expect(
      container?.querySelector('.ralph-dashboard-meta-item-model')?.getAttribute('title')
    ).toBe('openai/gpt-5 (Low)');
    expect(
      Array.from(container?.querySelectorAll('.ralph-iter-card-mock') ?? []).map((node) =>
        node.textContent?.trim()
      )
    ).toEqual(['iter 3', 'iter 2', 'iter 1']);

    container
      ?.querySelector<HTMLButtonElement>('button[aria-label="Pause"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    container
      ?.querySelector<HTMLButtonElement>('button[aria-label="Stop"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(container?.querySelector('button[aria-label="Resume"]')).toBeNull();
    expect(pauseMock).toHaveBeenCalledWith('manager-1');
    expect(stopMock).toHaveBeenCalledWith('manager-1');
  });

  it('shows the paused resume branch and empty-iteration fallback', () => {
    currentRun = run({
      status: 'paused',
      iterations: [],
    });
    getProviderLimitMock.mockReturnValue(providerLimit());

    renderDashboard();

    const resumeButton = container?.querySelector<HTMLButtonElement>('button[aria-label="Resume"]');

    expect(resumeButton?.textContent?.trim()).toBe('Resume');
    expect(resumeButton?.className).toBe('ralph-dashboard-btn');
    expect(container?.querySelector('button[aria-label="Pause"]')).toBeNull();
    expect(container?.querySelector('button[aria-label="Stop"]')).toBeInstanceOf(HTMLButtonElement);
    expect(container?.querySelector('.ralph-dashboard-provider-limits')).toBeNull();
    expect(container?.textContent).toContain('No iterations yet.');

    resumeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(resumeMock).toHaveBeenCalledWith('manager-1');
  });

  it('shows 5h, W, and M provider limits together when available', () => {
    currentRun = run({
      status: 'running',
      config: {
        model: { providerID: 'openai', modelID: 'gpt-5', variant: 'low' },
      },
    });
    getProviderLimitMock.mockReturnValue(
      providerLimit({
        windows: [
          {
            id: 'month',
            label: 'Monthly',
            unit: 'requests',
            remaining: 40,
            limit: 100,
            resetAt: Date.now() + 60_000,
            percent: 60,
          },
          {
            id: 'five_hour',
            label: '5-hour',
            unit: 'requests',
            remaining: 0,
            limit: 100,
            resetAt: Date.now() + 60_000,
            percent: 100,
          },
          {
            id: 'week',
            label: 'Weekly',
            unit: 'requests',
            remaining: 12,
            limit: 100,
            resetAt: Date.now() + 60_000,
            percent: 88,
          },
          {
            id: 'day',
            label: 'Daily',
            unit: 'requests',
            remaining: 8,
            limit: 100,
            resetAt: Date.now() + 60_000,
            percent: 92,
          },
        ],
      })
    );

    renderDashboard();

    const limits = container?.querySelector('.ralph-dashboard-provider-limits');
    const badges = Array.from(
      container?.querySelectorAll('.ralph-dashboard-provider-limit') ?? []
    ).map((node) => node.textContent?.trim());

    expect(limits?.textContent).toContain('Limits:');
    expect(badges).toEqual(['0%', '12%', '40%']);
    expect(limits?.textContent).toContain('·');
    expect(limits?.getAttribute('title')).toContain('5-hour: 0 / 100 left');
    expect(limits?.getAttribute('title')).toContain('Weekly: 12 / 100 left');
    expect(limits?.getAttribute('title')).toContain('Monthly: 40 / 100 left');
  });

  it('reacts to live provider-limit updates without remounting', async () => {
    currentRun = run({
      status: 'running',
      config: {
        model: { providerID: 'openai', modelID: 'gpt-5', variant: 'low' },
      },
    });
    const [liveLimit, setLiveLimit] = createSignal<ProviderLimitStatus | null>(
      providerLimit({
        windows: [
          {
            id: 'daily',
            label: 'Daily',
            unit: 'requests',
            remaining: 8,
            limit: 100,
            resetAt: Date.now() + 60_000,
            percent: 92,
          },
        ],
      })
    );
    getProviderLimitMock.mockImplementation(() => liveLimit());

    renderDashboard();
    expect(container?.querySelector('.ralph-dashboard-provider-limits')?.textContent).toContain(
      'Limits: D 8%'
    );

    setLiveLimit(
      providerLimit({
        windows: [
          {
            id: 'daily',
            label: 'Daily',
            unit: 'requests',
            remaining: 37,
            limit: 100,
            resetAt: Date.now() + 60_000,
            percent: 63,
          },
        ],
      })
    );
    await Promise.resolve();

    expect(container?.querySelector('.ralph-dashboard-provider-limits')?.textContent).toContain(
      'Limits: D 37%'
    );
  });

  it('shows the incomplete continue branch', () => {
    currentRun = run({
      status: 'incomplete',
      stopReason: 'iteration_limit_with_gap',
      config: {
        model: { providerID: 'anthropic', modelID: 'claude', variant: 'very_high' },
      },
    });

    renderDashboard();

    const continueButton = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Add 5 runs & continue"]'
    );

    expect(continueButton).toBeInstanceOf(HTMLButtonElement);
    expect(continueButton?.className).toContain('ralph-dashboard-btn-continue');
    expect(continueButton?.querySelector('svg')).toBeInstanceOf(SVGElement);
    expect(continueButton?.getAttribute('title')).toBe(
      'Increase the iteration limit by 5 and continue the Ralph loop.'
    );
    expect(container?.querySelector('button[aria-label="Stop"]')).toBeNull();
    expect(container?.querySelector('.ralph-dashboard-status')?.textContent).toBe('incomplete');
    expect(container?.querySelector('.ralph-dashboard-stop-reason')?.textContent).toBe(
      'iteration limit · verification gap'
    );
    expect(container?.querySelector('.ralph-dashboard-meta')?.textContent).toContain(
      'Model: anthropic/claude (Very High)'
    );

    continueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(resumeMock).toHaveBeenCalledWith('manager-1');
  });

  it('hides the global error when the latest iteration already shows it', () => {
    currentRun = run({
      status: 'failed',
      stopReason: 'iteration_error',
      iterations: [
        iteration(1),
        iteration(2),
        { ...iteration(3), childSessionId: 'child-3', status: 'failed' },
      ],
    });
    currentUsageLimits = {
      'child-3': {
        source: 'status',
        statusCode: 429,
        message: 'messages exhausted · retry in 28s · attempt #5',
        unit: 'messages',
        retryAt: 28_000,
        attempt: 5,
        sessionID: 'child-3',
      },
    };

    renderDashboard();

    expect(container?.querySelector('.ralph-dashboard-error')).toBeNull();
  });

  it('keeps the global error when the latest iteration is not showing its own error row yet', () => {
    currentRun = run({
      status: 'failed',
      stopReason: 'iteration_error',
      iterations: [iteration(1), iteration(2), { ...iteration(3), childSessionId: 'child-3' }],
    });
    currentUsageLimits = {
      'child-3': {
        source: 'status',
        statusCode: 429,
        message: 'messages exhausted · retry in 28s · attempt #5',
        unit: 'messages',
        retryAt: 28_000,
        attempt: 5,
        sessionID: 'child-3',
      },
    };

    renderDashboard();

    expect(container?.querySelector('.ralph-dashboard-error-label')?.textContent).toBe('Error');
    expect(container?.querySelector('.ralph-dashboard-error-message')?.textContent).toBe(
      'messages exhausted · retry in 28s · attempt #5'
    );
  });

  it('hides action buttons for a terminal done run', () => {
    currentRun = run({
      status: 'done',
      stopReason: 'done_marker',
    });

    renderDashboard();

    expect(container?.querySelector('button[aria-label="Pause"]')).toBeNull();
    expect(container?.querySelector('button[aria-label="Resume"]')).toBeNull();
    expect(container?.querySelector('button[aria-label="Stop"]')).toBeNull();
    expect(container?.querySelector('.ralph-dashboard-status')?.textContent).toBe('done');
    expect(container?.querySelector('.ralph-dashboard-stop-reason')?.textContent).toBe(
      'plan marked DONE'
    );
  });

  it('hides the redundant manual stop-reason tag while keeping the stopped status', () => {
    currentRun = run({
      status: 'stopped',
      stopReason: 'manual_stop',
    });

    renderDashboard();

    expect(container?.querySelector('.ralph-dashboard-status')?.textContent).toBe('stopped');
    expect(container?.querySelector('.ralph-dashboard-stop-reason')).toBeNull();
  });
});
