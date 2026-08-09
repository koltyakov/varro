import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../types';
import {
  AgentPicker,
  ModelPickerButton,
  PermissionModePicker,
  ProviderLimitChip,
  VariantPicker,
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
  vi.restoreAllMocks();
});

describe('ToolbarPickers', () => {
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

    expect(toggleButton?.title).toBe('Default permissions');
    expect(toggleButton?.getAttribute('aria-label')).toBe('Default permissions');
    expect(buttonRef).toBe(toggleButton);
    expect(popoverRef).toBe(container?.querySelector('.toolbar-popover'));
    expect(options).toHaveLength(3);
    expect(options[0]?.className).toContain('selected');
    expect(options[1]?.className).not.toContain('selected');

    toggleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    options[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    popoverRef?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onToggle).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith('full');
    expect(parentClick).toHaveBeenCalledTimes(1);
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

    expect(toggleButton?.title).toBe('Auto-approve permissions');
    expect(toggleButton?.getAttribute('aria-label')).toBe('Auto-approve permissions');
  });

  it('shows the tail of auto-approve activity with per-dot details', () => {
    const onToggle = vi.fn();
    cleanup = render(
      () => (
        <PermissionModePicker
          mode="auto"
          activity={[
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
    expect(activity?.previousElementSibling).toBe(toggleButton);
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
    expect(toggleButton?.title).toBe('Auto-approve permissions - OpenAI / GPT-5.6');
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

  it('uses the full-access title when the permission picker is closed', () => {
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

    expect(toggleButton?.title).toBe('Full access permissions');
    expect(toggleButton?.getAttribute('aria-label')).toBe('Full access permissions');
    expect(container?.querySelector('.toolbar-popover')).toBeNull();
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

    expect(toggleButton?.title).toBe('Select agent');
    expect(toggleButton?.textContent).toContain('Reviewer');
    expect(options).toHaveLength(2);
    expect(options[0]?.className).toContain('keyboard-focus');
    expect(options[1]?.className).toContain('selected');
    expect(options[0]?.textContent).toContain('PLANNER');
    expect(options[1]?.textContent).toContain('Reviews work');

    toggleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    options[0]?.dispatchEvent(new MouseEvent('mouseenter'));
    options[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onToggle).toHaveBeenCalledOnce();
    expect(onFocusIndex).toHaveBeenCalledWith(0);
    expect(onSelect).toHaveBeenCalledWith(agents[0]);
  });

  it('shows and hides the variant picker popover and forwards selection', async () => {
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
    expect(toggleButton?.title).toBe('Thinking level');
    expect(container?.querySelector('.toolbar-popover')).toBeNull();

    toggleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onToggle).toHaveBeenCalledOnce();

    setShowPicker(true);
    await flushMicrotasks();

    const options = container?.querySelectorAll<HTMLButtonElement>('.toolbar-popover-item') ?? [];
    expect(options).toHaveLength(2);
    expect(options[1]?.className).toContain('selected');

    options[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onSelect).toHaveBeenCalledWith('low');
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

    const button = container?.querySelector<HTMLButtonElement>('.toolbar-picker');
    const wrapper = button?.parentElement as HTMLDivElement | null;

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

    expect(button?.title).toBe('Choose model');
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

    expect(button?.title).toBe('OpenAI / gpt-4.1');
    expect(button?.className).toContain('model-ellipsis');
    expect(modelName?.textContent).toBe('gpt-4.1');
    expect(providerIcon).toBeInstanceOf(HTMLElement);
    expect(providerIcon?.style.getPropertyValue('--provider-icon-mask')).toContain('url(');
  });

  it('renders GPT Fast models with a lightning symbol', () => {
    cleanup = render(
      () => (
        <ModelPickerButton
          providerID="openai"
          providerName="OpenAI"
          modelName="GPT-5.6 Fast"
          canEllipsize={false}
          onToggle={vi.fn()}
        />
      ),
      container!
    );

    const button = container?.querySelector<HTMLButtonElement>('.model-picker-btn');
    expect(button?.title).toBe('OpenAI / GPT-5.6 Fast');
    expect(container?.querySelector('.model-name-text')?.textContent).toBe('GPT-5.6 ⚡');
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
