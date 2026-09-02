import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebviewMessage } from '../../../shared/protocol';
import type { Agent } from '../../types';
import { openNewWindowIcon } from '../../lib/ui-icons';
import { toCssUrl } from '../UiIcon';
import { DEFAULT_TOOLTIP_DELAY } from '../Tooltip';
import {
  AgentPicker,
  ModelPickerButton,
  PermissionModePicker,
  ProviderLimitChip,
  VariantPicker,
  WorkspacePicker,
} from './ToolbarPickers';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve());
}

function createAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    name: 'planner',
    mode: 'subagent',
    builtIn: true,
    permission: {
      edit: 'ask',
      bash: {},
    },
    tools: {},
    ...overrides,
  };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  Reflect.deleteProperty(window, '__sendToExtension');
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ToolbarPickers', () => {
  it('only abbreviates workspace names with more than two words', () => {
    const [selectedPath, setSelectedPath] = createSignal('/jira-stats-tj');
    cleanup = render(
      () => (
        <WorkspacePicker
          folders={[
            { name: 'jira-stats-tj', path: '/jira-stats-tj' },
            { name: 'MyDotNetProject', path: '/MyDotNetProject' },
            { name: 'gosip', path: '/gosip' },
            { name: 'Drop Box', path: '/Drop Box' },
          ]}
          selectedPath={selectedPath()}
          showPicker={true}
          onToggle={vi.fn()}
          onSelect={vi.fn()}
        />
      ),
      container!
    );

    expect(container?.querySelector('.workspace-picker-abbreviation')?.textContent).toBe('jst');
    expect(
      [...(container?.querySelectorAll('.workspace-name-initial') ?? [])].map(
        (initial) => initial.textContent
      )
    ).toEqual(['j', 's', 't']);
    setSelectedPath('/MyDotNetProject');
    expect(container?.querySelector('.workspace-picker-abbreviation')?.textContent).toBe('mdnp');
    expect(
      [...(container?.querySelectorAll('.workspace-name-initial') ?? [])].map(
        (initial) => initial.textContent
      )
    ).toEqual(['M', 'D', 'N', 'P']);
    setSelectedPath('/gosip');
    expect(container?.querySelector('.workspace-picker-abbreviation')?.textContent).toBe('gosip');
    expect(container?.querySelectorAll('.workspace-name-initial')).toHaveLength(0);
    setSelectedPath('/Drop Box');
    expect(container?.querySelector('.workspace-picker-abbreviation')?.textContent).toBe(
      'Drop Box'
    );
    expect(container?.querySelectorAll('.workspace-name-initial')).toHaveLength(0);
  });

  it('indexes duplicate abbreviations in VS Code workspace order', () => {
    const [selectedPath, setSelectedPath] = createSignal('/jira-stats-tool');
    cleanup = render(
      () => (
        <WorkspacePicker
          folders={[
            { name: 'jira-stats-tool', path: '/jira-stats-tool' },
            { name: 'jobs-service-test', path: '/jobs-service-test' },
            { name: 'java-script-tools', path: '/java-script-tools' },
          ]}
          selectedPath={selectedPath()}
          showPicker={false}
          onToggle={vi.fn()}
          onSelect={vi.fn()}
        />
      ),
      container!
    );

    expect(container?.querySelector('.workspace-picker-abbreviation')?.textContent).toBe('jst1');
    setSelectedPath('/jobs-service-test');
    expect(container?.querySelector('.workspace-picker-abbreviation')?.textContent).toBe('jst2');
    setSelectedPath('/java-script-tools');
    expect(container?.querySelector('.workspace-picker-abbreviation')?.textContent).toBe('jst3');
  });

  it('announces the selected workspace and marks its option as current', () => {
    cleanup = render(
      () => (
        <WorkspacePicker
          folders={[
            { name: 'Repo A', path: '/repo-a' },
            { name: 'Repo B', path: '/repo-b' },
          ]}
          selectedPath="/repo-b"
          showPicker={true}
          onToggle={vi.fn()}
          onSelect={vi.fn()}
        />
      ),
      container!
    );

    expect(container?.querySelector('.workspace-picker-button')?.getAttribute('aria-label')).toBe(
      'Selected workspace: Repo B'
    );
    expect(
      container?.querySelector('[data-workspace-path="/repo-b"]')?.getAttribute('aria-current')
    ).toBe('true');
  });

  it('gives the all-folders option a secondary folder count', () => {
    cleanup = render(
      () => (
        <WorkspacePicker
          folders={[
            { name: 'Repo A', path: '/repo-a' },
            { name: 'Repo B', path: '/repo-b' },
          ]}
          selectedPath={null}
          showPicker={true}
          allLabel="All folders"
          onToggle={vi.fn()}
          onSelect={vi.fn()}
          onSelectAll={vi.fn()}
        />
      ),
      container!
    );

    const allFolders = container?.querySelector('.workspace-popover-all');
    expect(allFolders?.querySelector('.workspace-popover-name')?.textContent).toBe('All folders');
    expect(allFolders?.querySelector('.workspace-popover-path')?.textContent).toBe(
      '2 workspace folders'
    );
  });

  it('uses a folder count for the workspace tooltip and a path for folder tooltips', async () => {
    vi.useFakeTimers();
    const [selectedPath, setSelectedPath] = createSignal<string | null>(null);
    cleanup = render(
      () => (
        <WorkspacePicker
          folders={[
            { name: 'Repo A', path: '/repo-a' },
            { name: 'Repo B', path: '/repo-b' },
          ]}
          selectedPath={selectedPath()}
          showPicker={false}
          allLabel="Workspace"
          onToggle={vi.fn()}
          onSelect={vi.fn()}
          onSelectAll={vi.fn()}
        />
      ),
      container!
    );

    const button = container?.querySelector('.workspace-picker-button');
    button?.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(DEFAULT_TOOLTIP_DELAY);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('2 folders in workspace');

    button?.dispatchEvent(new MouseEvent('mouseleave'));
    setSelectedPath('/repo-b');
    button?.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(DEFAULT_TOOLTIP_DELAY);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('/repo-b');
  });

  it('marks an equivalent UNC workspace spelling as selected', () => {
    cleanup = render(
      () => (
        <WorkspacePicker
          folders={[{ name: 'Varro', path: '\\\\BuildServer\\Projects\\Varro' }]}
          selectedPath="//buildserver/PROJECTS/varro/"
          showPicker={true}
          onToggle={vi.fn()}
          onSelect={vi.fn()}
        />
      ),
      container!
    );

    expect(container?.querySelector('.workspace-picker-button')?.getAttribute('aria-label')).toBe(
      'Selected workspace: Varro'
    );
    expect(container?.querySelector('.toolbar-popover-item')?.getAttribute('aria-current')).toBe(
      'true'
    );
  });

  it('shows a workspace path title only when the path is truncated', async () => {
    cleanup = render(
      () => (
        <WorkspacePicker
          folders={[
            { name: 'Repo A', path: '/repo-a' },
            { name: 'Repo B', path: '/a/long/path/to/repo-b' },
          ]}
          selectedPath="/repo-a"
          showPicker={true}
          onToggle={vi.fn()}
          onSelect={vi.fn()}
        />
      ),
      container!
    );
    const path = container?.querySelector<HTMLElement>(
      '[data-workspace-path="/a/long/path/to/repo-b"] .workspace-popover-path'
    );
    let clientWidth = 200;
    vi.spyOn(path!, 'scrollWidth', 'get').mockReturnValue(160);
    vi.spyOn(path!, 'clientWidth', 'get').mockImplementation(() => clientWidth);
    window.dispatchEvent(new Event('resize'));
    await flushMicrotasks();
    expect(path?.getAttribute('title')).toBeNull();

    clientWidth = 100;
    window.dispatchEvent(new Event('resize'));
    await flushMicrotasks();
    expect(path?.getAttribute('title')).toBe('/a/long/path/to/repo-b');

    clientWidth = 200;
    window.dispatchEvent(new Event('resize'));
    await flushMicrotasks();
    expect(path?.getAttribute('title')).toBeNull();
  });

  it('uses one resize observer for the workspace popup', async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    let observerCount = 0;
    class ResizeObserverSpy {
      constructor(_callback: ResizeObserverCallback) {
        observerCount += 1;
      }
      observe() {}
      disconnect() {}
    }
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: ResizeObserverSpy,
    });

    try {
      cleanup = render(
        () => (
          <WorkspacePicker
            folders={Array.from({ length: 20 }, (_, index) => ({
              name: `Repo ${index}`,
              path: `/repo-${index}`,
            }))}
            selectedPath={null}
            showPicker={true}
            onToggle={vi.fn()}
            onSelect={vi.fn()}
          />
        ),
        container!
      );
      await flushMicrotasks();
      expect(observerCount).toBe(1);
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it('aligns the workspace popup and resizes it to the available boundary width', async () => {
    const boundary = document.createElement('div');
    const boundaryRect = vi.spyOn(boundary, 'getBoundingClientRect').mockReturnValue({
      x: 24,
      y: 0,
      top: 0,
      left: 24,
      right: 320,
      bottom: 100,
      width: 296,
      height: 100,
      toJSON: () => ({}),
    });

    cleanup = render(
      () => (
        <WorkspacePicker
          boundaryRef={boundary}
          alignTo="left"
          folders={[
            { name: 'Repo A', path: '/repo-a' },
            { name: 'Repo B', path: '/repo-b' },
          ]}
          selectedPath="/repo-a"
          showPicker={true}
          onToggle={vi.fn()}
          onSelect={vi.fn()}
        />
      ),
      container!
    );
    await flushMicrotasks();

    const popup = container?.querySelector<HTMLElement>('.toolbar-popover');
    expect(popup?.style.left).toBe('24px');
    expect(popup?.style.width).toBe('296px');

    boundaryRect.mockReturnValue({
      x: 24,
      y: 0,
      top: 0,
      left: 24,
      right: 204,
      bottom: 100,
      width: 180,
      height: 100,
      toJSON: () => ({}),
    });
    window.dispatchEvent(new Event('resize'));
    await flushMicrotasks();

    expect(popup?.style.width).toBe('180px');
  });

  it('renders the permission picker title, selection, and click handlers', () => {
    const onToggle = vi.fn();
    const onSelect = vi.fn();
    const parentClick = vi.fn();
    let buttonRef: HTMLButtonElement | undefined;
    let popoverRef: HTMLDivElement | undefined;

    cleanup = render(
      () => (
        <div onClick={parentClick}>
          <PermissionModePicker
            buttonRef={(el) => {
              buttonRef = el;
            }}
            popoverRef={(el) => {
              popoverRef = el;
            }}
            mode="default"
            showPicker={true}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        </div>
      ),
      container!
    );

    const toggleButton = container?.querySelector<HTMLButtonElement>('.toolbar-picker.icon-only');
    const options = container?.querySelectorAll<HTMLButtonElement>('.toolbar-popover-item') ?? [];

    expect(toggleButton?.getAttribute('aria-label')).toBe('Default permissions');
    expect(toggleButton?.getAttribute('title')).toBeNull();
    expect(buttonRef).toBe(toggleButton);
    expect(popoverRef).toBe(container?.querySelector('.toolbar-popover'));
    expect(options).toHaveLength(3);
    expect(options[0]?.className).toContain('selected');
    expect(options[0]?.textContent).toContain('Default (OpenCode config-based)');
    expect(options[1]?.className).not.toContain('selected');

    toggleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    options[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    popoverRef?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onToggle).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith('full');
    expect(parentClick).toHaveBeenCalledTimes(1);
  });

  it('opens the permission guide from the picker header', () => {
    const send = vi.fn<(message: WebviewMessage) => void>();
    Reflect.set(window, '__sendToExtension', send);

    cleanup = render(
      () => (
        <PermissionModePicker
          mode="default"
          showPicker={true}
          onToggle={vi.fn()}
          onSelect={vi.fn()}
        />
      ),
      container!
    );

    const learnMore = container?.querySelector<HTMLButtonElement>('.permission-mode-learn-more');
    const externalIcon = learnMore?.querySelector<HTMLElement>('.ui-icon');
    expect(learnMore?.textContent).toContain('Learn More');
    expect(externalIcon?.style.getPropertyValue('--ui-icon-mask')).toBe(
      toCssUrl(openNewWindowIcon)
    );

    learnMore?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open-external',
      payload: { url: 'https://github.com/koltyakov/varro/blob/main/docs/permissions.md' },
    });
  });

  it.each(['auto', 'full'] as const)('hides permission settings in %s mode', (mode) => {
    cleanup = render(
      () => (
        <PermissionModePicker
          mode={mode}
          showPicker={false}
          showLabel={true}
          onToggle={vi.fn()}
          onSelect={vi.fn()}
        />
      ),
      container!
    );

    expect(container?.querySelector('.permission-mode-settings-button')).toBeNull();
  });

  it('uses the auto-approve title when selected', () => {
    cleanup = render(
      () => (
        <PermissionModePicker
          mode="auto"
          showPicker={false}
          onToggle={vi.fn()}
          onSelect={vi.fn()}
        />
      ),
      container!
    );

    const toggleButton = container?.querySelector<HTMLButtonElement>('.toolbar-picker.icon-only');

    expect(toggleButton?.getAttribute('aria-label')).toBe('Auto-approve permissions');
  });

  it('shows active reviews and the five latest completed auto-approve activities', () => {
    const onToggle = vi.fn();
    cleanup = render(
      () => (
        <PermissionModePicker
          mode="auto"
          activity={[
            {
              permissionId: 'old',
              status: 'auto-approved',
              title: 'old completed request',
              createdAt: 0,
            },
            {
              permissionId: 'one',
              status: 'reviewing',
              title: 'npm test',
              createdAt: 1,
            },
            {
              permissionId: 'two',
              status: 'auto-approved',
              title: 'edit src/app.ts',
              detail: 'Workspace file edit.',
              createdAt: 2,
            },
            {
              permissionId: 'three',
              status: 'approval-required',
              title: 'external_directory /tmp/*',
              detail: 'Outside the workspace.',
              createdAt: 3,
            },
            {
              permissionId: 'four',
              status: 'auto-review-failed',
              title: 'npm publish',
              detail: 'Matches a prior rejection.',
              createdAt: 4,
            },
            {
              permissionId: 'five',
              status: 'manually-approved',
              title: 'npm install',
              createdAt: 5,
            },
            {
              permissionId: 'six',
              status: 'manually-rejected',
              title: 'rm -rf build',
              createdAt: 6,
            },
          ]}
          judgeModel={{ providerName: 'OpenAI', modelName: 'GPT-5.6' }}
          showPicker={false}
          showLabel={true}
          onToggle={onToggle}
          onSelect={vi.fn()}
        />
      ),
      container!
    );

    const toggleButton = container?.querySelector<HTMLButtonElement>('.permission-mode-button');
    const activity = container?.querySelector<HTMLElement>('.permission-activity');
    const dots = activity?.querySelectorAll<HTMLElement>('.permission-activity-item') ?? [];
    expect(dots).toHaveLength(6);
    expect(toggleButton?.contains(activity ?? null)).toBe(false);
    expect(activity?.previousElementSibling?.contains(toggleButton ?? null)).toBe(true);
    expect(dots[0]?.className).toContain('reviewing');
    expect(dots[1]?.className).toContain('auto-approved');
    expect(dots[2]?.className).toContain('approval-required');
    expect(dots[3]?.className).toContain('auto-review-failed');
    expect(dots[4]?.className).toContain('manually-approved');
    expect(dots[5]?.className).toContain('manually-rejected');
    expect(dots[1]?.title).toBe('Auto-approved: edit src/app.ts. Workspace file edit.');
    expect(dots[2]?.title).toBe(
      'Manual approval requested: external_directory /tmp/*. Outside the workspace.'
    );
    expect(toggleButton?.getAttribute('aria-label')).toBe(
      'Auto-approve permissions - OpenAI / GPT-5.6'
    );

    activity?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('omits the activity strip when no permission activity exists', () => {
    cleanup = render(
      () => (
        <PermissionModePicker
          mode="auto"
          activity={[]}
          showPicker={false}
          showLabel={true}
          onToggle={vi.fn()}
          onSelect={vi.fn()}
        />
      ),
      container!
    );

    expect(container?.querySelector('.permission-activity')).toBeNull();
  });

  it('explains full access when the permission picker is closed', async () => {
    vi.useFakeTimers();
    cleanup = render(
      () => (
        <PermissionModePicker
          mode="full"
          showPicker={false}
          onToggle={vi.fn()}
          onSelect={vi.fn()}
        />
      ),
      container!
    );

    const toggleButton = container?.querySelector<HTMLButtonElement>('.toolbar-picker.icon-only');

    expect(toggleButton?.getAttribute('aria-label')).toBe('Full access permissions');
    expect(container?.querySelector('.toolbar-popover')).toBeNull();

    toggleButton?.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(1500);

    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Full access: Allow commands and edits without prompts.'
    );
  });

  it('renders a labeled permission button when requested', () => {
    cleanup = render(
      () => (
        <PermissionModePicker
          mode="default"
          showPicker={false}
          showLabel={true}
          onToggle={vi.fn()}
          onSelect={vi.fn()}
        />
      ),
      container!
    );

    const toggleButton = container?.querySelector<HTMLButtonElement>('.permission-mode-button');

    expect(toggleButton?.className).not.toContain('icon-only');
    expect(toggleButton?.textContent).toContain('Default');
    expect(toggleButton?.textContent).not.toContain('Recovering');
    expect(toggleButton?.textContent).not.toContain('OpenCode config-based');
  });

  it('limits the permission popover to the input frame', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(600);
    let boundary: HTMLDivElement | undefined;
    cleanup = render(
      () => (
        <div
          ref={(el) => {
            boundary = el;
          }}
          class="chat-input-frame"
        >
          <PermissionModePicker
            boundaryRef={boundary}
            mode="default"
            showPicker={true}
            showLabel={true}
            onToggle={vi.fn()}
            onSelect={vi.fn()}
          />
        </div>
      ),
      container!
    );
    const popup = container?.querySelector<HTMLElement>('.permission-mode-popover');
    const parent = popup?.parentElement;
    vi.spyOn(popup!, 'offsetParent', 'get').mockReturnValue(parent ?? null);
    vi.spyOn(boundary!, 'getBoundingClientRect').mockReturnValue({
      ...boundary!.getBoundingClientRect(),
      left: 100,
      right: 350,
    });
    vi.spyOn(parent!, 'getBoundingClientRect').mockReturnValue({
      ...parent!.getBoundingClientRect(),
      left: 300,
      right: 340,
    });
    vi.spyOn(popup!, 'scrollWidth', 'get').mockReturnValue(320);
    window.dispatchEvent(new Event('resize'));
    await flushMicrotasks();

    expect(popup?.style.width).toBe('250px');
    expect(popup?.style.left).toBe('-200px');
  });

  it('aligns permissions to its trigger and centers it when space is limited', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(700);
    let boundary: HTMLDivElement | undefined;
    cleanup = render(
      () => (
        <div
          ref={(el) => {
            boundary = el;
          }}
        >
          <PermissionModePicker
            boundaryRef={boundary}
            alignToTriggerWhenPossible={true}
            mode="default"
            showPicker={true}
            showLabel={true}
            onToggle={vi.fn()}
            onSelect={vi.fn()}
          />
        </div>
      ),
      container!
    );
    const popup = container?.querySelector<HTMLElement>('.permission-mode-popover');
    const parent = popup?.parentElement;
    vi.spyOn(popup!, 'offsetParent', 'get').mockReturnValue(parent ?? null);
    const boundaryRect = vi.spyOn(boundary!, 'getBoundingClientRect').mockReturnValue({
      ...boundary!.getBoundingClientRect(),
      left: 100,
      right: 500,
    });
    vi.spyOn(parent!, 'getBoundingClientRect').mockReturnValue({
      ...parent!.getBoundingClientRect(),
      left: 300,
      right: 400,
    });
    vi.spyOn(popup!, 'scrollWidth', 'get').mockReturnValue(288);
    window.dispatchEvent(new Event('resize'));
    await flushMicrotasks();

    expect(popup?.style.width).toBe('288px');
    expect(popup?.style.left).toBe('-144px');

    boundaryRect.mockReturnValue({
      ...boundary!.getBoundingClientRect(),
      left: 100,
      right: 700,
    });
    window.dispatchEvent(new Event('resize'));
    await flushMicrotasks();

    expect(popup?.style.left).toBe('0px');
  });

  it('renders the agent picker state and forwards hover and selection', () => {
    const onToggle = vi.fn();
    const onSelect = vi.fn();
    const onFocusIndex = vi.fn();
    const agents = [
      createAgent({ name: 'planner', description: 'Plans work' }),
      createAgent({ name: 'reviewer', description: 'Reviews work' }),
    ];

    cleanup = render(
      () => (
        <AgentPicker
          agents={agents}
          selectedAgent="reviewer"
          selectedLabel="Reviewer"
          focusIndex={0}
          showPicker={true}
          getLabel={(agent) => agent.name.toUpperCase()}
          getDetail={(agent) => agent.description ?? 'No description'}
          onToggle={onToggle}
          onSelect={onSelect}
          onFocusIndex={onFocusIndex}
        />
      ),
      container!
    );

    const toggleButton = container?.querySelector<HTMLButtonElement>('.toolbar-picker');
    const options =
      container?.querySelectorAll<HTMLButtonElement>('.agent-popover .toolbar-popover-item') ?? [];

    expect(toggleButton?.getAttribute('aria-label')).toBe('Select agent');
    expect(toggleButton?.textContent).toContain('Reviewer');
    expect(toggleButton?.classList.contains('plan-agent-selected')).toBe(false);
    expect(options).toHaveLength(2);
    expect(options[0]?.className).toContain('keyboard-focus');
    expect(options[1]?.className).toContain('selected');
    expect(options[0]?.textContent).toContain('PLANNER');
    expect(options[1]?.textContent).toContain('Reviews work');
    expect(options[1]?.querySelector('.text-vscode-muted')?.className).toContain('font-normal');

    toggleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    options[0]?.dispatchEvent(new MouseEvent('mouseenter'));
    options[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onToggle).toHaveBeenCalledOnce();
    expect(onFocusIndex).toHaveBeenCalledWith(0);
    expect(onSelect).toHaveBeenCalledWith(agents[0]);
  });

  it('marks the agent picker trigger when Plan is selected', () => {
    cleanup = render(
      () => (
        <AgentPicker
          agents={[createAgent({ name: 'plan' })]}
          selectedAgent="plan"
          selectedLabel="Plan"
          focusIndex={0}
          showPicker={false}
          getLabel={(agent) => agent.name}
          getDetail={(agent) => agent.description ?? 'No description'}
          onToggle={vi.fn()}
          onSelect={vi.fn()}
          onFocusIndex={vi.fn()}
        />
      ),
      container!
    );

    const toggleButton = container?.querySelector<HTMLButtonElement>('.toolbar-picker');

    expect(toggleButton?.classList.contains('plan-agent-selected')).toBe(true);
  });

  it('uses built-in agent icons in options and compact values', () => {
    const agents = [
      createAgent({ name: 'build', mode: 'primary' }),
      createAgent({ name: 'ask', mode: 'primary', builtIn: false }),
      createAgent({ name: 'plan', mode: 'primary' }),
      createAgent({ name: 'reviewer', mode: 'primary', builtIn: false }),
    ];

    cleanup = render(
      () => (
        <AgentPicker
          agents={agents}
          selectedAgent="ask"
          selectedLabel="A"
          compact={true}
          focusIndex={0}
          showPicker={true}
          getLabel={(agent) => agent.name}
          getDetail={(agent) => agent.description ?? 'No description'}
          onToggle={vi.fn()}
          onSelect={vi.fn()}
          onFocusIndex={vi.fn()}
        />
      ),
      container!
    );

    const toggleButton = container?.querySelector<HTMLButtonElement>('.toolbar-picker');
    const options = container?.querySelectorAll('.agent-popover .toolbar-popover-item') ?? [];

    expect(toggleButton?.querySelector('.agent-picker-value-icon')).not.toBeNull();
    expect(toggleButton?.querySelector('.toolbar-picker-label')).toBeNull();
    expect(options[0]?.querySelector('.agent-picker-option-icon')).not.toBeNull();
    expect(options[1]?.querySelector('.agent-picker-option-icon')).not.toBeNull();
    expect(options[2]?.querySelector('.agent-picker-option-icon')).not.toBeNull();
    expect(options[3]?.querySelector('.agent-picker-option-icon')).toBeNull();
    expect(
      options[0]
        ?.querySelector('.agent-picker-option-label')
        ?.lastElementChild?.classList.contains('agent-picker-option-icon')
    ).toBe(true);
  });

  it('keeps built-in agent icons out of full-size values', () => {
    cleanup = render(
      () => (
        <AgentPicker
          agents={[createAgent({ name: 'build', mode: 'primary' })]}
          selectedAgent="build"
          selectedLabel="Build"
          compact={false}
          focusIndex={0}
          showPicker={false}
          getLabel={(agent) => agent.name}
          getDetail={(agent) => agent.description ?? 'No description'}
          onToggle={vi.fn()}
          onSelect={vi.fn()}
          onFocusIndex={vi.fn()}
        />
      ),
      container!
    );

    const toggleButton = container?.querySelector<HTMLButtonElement>('.toolbar-picker');
    expect(toggleButton?.querySelector('.agent-picker-value-icon')).toBeNull();
    expect(toggleButton?.querySelector('.toolbar-picker-label')?.textContent).toBe('Build');
  });

  it('keeps a custom agent initial in compact values', () => {
    cleanup = render(
      () => (
        <AgentPicker
          agents={[createAgent({ name: 'reviewer', mode: 'primary', builtIn: false })]}
          selectedAgent="reviewer"
          selectedLabel="R"
          compact={true}
          focusIndex={0}
          showPicker={false}
          getLabel={(agent) => agent.name}
          getDetail={(agent) => agent.description ?? 'No description'}
          onToggle={vi.fn()}
          onSelect={vi.fn()}
          onFocusIndex={vi.fn()}
        />
      ),
      container!
    );

    const toggleButton = container?.querySelector<HTMLButtonElement>('.toolbar-picker');
    expect(toggleButton?.querySelector('.agent-picker-value-icon')).toBeNull();
    expect(toggleButton?.querySelector('.toolbar-picker-label')?.textContent).toBe('R');
  });

  it('shows the selected agent description below its name in the tooltip', async () => {
    vi.useFakeTimers();
    cleanup = render(
      () => (
        <AgentPicker
          agents={[createAgent({ name: 'reviewer', description: 'Reviews work' })]}
          selectedAgent="reviewer"
          selectedLabel="Reviewer"
          focusIndex={0}
          showPicker={false}
          getLabel={(agent) => agent.name}
          getDetail={(agent) => agent.description ?? 'No description'}
          onToggle={vi.fn()}
          onSelect={vi.fn()}
          onFocusIndex={vi.fn()}
        />
      ),
      container!
    );

    const toggleButton = container?.querySelector<HTMLButtonElement>('.toolbar-picker');
    toggleButton?.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(1500);

    const tooltip = document.querySelector('[role="tooltip"]');
    expect(tooltip?.querySelector('.agent-picker-tooltip-title')?.textContent).toBe('Reviewer');
    expect(tooltip?.querySelector('.agent-picker-tooltip-detail')?.textContent).toBe(
      'Reviews work'
    );
  });

  it('shows model-style agent details when hovering a truncated description', () => {
    const description =
      'Investigates the codebase and provides a detailed review without changing files';
    cleanup = render(
      () => (
        <AgentPicker
          agents={[createAgent({ name: 'reviewer', description })]}
          selectedAgent="reviewer"
          selectedLabel="Reviewer"
          focusIndex={0}
          showPicker={true}
          getLabel={(agent) => agent.name}
          getDetail={(agent) => agent.description ?? 'No description'}
          onToggle={vi.fn()}
          onSelect={vi.fn()}
          onFocusIndex={vi.fn()}
        />
      ),
      container!
    );

    const option = container?.querySelector<HTMLButtonElement>(
      '.agent-popover .toolbar-popover-item'
    );
    const detail = option?.querySelector<HTMLElement>('.text-vscode-muted');
    Object.defineProperties(detail!, {
      clientWidth: { configurable: true, value: 120 },
      scrollWidth: { configurable: true, value: 300 },
    });
    option?.dispatchEvent(new MouseEvent('mouseenter'));

    const details = document.querySelector('.agent-picker-details');
    expect(details?.querySelector('.agent-picker-details-description')?.textContent).toBe(
      description
    );
    expect(details?.querySelector('dl')).toBeNull();

    option?.dispatchEvent(new MouseEvent('mouseleave'));
    expect(document.querySelector('.agent-picker-details')).toBeNull();
  });

  it('does not show agent details when its description fits', () => {
    cleanup = render(
      () => (
        <AgentPicker
          agents={[createAgent({ name: 'reviewer', description: 'Reviews work' })]}
          selectedAgent="reviewer"
          selectedLabel="Reviewer"
          focusIndex={0}
          showPicker={true}
          getLabel={(agent) => agent.name}
          getDetail={(agent) => agent.description ?? 'No description'}
          onToggle={vi.fn()}
          onSelect={vi.fn()}
          onFocusIndex={vi.fn()}
        />
      ),
      container!
    );

    const option = container?.querySelector<HTMLButtonElement>(
      '.agent-popover .toolbar-popover-item'
    );
    const detail = option?.querySelector<HTMLElement>('.text-vscode-muted');
    Object.defineProperties(detail!, {
      clientWidth: { configurable: true, value: 120 },
      scrollWidth: { configurable: true, value: 120 },
    });
    option?.dispatchEvent(new MouseEvent('mouseenter'));

    expect(document.querySelector('.agent-picker-details')).toBeNull();
  });

  it('limits the agent popover to the input host', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(600);
    cleanup = render(
      () => (
        <div class="chat-input-container">
          <AgentPicker
            agents={[createAgent()]}
            selectedAgent="planner"
            selectedLabel="Planner"
            focusIndex={0}
            showPicker={true}
            getLabel={(agent) => agent.name}
            getDetail={(agent) => agent.description ?? 'No description'}
            onToggle={vi.fn()}
            onSelect={vi.fn()}
            onFocusIndex={vi.fn()}
          />
        </div>
      ),
      container!
    );
    const boundary = container?.querySelector<HTMLElement>('.chat-input-container');
    const popup = container?.querySelector<HTMLElement>('.agent-popover');
    const trigger = container?.querySelector<HTMLElement>('.toolbar-picker');
    const parent = popup?.parentElement;
    vi.spyOn(popup!, 'offsetParent', 'get').mockReturnValue(parent ?? null);
    vi.spyOn(boundary!, 'getBoundingClientRect').mockReturnValue({
      ...boundary!.getBoundingClientRect(),
      left: 100,
      right: 350,
    });
    vi.spyOn(parent!, 'getBoundingClientRect').mockReturnValue({
      ...parent!.getBoundingClientRect(),
      left: 300,
      right: 340,
    });
    vi.spyOn(trigger!, 'getBoundingClientRect').mockReturnValue({
      ...trigger!.getBoundingClientRect(),
      left: 300,
      right: 340,
    });
    vi.spyOn(popup!, 'scrollWidth', 'get').mockReturnValue(288);
    window.dispatchEvent(new Event('resize'));
    await flushMicrotasks();

    expect(popup?.style.width).toBe('250px');
    expect(popup?.style.left).toBe('-200px');
  });

  it('shows and selects the default reasoning option', async () => {
    const onToggle = vi.fn();
    const onSelect = vi.fn();
    const [showPicker, setShowPicker] = createSignal(false);

    cleanup = render(
      () => (
        <VariantPicker
          variants={['low', 'high']}
          selectedVariant="high"
          selectedLabel="High"
          showPicker={showPicker()}
          getLabel={(variant) => variant.toUpperCase()}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ),
      container!
    );

    const toggleButton = container?.querySelector<HTMLButtonElement>('.toolbar-picker');
    expect(toggleButton?.getAttribute('aria-label')).toBe('Thinking level');
    expect(toggleButton?.classList.contains('maximum-reasoning-selected')).toBe(false);
    expect(container?.querySelector('.toolbar-popover')).toBeNull();

    toggleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onToggle).toHaveBeenCalledOnce();

    setShowPicker(true);
    await flushMicrotasks();

    const options = container?.querySelectorAll<HTMLButtonElement>('.toolbar-popover-item') ?? [];
    expect(options).toHaveLength(3);
    expect(options[0]?.textContent).toContain('Default');
    expect(options[2]?.className).toContain('selected');

    options[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it.each(['max', 'Ultra'])('warns when %s reasoning is selected', async (variant) => {
    vi.useFakeTimers();
    cleanup = render(
      () => (
        <VariantPicker
          variants={['low', variant]}
          selectedVariant={variant}
          selectedLabel={variant}
          showPicker={false}
          getLabel={(value) => value.toUpperCase()}
          onToggle={vi.fn()}
          onSelect={vi.fn()}
        />
      ),
      container!
    );

    const toggleButton = container?.querySelector<HTMLButtonElement>('.toolbar-picker');

    expect(toggleButton?.classList.contains('maximum-reasoning-selected')).toBe(true);

    toggleButton?.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(1500);

    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Maximum reasoning may be more expensive.'
    );
  });

  it('right-aligns the variant picker popover when a boundary is provided', async () => {
    const boundary = document.createElement('div');
    document.body.appendChild(boundary);
    const [showPicker, setShowPicker] = createSignal(false);

    cleanup = render(
      () => (
        <VariantPicker
          boundaryRef={boundary}
          alignTo="right"
          variants={['low', 'high']}
          selectedVariant="high"
          selectedLabel="High"
          showPicker={showPicker()}
          getLabel={(variant) => variant.toUpperCase()}
          onToggle={vi.fn()}
          onSelect={vi.fn()}
        />
      ),
      container!
    );

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const wrapper = container?.querySelector('.toolbar-picker')
      ?.parentElement as HTMLDivElement | null;

    vi.spyOn(boundary, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 200,
      bottom: 24,
      width: 200,
      height: 24,
      toJSON: () => ({}),
    });
    vi.spyOn(wrapper!, 'getBoundingClientRect').mockReturnValue({
      x: 140,
      y: 0,
      top: 0,
      left: 140,
      right: 200,
      bottom: 24,
      width: 60,
      height: 24,
      toJSON: () => ({}),
    });

    setShowPicker(true);
    await flushMicrotasks();

    const popover = container?.querySelector<HTMLElement>('.toolbar-popover');

    expect(popover?.style.left).toBe('auto');
    expect(popover?.style.right).toBe('0px');

    boundary.remove();
  });

  it('renders the model picker fallback when no model is selected', () => {
    const onToggle = vi.fn();

    cleanup = render(
      () => (
        <ModelPickerButton
          providerID={null}
          providerName="OpenAI"
          modelName=""
          canEllipsize={false}
          onToggle={onToggle}
        />
      ),
      container!
    );

    const button = container?.querySelector<HTMLButtonElement>('.model-picker-btn');

    expect(button?.getAttribute('aria-label')).toBe('Choose model');
    expect(button?.getAttribute('title')).toBeNull();
    expect(button?.className).not.toContain('model-ellipsis');
    expect(button?.textContent).toContain('Model');
    expect(container?.querySelector('.provider-icon')).toBeNull();

    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('renders the model picker icon and full title when a model is selected', () => {
    cleanup = render(
      () => (
        <ModelPickerButton
          providerID="openai"
          modelID="gpt-4.1"
          providerName="OpenAI"
          modelName="gpt-4.1"
          canEllipsize={true}
          onToggle={vi.fn()}
        />
      ),
      container!
    );

    const button = container?.querySelector<HTMLButtonElement>('.model-picker-btn');
    const providerIcon = container?.querySelector<HTMLElement>('.provider-icon');
    const modelName = container?.querySelector('.model-name-text');

    expect(button?.getAttribute('aria-label')).toBe('OpenAI / gpt-4.1');
    expect(button?.dataset.providerId).toBe('openai');
    expect(button?.dataset.modelId).toBe('gpt-4.1');
    expect(button?.className).toContain('model-ellipsis');
    expect(button?.className).not.toContain('fast-model-selected');
    expect(modelName?.textContent).toBe('gpt-4.1');
    expect(providerIcon).toBeInstanceOf(HTMLElement);
    expect(providerIcon?.style.getPropertyValue('--provider-icon-mask')).toContain('url(');
  });

  it('renders Claude Fast models with a lightning symbol and cost warning', async () => {
    vi.useFakeTimers();
    cleanup = render(
      () => (
        <ModelPickerButton
          providerID="anthropic"
          providerName="Anthropic"
          modelName="Claude Opus 5 Fast"
          canEllipsize={false}
          onToggle={vi.fn()}
        />
      ),
      container!
    );

    const button = container?.querySelector<HTMLButtonElement>('.model-picker-btn');
    expect(button?.getAttribute('aria-label')).toBe('Anthropic / Claude Opus 5 Fast');
    expect(button?.className).toContain('fast-model-selected');
    expect(container?.querySelector('.model-name-text')?.textContent).toBe('Claude Opus 5 ⚡');

    button?.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(1_500);

    const tooltip = document.querySelector('[role="tooltip"]');
    expect(tooltip?.querySelector('.model-picker-tooltip > span')?.textContent).toBe(
      'Anthropic / Claude Opus 5 Fast'
    );
    expect(tooltip?.querySelector('.model-picker-tooltip-detail')?.textContent).toBe(
      'Fast mode may consume usage limits faster and cost more.'
    );
  });

  it('omits the provider limit chip when no label is available', () => {
    cleanup = render(
      () => <ProviderLimitChip badges={[]} title={null} onClick={vi.fn()} />,
      container!
    );

    expect(container?.querySelector('button')).toBeNull();
  });

  it('renders the provider limit chip interactions and cycle guard paths', () => {
    const onClick = vi.fn();

    cleanup = render(
      () => (
        <div>
          <ProviderLimitChip
            badges={[
              { label: '0%', tone: 'error' },
              { label: '12%', tone: 'warning' },
            ]}
            title="Daily requests remaining"
            onClick={onClick}
          />
          <ProviderLimitChip
            badges={[{ label: '40%', tone: 'default' }]}
            title={null}
            ariaLabel={null}
            onClick={vi.fn()}
          />
        </div>
      ),
      container!
    );

    const buttons = container?.querySelectorAll<HTMLButtonElement>('.toolbar-limit-chip') ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.getAttribute('aria-label')).toBe('Daily requests remaining');
    expect(buttons[0]?.textContent).toContain('Limits:');
    expect(buttons[0]?.textContent).toContain('0%');
    expect(buttons[0]?.textContent).toContain('12%');
    expect(buttons[0]?.textContent).toContain('·');
    expect(buttons[1]?.getAttribute('aria-label')).toBe('Provider limits');
    expect(buttons[1]?.textContent).toContain('40%');
    expect(buttons[0]?.querySelector('.toolbar-limit-chip-badge.error')).toBeInstanceOf(
      HTMLElement
    );
    expect(buttons[0]?.querySelector('.toolbar-limit-chip-badge.warning')).toBeInstanceOf(
      HTMLElement
    );

    buttons[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onClick).toHaveBeenCalledOnce();
  });

  it('handles provider limit clicks before bubbling can be interrupted', () => {
    const onClick = vi.fn();

    cleanup = render(
      () => (
        <div
          ref={(element) => element.addEventListener('click', (event) => event.stopPropagation())}
        >
          <ProviderLimitChip
            badges={[{ label: '40%', tone: 'default' }]}
            title="Daily requests remaining"
            onClick={onClick}
          />
        </div>
      ),
      container!
    );

    container
      ?.querySelector<HTMLButtonElement>('.toolbar-limit-chip')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onClick).toHaveBeenCalledOnce();
  });
});
