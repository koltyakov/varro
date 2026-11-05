/* oxlint-disable anti-slop/no-module-mocking -- VS Code status-bar items require a host API fake in unit tests. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseModelPreferences } from '../shared/model-preferences';
import type { ProviderLimitStatus, ServerStatus } from '../shared/protocol';
import { ProviderLimitStatusBar } from './provider-limit-status-bar';

const mocks = vi.hoisted(() => {
  const item = { name: '', text: '', tooltip: '', show: vi.fn(), hide: vi.fn(), dispose: vi.fn() };
  return { item, createStatusBarItem: vi.fn(() => item) };
});

vi.mock('vscode', () => ({
  window: { createStatusBarItem: mocks.createStatusBarItem },
  StatusBarAlignment: { Right: 2 },
}));

function limit(
  providerID: string,
  percent = 50
): Extract<ProviderLimitStatus, { status: 'available' }> {
  return {
    providerID,
    modelID: null,
    status: 'available',
    source: 'provider',
    checkedAt: 1,
    windows: [
      {
        id: 'five_hour',
        label: '5-hour',
        unit: 'messages',
        remaining: 50,
        limit: 100,
        resetAt: null,
        percent,
      },
      {
        id: 'weekly',
        label: 'Weekly',
        unit: 'messages',
        remaining: 78,
        limit: 100,
        resetAt: null,
        percent: 22,
      },
    ],
  };
}

const bars: ProviderLimitStatusBar[] = [];

function setup(providerLimitPins: Record<string, string> = { anthropic: '', openai: 'Work' }) {
  const preferences = parseModelPreferences({ providerLimitPins });
  let status: ServerStatus = { state: 'running', url: 'http://localhost:4096' };
  const request = vi.fn(async () => ({
    providers: [
      { id: 'anthropic', name: 'Anthropic', models: { claude: {} } },
      { id: 'openai', name: 'OpenAI', models: { gpt: {} } },
      { id: 'google', name: 'Google', models: { gemini: {} } },
      { id: 'claude-agent', name: 'Claude Agent', models: { claude: {} } },
    ],
  }));
  const get = vi.fn(async (providerID: string): Promise<ProviderLimitStatus> => limit(providerID));
  const bar = new ProviderLimitStatusBar(
    {
      request,
      get status() {
        return status;
      },
    },
    { get },
    () => preferences
  );
  bars.push(bar);
  return {
    bar,
    preferences,
    request,
    get,
    setStatus(next: ServerStatus) {
      status = next;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.item.text = '';
  mocks.item.tooltip = '';
});

afterEach(() => {
  for (const bar of bars.splice(0)) bar.dispose();
  vi.useRealTimers();
});

describe('pinned provider limit status bar', () => {
  it('renders pinned providers before OpenCode in provider-list order, not pin order', async () => {
    const { bar, get } = setup();
    bar.updateConnection('/repo');
    await vi.waitFor(() =>
      expect(mocks.item.text).toBe('Work: 5h 50%, w 78% · Anthropic: 5h 50%, w 78%')
    );
    expect(mocks.createStatusBarItem).toHaveBeenCalledWith('varro.provider-limits', 2, 1001);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledWith('openai', null, '/repo');
    expect(get).not.toHaveBeenCalledWith('google', expect.anything(), expect.anything());
    expect(mocks.item.tooltip).toContain('Percentages show remaining quota');
  });

  it('follows custom provider order and puts hidden providers last without sorting by alias', async () => {
    const { bar, preferences } = setup();
    preferences.providerOrder = ['anthropic', 'openai'];
    bar.updateConnection('/repo');
    await vi.waitFor(() => expect(mocks.item.text).toMatch(/^Anthropic:/));
    preferences.hiddenProviders = ['anthropic'];
    bar.preferencesChanged();
    expect(mocks.item.text).toMatch(/^Work:/);
    preferences.hiddenProviders = [];
    preferences.hiddenModels = ['anthropic:claude'];
    bar.preferencesChanged();
    expect(mocks.item.text).toMatch(/^Work:/);
  });

  it('refreshes while no webview is open and ignores repeated connection updates', async () => {
    const { bar, request, get } = setup({ openai: '' });
    bar.updateConnection('/repo');
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    bar.updateConnection('/repo');
    expect(request).toHaveBeenCalledTimes(1);
    bar.preferencesChanged();
    expect(request).toHaveBeenCalledTimes(1);
    get.mockResolvedValue(limit('openai', 90));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(get).toHaveBeenCalledTimes(2);
    expect(mocks.item.text).toBe('OpenAI: 5h 10%, w 78%');
  });

  it('does not poll without pins and stops polling after unpinning', async () => {
    const { bar, preferences, request, get } = setup({});
    bar.updateConnection('/repo');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(request).not.toHaveBeenCalled();
    preferences.providerLimitPins = { openai: '' };
    bar.preferencesChanged();
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    preferences.providerLimitPins = {};
    bar.preferencesChanged();
    expect(mocks.item.hide).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(240_000);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('uses workspace-matching provider-wide live updates only', async () => {
    const { bar } = setup({ openai: '' });
    bar.updateConnection('/repo');
    await vi.waitFor(() => expect(mocks.item.text).toBe('OpenAI: 5h 50%, w 78%'));
    bar.acceptUpdate({ directory: '/other', status: limit('openai', 99) });
    bar.acceptUpdate({ directory: '/repo', status: { ...limit('openai', 99), modelID: 'gpt' } });
    expect(mocks.item.text).toContain('5h 50%');
    bar.acceptUpdate({ directory: '/repo', status: limit('openai', 80) });
    expect(mocks.item.text).toContain('5h 20%');
  });

  it('ignores late polls after stopping or disposing and resumes on reconnect', async () => {
    const { bar, setStatus, get } = setup({ openai: '' });
    let resolve: (status: ProviderLimitStatus) => void = () => {};
    get.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      })
    );
    bar.updateConnection('/repo');
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    setStatus({ state: 'stopped' });
    bar.updateConnection('/repo');
    mocks.item.show.mockClear();
    resolve(limit('openai'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.item.show).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(1);
    setStatus({ state: 'running', url: 'http://localhost:4096' });
    bar.updateConnection('/repo');
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    bar.dispose();
    mocks.item.show.mockClear();
    bar.acceptUpdate({ directory: '/repo', status: limit('openai', 99) });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.item.show).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it.each(['error', 'unsupported'] as const)(
    'hides %s quotas without dropping the pin',
    async (status) => {
      const { bar, get } = setup({ openai: '' });
      get.mockResolvedValue({
        providerID: 'openai',
        status,
        source: 'provider',
        checkedAt: 1,
        note: 'Quota request failed',
      });
      bar.updateConnection('/repo');
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
      expect(mocks.item.text).toBe('');
      expect(mocks.item.show).not.toHaveBeenCalled();
      expect(mocks.item.hide).toHaveBeenCalled();
      get.mockResolvedValue(limit('openai'));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(mocks.item.text).toBe('OpenAI: 5h 50%, w 78%');
    }
  );

  it('omits unavailable and empty providers between visible pins without extra separators', async () => {
    const { bar, get } = setup({ openai: '', anthropic: '', google: '', 'claude-agent': '' });
    get.mockImplementation(async (providerID) =>
      providerID === 'anthropic'
        ? { providerID, status: 'unsupported', source: 'provider', checkedAt: 1, note: 'No quotas' }
        : providerID === 'claude-agent'
          ? { ...limit(providerID), windows: [] }
          : limit(providerID)
    );
    bar.updateConnection('/repo');
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(4));
    expect(mocks.item.text).toBe('OpenAI: 5h 50%, w 78% · Google: 5h 50%, w 78%');
    bar.acceptUpdate({ directory: '/repo', status: { ...limit('openai'), windows: [] } });
    expect(mocks.item.text).toBe('Google: 5h 50%, w 78%');
  });

  it('keeps loading providers hidden until a quota poll completes', async () => {
    const { bar, get } = setup({ openai: '' });
    let resolve: (status: ProviderLimitStatus) => void = () => {};
    get.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      })
    );
    bar.updateConnection('/repo');
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    expect(mocks.item.text).toBe('');
    expect(mocks.item.show).not.toHaveBeenCalled();
    resolve(limit('openai'));
    await vi.waitFor(() => expect(mocks.item.text).toBe('OpenAI: 5h 50%, w 78%'));
  });

  it('polls pinned Claude Agent while idle and recovers without selecting or using a model', async () => {
    const { bar, get } = setup({ 'claude-agent': 'Claude' });
    get.mockResolvedValueOnce({
      providerID: 'claude-agent',
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1,
      note: 'Claude Code OAuth credentials are unavailable',
    });
    bar.updateConnection('/repo');
    await vi.waitFor(() => expect(get).toHaveBeenCalledWith('claude-agent', null, '/repo'));
    expect(mocks.item.text).toBe('');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenLastCalledWith('claude-agent', null, '/repo');
    expect(mocks.item.text).toBe('Claude: 5h 50%, w 78%');
  });

  it('hides disconnected pins and escapes status-bar icon syntax in aliases', async () => {
    const { bar } = setup({ missing: 'Missing', openai: '$(zap) Work' });
    bar.updateConnection('/repo');
    await vi.waitFor(() => expect(mocks.item.text).toBe('\\$(zap) Work: 5h 50%, w 78%'));
  });

  it('hides a failed initial catalog lookup and recovers on refresh', async () => {
    const { bar, request } = setup({ openai: 'Work' });
    request.mockRejectedValueOnce(new Error('Catalog unavailable'));
    bar.updateConnection('/repo');
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(mocks.item.text).toBe('');
    expect(mocks.item.show).not.toHaveBeenCalled();
    await bar.refresh();
    expect(mocks.item.text).toBe('Work: 5h 50%, w 78%');
    expect(mocks.item.tooltip).not.toContain('Catalog unavailable');
  });
});
