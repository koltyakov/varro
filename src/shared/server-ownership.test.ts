/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- SAFETY: These tests plant arbitrary malformed field values a lease file on disk could really contain. */
import { describe, expect, it } from 'vitest';
import type { ManagedServerOwnershipLease } from './server-ownership';
import { parseManagedServerOwnershipLease } from './server-ownership';

type LeaseOverrides = Partial<Record<keyof ManagedServerOwnershipLease | 'extra', unknown>>;

/**
 * Builds a lease-shaped payload. Fields stay deliberately untyped so each test
 * can plant the malformed values a lease file on disk could really contain.
 */
function createLease(overrides: LeaseOverrides = {}) {
  return {
    version: 1,
    pid: 4242,
    port: 4096,
    executable: '/usr/local/bin/opencode',
    birthIdentity: 'boot-1700000000',
    owner: 'varro',
    host: 'workstation',
    state: 'active',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('parseManagedServerOwnershipLease', () => {
  it('parses a minimal active lease', () => {
    expect(parseManagedServerOwnershipLease(createLease())).toEqual({
      version: 1,
      pid: 4242,
      port: 4096,
      executable: '/usr/local/bin/opencode',
      birthIdentity: 'boot-1700000000',
      owner: 'varro',
      host: 'workstation',
      state: 'active',
      createdAt: 1_700_000_000_000,
    });
  });

  it('parses a relinquished lease with an attached extension host identity', () => {
    expect(
      parseManagedServerOwnershipLease(
        createLease({
          state: 'relinquished',
          hostPid: 99,
          hostBirthIdentity: 'host-boot-1',
          configPath: '/tmp/varro-managed/opencode.json',
        })
      )
    ).toEqual({
      version: 1,
      pid: 4242,
      port: 4096,
      executable: '/usr/local/bin/opencode',
      birthIdentity: 'boot-1700000000',
      owner: 'varro',
      host: 'workstation',
      state: 'relinquished',
      createdAt: 1_700_000_000_000,
      hostPid: 99,
      hostBirthIdentity: 'host-boot-1',
      configPath: '/tmp/varro-managed/opencode.json',
    });
  });

  it('rejects values that are not lease records', () => {
    for (const value of [null, undefined, 42, 'lease', true, [], [createLease()]]) {
      expect(parseManagedServerOwnershipLease(value)).toBeNull();
    }
  });

  it('rejects any version other than 1', () => {
    for (const version of [0, 2, '1', undefined, null]) {
      expect(parseManagedServerOwnershipLease(createLease({ version }))).toBeNull();
    }
  });

  it('rejects process ids that cannot identify a live listener', () => {
    for (const pid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '4242', undefined]) {
      expect(parseManagedServerOwnershipLease(createLease({ pid }))).toBeNull();
    }
    expect(parseManagedServerOwnershipLease(createLease({ pid: 1 }))).not.toBeNull();
  });

  it('rejects ports outside the addressable range', () => {
    for (const port of [0, -1, 65_536, 1.5, Number.NaN, '4096', undefined]) {
      expect(parseManagedServerOwnershipLease(createLease({ port }))).toBeNull();
    }
    for (const port of [1, 65_535]) {
      expect(parseManagedServerOwnershipLease(createLease({ port }))).not.toBeNull();
    }
  });

  it('rejects blank or non-string identity fields', () => {
    for (const field of ['executable', 'birthIdentity', 'owner', 'host'] as const) {
      for (const value of ['', '   ', 7, null, undefined]) {
        expect(parseManagedServerOwnershipLease(createLease({ [field]: value }))).toBeNull();
      }
    }
  });

  it('rejects a half-populated extension host identity', () => {
    // A lease that names a host PID without the birth identity cannot prove the
    // host is the same process, so ownership must not be adopted from it.
    expect(parseManagedServerOwnershipLease(createLease({ hostPid: 99 }))).toBeNull();
    expect(
      parseManagedServerOwnershipLease(createLease({ hostBirthIdentity: 'host-boot-1' }))
    ).toBeNull();
  });

  it('rejects malformed extension host identities', () => {
    for (const hostPid of [0, -1, 1.5, '99', null]) {
      expect(
        parseManagedServerOwnershipLease(createLease({ hostPid, hostBirthIdentity: 'host-boot-1' }))
      ).toBeNull();
    }
    for (const hostBirthIdentity of ['', '   ', 7, null]) {
      expect(
        parseManagedServerOwnershipLease(createLease({ hostPid: 99, hostBirthIdentity }))
      ).toBeNull();
    }
  });

  it('treats an explicitly undefined host identity pair as absent', () => {
    const lease = parseManagedServerOwnershipLease(
      createLease({ hostPid: undefined, hostBirthIdentity: undefined })
    );
    expect(lease).not.toBeNull();
    expect(lease).not.toHaveProperty('hostPid');
    expect(lease).not.toHaveProperty('hostBirthIdentity');
  });

  it('rejects unknown lease states', () => {
    for (const state of ['ACTIVE', 'stale', '', undefined, null, 1]) {
      expect(parseManagedServerOwnershipLease(createLease({ state }))).toBeNull();
    }
  });

  it('rejects non-finite creation timestamps', () => {
    for (const createdAt of [Number.NaN, Number.POSITIVE_INFINITY, '100', undefined, null]) {
      expect(parseManagedServerOwnershipLease(createLease({ createdAt }))).toBeNull();
    }
    expect(parseManagedServerOwnershipLease(createLease({ createdAt: 0 }))).not.toBeNull();
  });

  it('rejects a non-string config path but drops an empty one', () => {
    expect(parseManagedServerOwnershipLease(createLease({ configPath: 7 }))).toBeNull();
    const lease = parseManagedServerOwnershipLease(createLease({ configPath: '' }));
    expect(lease).not.toBeNull();
    expect(lease).not.toHaveProperty('configPath');
  });

  it('projects only known fields so a forged lease cannot smuggle extras through', () => {
    // Parsed from JSON so `__proto__` arrives as a real own property, the way
    // it would from a lease file on disk rather than an object literal.
    const forged: unknown = JSON.parse(
      JSON.stringify({ ...createLease(), extra: 'ignored' }).replace(
        '{',
        '{"__proto__":{"polluted":true},'
      )
    );
    const parsed = parseManagedServerOwnershipLease(forged);
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed ?? {}).toSorted()).toEqual([
      'birthIdentity',
      'createdAt',
      'executable',
      'host',
      'owner',
      'pid',
      'port',
      'state',
      'version',
    ]);
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect({}).not.toHaveProperty('polluted');
  });
});
