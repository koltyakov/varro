/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- REST payloads are untrusted and validated against endpoint contracts before use. */
/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Endpoint assertions follow route-specific runtime validation. */
import * as vscode from 'vscode';
import { existsSync, realpathSync } from 'fs';
import { posix, win32 } from 'path';
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import type {
  OpenCodePermissionConfig,
  OpenCodePermissionConfigSource,
  OpenCodeServerMemoryPermission,
  OpenCodeServerMemoryPermissions,
  PermissionRule,
} from '../shared/opencode-types';
import { isScalarConfigPermission } from '../shared/permission-rules';
import type { OpenCodeModelRouting } from '../shared/protocol';
import { isSameWorkspacePath, normalizeWorkspaceIdentity } from '../shared/workspace-path';
import { logger } from './logger';
import { v1Action, v2Action } from './opencode-v2-projection';
import type { OpenCodeServer } from './server';
import { asRecord, parseModelRoute } from './sidebar-provider-utils';
import { getOpenCodeConfigPaths } from './open-code-process';
import type { RestProxyCallbacks } from './rest-proxy';

const openCodeConfigUpdateLocks = new Map<string, Promise<void>>();

export type OpenCodeConfigRequest =
  | { kind: 'get' }
  | {
      kind: 'update';
      target: 'small_model' | 'agent' | 'commit_message' | 'auto_approve';
      providerID: string;
      modelID: string;
      agentName?: string;
      unset: boolean;
    };

type OpenCodeConfigFile = {
  path: string;
  uri: vscode.Uri;
  raw: string;
  config: Record<string, unknown>;
};

type OpenCodeConfigSnapshot = {
  workspacePath: string;
  files: OpenCodeConfigFile[];
  config: Record<string, unknown>;
  target: OpenCodeConfigFile;
};

/** Reads and edits OpenCode config files and server-memory permission rules for the REST proxy. */
export class OpenCodeConfigService {
  constructor(
    private readonly callbacks: RestProxyCallbacks,
    private readonly requestServer: (
      ...args: Parameters<OpenCodeServer['request']>
    ) => ReturnType<OpenCodeServer['request']>,
    private readonly getCurrentWorkspacePath: () => string | undefined
  ) {}

  private getOpenCodeWorkspacePath() {
    const workspacePath = this.getCurrentWorkspacePath();
    if (!workspacePath) {
      throw new Error('Open a workspace folder before editing project OpenCode config');
    }
    return getOpenCodePathApi(workspacePath).resolve(workspacePath);
  }

  private async readOpenCodeConfigObject(): Promise<OpenCodeConfigSnapshot> {
    if (this.callbacks.server.isAttachOnly) {
      throw new Error(
        'File-based OpenCode configuration is not supported in attach-only mode. Edit model, provider, and project permission settings on the server host or inside the container. Session permissions remain available through the API.'
      );
    }
    const workspacePath = this.getOpenCodeWorkspacePath();
    const files: OpenCodeConfigFile[] = [];
    const pathApi = getOpenCodePathApi(workspacePath);
    const candidates = resolveOpenCodeProjectConfigPaths(
      workspacePath,
      (path) => (pathApi.basename(path) === '.git' ? existsSync(path) : true),
      this.callbacks.server.apiVersion
    );
    for (const path of candidates) {
      const uri = vscode.Uri.file(path);
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const raw = new TextDecoder().decode(bytes);
        files.push({ path, uri, raw, config: parseOpenCodeConfig(raw, path) });
      } catch (err) {
        if (
          err &&
          typeof err === 'object' &&
          'code' in err &&
          (err.code === 'FileNotFound' || err.code === 'ENOENT')
        ) {
          continue;
        }
        throw err;
      }
    }

    const config = files.reduce<Record<string, unknown>>(
      (merged, file) => mergeOpenCodeConfig(merged, file.config),
      {}
    );
    // V2 merges every .opencode config after every direct config. A local direct
    // write cannot override even an ancestor's .opencode settings.
    const targetDirectory =
      this.callbacks.server.apiVersion === 2 &&
      files.some((file) => pathApi.basename(pathApi.dirname(file.path)) === '.opencode')
        ? pathApi.join(workspacePath, '.opencode')
        : workspacePath;
    const localFiles = files.filter((file) => pathApi.dirname(file.path) === targetDirectory);
    const target = localFiles.at(-1) || {
      path: pathApi.join(targetDirectory, 'opencode.json'),
      uri: vscode.Uri.file(pathApi.join(targetDirectory, 'opencode.json')),
      raw: '{}\n',
      config: {} as Record<string, unknown>,
    };
    return { workspacePath, files, config, target };
  }

  private normalizeOpenCodeModelRouting(config: Record<string, unknown>): OpenCodeModelRouting {
    const smallModel = parseModelRoute(
      asRecord(asRecord(config.agents)?.title)?.model ?? config.small_model
    );
    const agentModels: Record<string, { providerID: string; modelID: string }> = {};
    const agents = { ...asRecord(config.agent), ...asRecord(config.agents) };

    for (const [name, value] of Object.entries(agents)) {
      const agentConfig = asRecord(value);
      const route = parseModelRoute(agentConfig?.model);
      if (route) {
        agentModels[name] = route;
      }
    }

    const extensionConfig = vscode.workspace.getConfiguration('varro');
    return {
      smallModel,
      agentModels,
      commitMessageModel: parseModelRoute(extensionConfig.get('commitMessage.model')),
      autoApproveModel: parseModelRoute(extensionConfig.get('chat.autoApproveModel')),
    };
  }

  async readOpenCodeModelRouting(): Promise<OpenCodeModelRouting> {
    if (this.callbacks.server.isAttachOnly) {
      const config = asRecord(await this.requestServer('GET', '/config'));
      if (!config) throw new Error('OpenCode returned an invalid server configuration');
      return this.normalizeOpenCodeModelRouting(config);
    }
    const { config, files } = await this.readOpenCodeConfigObject();
    const routing = this.normalizeOpenCodeModelRouting(config);
    const providerConfigPaths = await this.readOpenCodeProviderConfigPaths(files);
    if (Object.keys(providerConfigPaths).length > 0)
      routing.providerConfigPaths = providerConfigPaths;
    return routing;
  }

  private async readOpenCodeProviderConfigPaths(
    projectFiles: Array<{ path: string; config: Record<string, unknown> }>
  ) {
    const configuredPath = process.env.OPENCODE_CONFIG?.trim();
    const candidatePaths = [
      ...getOpenCodeConfigPaths(),
      ...(configuredPath ? [configuredPath] : []),
      ...projectFiles.map((file) => file.path),
    ].filter((path, index, paths) => paths.indexOf(path) === index);
    const projectConfigByPath = new Map(projectFiles.map((file) => [file.path, file.config]));
    const providerConfigPaths: Record<string, string[]> = {};

    for (const path of candidatePaths) {
      let config = projectConfigByPath.get(path);
      if (!config) {
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path));
          config = parseOpenCodeConfig(new TextDecoder().decode(bytes), path);
        } catch {
          continue;
        }
      }

      const providers = asRecord(config.providers) ?? asRecord(config.provider);
      if (!providers) continue;
      for (const providerID of Object.keys(providers)) {
        (providerConfigPaths[providerID] ??= []).push(path);
      }
    }

    return providerConfigPaths;
  }

  async updateModelRouting(
    request: Extract<OpenCodeConfigRequest, { kind: 'update' }>
  ): Promise<OpenCodeModelRouting> {
    if (request.target === 'commit_message' || request.target === 'auto_approve') {
      const key =
        request.target === 'commit_message' ? 'commitMessage.model' : 'chat.autoApproveModel';
      await vscode.workspace
        .getConfiguration('varro')
        .update(
          key,
          request.unset ? undefined : `${request.providerID}/${request.modelID}`,
          vscode.ConfigurationTarget.Global
        );
      return this.readOpenCodeModelRouting();
    }
    return this.updateOpenCodeModelRouting(request);
  }

  async disableOpenCodeProvider(providerID: string): Promise<void> {
    let snapshot = await this.readOpenCodeConfigObject();
    while (true) {
      const lockPath = getCanonicalOpenCodeConfigPath(snapshot.target.path);
      const result = await withOpenCodeConfigUpdateLock(lockPath, async () => {
        const current = await this.readOpenCodeConfigObject();
        const { target } = current;
        if (getCanonicalOpenCodeConfigPath(target.path) !== lockPath) return current;
        if (
          vscode.workspace.textDocuments.some(
            (document) => document.isDirty && isSameWorkspacePath(document.uri.fsPath, target.path)
          )
        ) {
          throw new Error(
            `${target.path} has unsaved changes; save or revert before disabling a provider`
          );
        }
        const initialStat = await this.readConfigStat(target.uri);
        const experimental = asRecord(current.config.experimental);
        const policies = experimental?.policies;
        if (policies !== undefined && !Array.isArray(policies)) {
          throw new Error('Invalid OpenCode provider policies');
        }
        const nextPolicies = [
          ...(policies ?? []).filter((value: unknown) => {
            const policy = asRecord(value);
            return policy?.action !== 'provider.use' || policy.resource !== providerID;
          }),
          { action: 'provider.use', resource: providerID, effect: 'deny' },
        ];
        const raw = applyJsoncChange(
          target.raw.trim() ? target.raw : '{}\n',
          ['experimental', 'policies'],
          nextPolicies
        );
        if (!this.areConfigStatsEqual(initialStat, await this.readConfigStat(target.uri))) {
          throw new Error(`${target.path} changed while disabling the provider; please retry`);
        }
        if (!initialStat)
          await vscode.workspace.fs.createDirectory(
            vscode.Uri.file(getOpenCodePathApi(target.path).dirname(target.path))
          );
        await vscode.workspace.fs.writeFile(target.uri, new TextEncoder().encode(raw));
        // Provider policies require a reload even when model routing is unchanged.
        await this.callbacks.refreshOpenCodeConfig?.(undefined, undefined, current.workspacePath);
        return undefined;
      });
      if (!result) return;
      snapshot = result;
    }
  }

  private async updateOpenCodeModelRouting(
    request: Extract<OpenCodeConfigRequest, { kind: 'update' }>
  ): Promise<OpenCodeModelRouting> {
    if (request.target !== 'small_model' && request.target !== 'agent') {
      throw new Error('Unsupported OpenCode model routing target');
    }
    let snapshot = await this.readOpenCodeConfigObject();
    while (true) {
      const candidate = this.selectOpenCodeModelRoutingTarget(request, snapshot);
      if (!candidate) return this.normalizeOpenCodeModelRouting(snapshot.config);
      const lockPath = getCanonicalOpenCodeConfigPath(candidate.path);
      const result = await withOpenCodeConfigUpdateLock(lockPath, async () => {
        const currentSnapshot = await this.readOpenCodeConfigObject();
        const target = this.selectOpenCodeModelRoutingTarget(request, currentSnapshot);
        if (!target) {
          return {
            kind: 'complete' as const,
            routing: this.normalizeOpenCodeModelRouting(currentSnapshot.config),
          };
        }
        if (getCanonicalOpenCodeConfigPath(target.path) !== lockPath) {
          return { kind: 'retry' as const, snapshot: currentSnapshot };
        }

        const { workspacePath, files, config } = currentSnapshot;
        const { uri } = target;
        const dirtyDocument = vscode.workspace.textDocuments.find(
          (document) =>
            document.isDirty &&
            (document.uri.toString() === uri.toString() ||
              isSameWorkspacePath(document.uri.fsPath, uri.fsPath))
        );
        if (dirtyDocument) {
          throw new Error(
            `Project ${target.path.endsWith('.jsonc') ? 'opencode.jsonc' : 'opencode.json'} has unsaved changes; save or revert the document before updating model routing`
          );
        }
        const initialStat = await this.readConfigStat(uri);
        let nextRaw = target.raw.trim() ? target.raw : '{}\n';
        if (
          !request.unset &&
          (typeof target.config.$schema !== 'string' || !target.config.$schema.trim())
        ) {
          nextRaw = applyJsoncChange(nextRaw, ['$schema'], 'https://opencode.ai/config.json');
        }

        const modelRef = `${request.providerID}/${request.modelID}`;
        const nativeAgent = asRecord(
          asRecord(target.config.agents)?.[
            request.target === 'small_model' ? 'title' : request.agentName || ''
          ]
        );
        const agentKey = (
          request.unset
            ? parseModelRoute(nativeAgent?.model) !== null
            : target.config.agents !== undefined ||
              (target.config.agent === undefined && config.agents !== undefined)
        )
          ? 'agents'
          : 'agent';
        const nativeTitle = request.target === 'small_model' && agentKey === 'agents';
        if (request.target === 'small_model' && !nativeTitle) {
          nextRaw = applyJsoncChange(
            nextRaw,
            ['small_model'],
            request.unset ? undefined : modelRef
          );
        } else {
          const agentName = nativeTitle ? 'title' : request.agentName;
          if (!agentName) {
            throw new Error('Agent name is required');
          }
          nextRaw = applyJsoncChange(
            nextRaw,
            [agentKey, agentName, 'model'],
            request.unset ? undefined : modelRef
          );
          if (request.unset) {
            let nextConfig = parseOpenCodeConfig(nextRaw, target.path);
            const agentConfig = asRecord(asRecord(nextConfig[agentKey])?.[agentName]);
            if (agentConfig && Object.keys(agentConfig).length === 0) {
              nextRaw = applyJsoncChange(nextRaw, [agentKey, agentName], undefined);
              nextConfig = parseOpenCodeConfig(nextRaw, target.path);
              const agents = asRecord(nextConfig[agentKey]);
              if (agents && Object.keys(agents).length === 0) {
                nextRaw = applyJsoncChange(nextRaw, [agentKey], undefined);
              }
            }
          }
        }

        const nextTargetConfig = parseOpenCodeConfig(nextRaw, target.path);
        const encoded = new TextEncoder().encode(nextRaw.endsWith('\n') ? nextRaw : `${nextRaw}\n`);
        const latestStat = await this.readConfigStat(uri);
        if (!this.areConfigStatsEqual(initialStat, latestStat)) {
          throw new Error(
            `Project ${target.path.endsWith('.jsonc') ? 'opencode.jsonc' : 'opencode.json'} changed while updating model routing; please retry`
          );
        }
        const previousRouting = this.normalizeOpenCodeModelRouting(config);
        if (!initialStat)
          await vscode.workspace.fs.createDirectory(
            vscode.Uri.file(getOpenCodePathApi(target.path).dirname(target.path))
          );
        await vscode.workspace.fs.writeFile(uri, encoded);
        let effectiveConfig = files.reduce<Record<string, unknown>>(
          (merged, file) =>
            mergeOpenCodeConfig(merged, file.path === target.path ? nextTargetConfig : file.config),
          {}
        );
        if (!files.some((file) => file.path === target.path)) {
          effectiveConfig = mergeOpenCodeConfig(effectiveConfig, nextTargetConfig);
        }
        const currentRouting = this.normalizeOpenCodeModelRouting(effectiveConfig);
        await this.callbacks.refreshOpenCodeConfig?.(
          previousRouting,
          currentRouting,
          workspacePath
        );
        return { kind: 'complete' as const, routing: currentRouting };
      });
      if (result.kind === 'complete') return result.routing;
      snapshot = result.snapshot;
    }
  }

  async updateOpenCodeProjectPermission(permission: string, patterns: string[]) {
    let snapshot = await this.readOpenCodeConfigObject();
    while (true) {
      const lockPath = getCanonicalOpenCodeConfigPath(snapshot.target.path);
      const result = await withOpenCodeConfigUpdateLock(lockPath, async () => {
        const currentSnapshot = await this.readOpenCodeConfigObject();
        const { target } = currentSnapshot;
        if (getCanonicalOpenCodeConfigPath(target.path) !== lockPath) {
          return { kind: 'retry' as const, snapshot: currentSnapshot };
        }

        const dirtyDocument = vscode.workspace.textDocuments.find(
          (document) =>
            document.isDirty &&
            (document.uri.toString() === target.uri.toString() ||
              isSameWorkspacePath(document.uri.fsPath, target.uri.fsPath))
        );
        if (dirtyDocument) {
          throw new Error(
            `Project ${target.path.endsWith('.jsonc') ? 'opencode.jsonc' : 'opencode.json'} has unsaved changes; save or revert the document before updating permissions`
          );
        }

        const initialStat = await this.readConfigStat(target.uri);
        let nextRaw = target.raw.trim() ? target.raw : '{}\n';
        if (typeof target.config.$schema !== 'string' || !target.config.$schema.trim()) {
          nextRaw = applyJsoncChange(nextRaw, ['$schema'], 'https://opencode.ai/config.json');
        }

        const targetPermissionConfig = target.config.permission;
        const effectivePermissionConfig = currentSnapshot.config.permission;
        const scalarConfigPermission = isScalarConfigPermission(permission);
        if (
          !Array.isArray(target.config.permissions) &&
          scalarConfigPermission &&
          patterns.some((pattern) => pattern !== '*')
        ) {
          throw new Error(
            `Project permission ${permission} only supports the wildcard pattern in OpenCode config`
          );
        }
        const fallbackAction = isPermissionAction(targetPermissionConfig)
          ? targetPermissionConfig
          : isPermissionAction(effectivePermissionConfig)
            ? effectivePermissionConfig
            : null;
        if (Array.isArray(target.config.permissions)) {
          nextRaw = applyJsoncChange(
            nextRaw,
            ['permissions'],
            [
              ...target.config.permissions,
              ...patterns.map((resource) => ({
                action: v2Action(permission),
                resource,
                effect: 'allow',
              })),
            ]
          );
        } else if (fallbackAction) {
          const permissionConfig: Record<string, unknown> = { '*': fallbackAction };
          permissionConfig[permission] = scalarConfigPermission
            ? 'allow'
            : Object.fromEntries(patterns.map((pattern) => [pattern, 'allow']));
          nextRaw = applyJsoncChange(nextRaw, ['permission'], permissionConfig);
        } else if (scalarConfigPermission) {
          nextRaw = applyJsoncChange(nextRaw, ['permission', permission], 'allow');
        } else {
          const targetPermission = asRecord(target.config.permission)?.[permission];
          const effectivePermission = asRecord(currentSnapshot.config.permission)?.[permission];
          const rules: Record<string, unknown> =
            typeof targetPermission === 'string'
              ? { '*': targetPermission }
              : asRecord(targetPermission)
                ? { ...asRecord(targetPermission) }
                : typeof effectivePermission === 'string'
                  ? { '*': effectivePermission }
                  : {};
          for (const pattern of patterns) rules[pattern] = 'allow';
          nextRaw = applyJsoncChange(nextRaw, ['permission', permission], rules);
        }

        const latestStat = await this.readConfigStat(target.uri);
        if (!this.areConfigStatsEqual(initialStat, latestStat)) {
          throw new Error(
            `Project ${target.path.endsWith('.jsonc') ? 'opencode.jsonc' : 'opencode.json'} changed while updating permissions; please retry`
          );
        }
        const encoded = new TextEncoder().encode(nextRaw.endsWith('\n') ? nextRaw : `${nextRaw}\n`);
        if (!initialStat)
          await vscode.workspace.fs.createDirectory(
            vscode.Uri.file(getOpenCodePathApi(target.path).dirname(target.path))
          );
        await vscode.workspace.fs.writeFile(target.uri, encoded);
        return { kind: 'complete' as const };
      });
      if (result.kind === 'complete') return;
      snapshot = result.snapshot;
    }
  }

  private normalizeOpenCodePermissionRules(value: unknown): PermissionRule[] {
    if (Array.isArray(value)) {
      return value.flatMap((item) => {
        const rule = asRecord(item);
        if (
          typeof rule?.action !== 'string' ||
          typeof rule.resource !== 'string' ||
          !isPermissionAction(rule.effect)
        )
          return [];
        return [{ permission: v1Action(rule.action), pattern: rule.resource, action: rule.effect }];
      });
    }
    if (isPermissionAction(value)) {
      return [{ permission: '*', pattern: '*', action: value }];
    }
    const permissions = asRecord(value);
    if (!permissions) return [];
    const rules: PermissionRule[] = [];
    for (const [permission, setting] of Object.entries(permissions)) {
      if (setting === 'allow' || setting === 'ask' || setting === 'deny') {
        rules.push({ permission, pattern: '*', action: setting });
        continue;
      }
      const patterns = asRecord(setting);
      if (!patterns) continue;
      for (const [pattern, action] of Object.entries(patterns)) {
        if (action === 'allow' || action === 'ask' || action === 'deny') {
          rules.push({ permission, pattern, action });
        }
      }
    }
    return rules;
  }

  normalizeSessionPermissionRules(value: unknown): PermissionRule[] {
    if (!Array.isArray(value)) return [];
    const rules: PermissionRule[] = [];
    for (const item of value) {
      const rule = asRecord(item);
      if (
        typeof rule?.permission !== 'string' ||
        typeof rule.pattern !== 'string' ||
        (rule.action !== 'allow' && rule.action !== 'ask' && rule.action !== 'deny')
      ) {
        continue;
      }
      rules.push({
        permission: rule.permission,
        pattern: rule.pattern,
        action: rule.action,
      });
    }
    return rules;
  }

  async readServerMemoryPermissions(
    sessionID?: string,
    directory?: string,
    removeID?: string
  ): Promise<OpenCodeServerMemoryPermissions> {
    const project = asRecord(
      await this.requestServer(
        'GET',
        sessionID ? `/session/${encodeURIComponent(sessionID)}` : '/project/current',
        undefined,
        { directory }
      )
    );
    const projectID =
      typeof (sessionID ? project?.projectID : project?.id) === 'string'
        ? sessionID
          ? project?.projectID
          : project?.id
        : '';
    if (typeof projectID !== 'string' || !projectID) throw new Error('Project is unavailable');
    const list = async (): Promise<OpenCodeServerMemoryPermissions> => {
      const legacyRules = [...this.callbacks.getServerMemoryPermissions(projectID)];
      try {
        const response = await this.requestServer(
          'GET',
          `/api/permission/saved?projectID=${encodeURIComponent(projectID)}`,
          undefined,
          { directory }
        );
        const record = asRecord(response);
        const values = Array.isArray(response) ? response : record?.data;
        if (!Array.isArray(values)) {
          return {
            supported: false,
            rules: [],
            reason: 'The OpenCode server returned an unsupported saved-permission response.',
          };
        }
        const savedRules = values.flatMap((value) => {
          const saved = asRecord(value);
          if (
            typeof saved?.id !== 'string' ||
            typeof saved.projectID !== 'string' ||
            typeof saved.action !== 'string' ||
            typeof saved.resource !== 'string'
          ) {
            return [];
          }
          return [
            {
              id: saved.id,
              projectID: saved.projectID,
              permission: saved.action,
              pattern: saved.resource,
            },
          ];
        });
        const observedScopes = new Set(
          legacyRules.map((rule) => `${rule.permission}\0${rule.pattern}`)
        );
        const observedSavedRules = savedRules.filter((rule) =>
          observedScopes.has(`${rule.permission}\0${rule.pattern}`)
        );
        const savedScopes = new Set(
          observedSavedRules.map((rule) => `${rule.permission}\0${rule.pattern}`)
        );
        return {
          supported: true,
          rules: [
            ...observedSavedRules,
            ...legacyRules.filter(
              (rule) => !savedScopes.has(`${rule.permission}\0${rule.pattern}`)
            ),
          ],
        };
      } catch (cause) {
        if (legacyRules.length > 0) return { supported: true, rules: legacyRules };
        return {
          supported: false,
          rules: [],
          reason:
            cause instanceof Error
              ? `Saved permissions are unavailable: ${cause.message}`
              : 'Saved permissions are unavailable on this OpenCode server.',
        };
      }
    };

    const current = await list();
    if (!removeID || !current.supported) return current;
    if (removeID.startsWith('legacy:')) {
      throw new Error('Restart OpenCode to clear this server-memory allowance');
    }
    const removedRule = current.rules.find(
      (rule) => rule.id === removeID && rule.projectID === projectID
    );
    if (!removedRule) {
      throw new Error('Saved permission not found for this project');
    }
    await this.requestServer(
      'DELETE',
      `/api/permission/saved/${encodeURIComponent(removeID)}`,
      undefined,
      { directory }
    );
    this.callbacks.forgetServerMemoryPermission(removedRule);
    return list();
  }

  async prepareLegacyServerMemoryRules(
    method: string,
    path: string,
    body: unknown,
    directory: string | null | undefined
  ): Promise<OpenCodeServerMemoryPermission[]> {
    if (method !== 'POST' || asRecord(body)?.reply !== 'always') return [];
    const match = new URL(path, 'http://localhost').pathname.match(
      /^\/permission\/([^/]+)\/reply$/
    );
    if (!match?.[1]) return [];

    try {
      const permissionID = decodeURIComponent(match[1]);
      const pending = await this.requestServer('GET', '/permission', undefined, {
        directory: directory ?? undefined,
      });
      if (!Array.isArray(pending)) return [];
      const request = pending
        .map((value) => asRecord(asRecord(value)?.info) ?? asRecord(value))
        .find((value) => {
          const id = value?.id ?? value?.permissionID ?? value?.requestID;
          return id === permissionID;
        });
      const sessionID = typeof request?.sessionID === 'string' ? request.sessionID : '';
      const permission =
        typeof request?.permission === 'string'
          ? request.permission.trim()
          : typeof request?.type === 'string'
            ? request.type.trim()
            : '';
      const patterns = Array.isArray(request?.always)
        ? request.always
            .filter((value): value is string => typeof value === 'string')
            .map((value) => value.trim())
            .filter(Boolean)
        : [];
      if (!sessionID || !permission || patterns.length === 0) return [];
      const session = asRecord(
        await this.requestServer('GET', `/session/${encodeURIComponent(sessionID)}`, undefined, {
          directory: directory ?? undefined,
        })
      );
      const projectID = typeof session?.projectID === 'string' ? session.projectID : '';
      if (!projectID) return [];
      return [...new Set(patterns)].map((pattern, index) => ({
        id: `legacy:${permissionID}:${index}`,
        projectID,
        permission,
        pattern,
        retractable: false,
      }));
    } catch (cause) {
      logger.warn(
        `Could not mirror server-memory permission: ${cause instanceof Error ? cause.message : String(cause)}`
      );
      return [];
    }
  }

  async readOpenCodePermissionConfig(): Promise<OpenCodePermissionConfig> {
    const snapshot = await this.readOpenCodeConfigObject();
    const targetPath = getCanonicalOpenCodeConfigPath(snapshot.target.path);
    const globalConfig = await this.readGlobalOpenCodePermissionConfig();
    const effectiveConfig = mergeOpenCodeConfig(globalConfig.config, snapshot.config);
    return {
      targetPath: snapshot.target.path,
      projectRules: this.normalizeOpenCodePermissionRules(
        snapshot.target.config.permissions ?? snapshot.target.config.permission
      ),
      inheritedSources: [
        ...globalConfig.sources,
        ...snapshot.files
          .filter((file) => getCanonicalOpenCodeConfigPath(file.path) !== targetPath)
          .map<OpenCodePermissionConfigSource>((file) => ({
            path: file.path,
            rules: this.normalizeOpenCodePermissionRules(
              file.config.permissions ?? file.config.permission
            ),
            scope: isSameWorkspacePath(
              getOpenCodePathApi(file.path).dirname(file.path),
              snapshot.workspacePath
            )
              ? 'project'
              : 'parent',
          })),
      ]
        .filter((source) => source.rules.length > 0)
        .toReversed(),
      effectiveRules: this.normalizeOpenCodePermissionRules(
        effectiveConfig.permissions ?? effectiveConfig.permission
      ),
    };
  }

  private async readGlobalOpenCodePermissionConfig(): Promise<{
    config: Record<string, unknown>;
    sources: OpenCodePermissionConfigSource[];
  }> {
    const configuredPath = process.env.OPENCODE_CONFIG?.trim();
    const paths = [...getOpenCodeConfigPaths(), ...(configuredPath ? [configuredPath] : [])].filter(
      (path, index, values) => values.indexOf(path) === index
    );
    let effectiveConfig: Record<string, unknown> = {};
    const sources: OpenCodePermissionConfigSource[] = [];
    for (const path of paths) {
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path));
        const config = parseOpenCodeConfig(new TextDecoder().decode(bytes), path);
        effectiveConfig = mergeOpenCodeConfig(effectiveConfig, config);
        sources.push({
          path,
          rules: this.normalizeOpenCodePermissionRules(config.permissions ?? config.permission),
          scope: 'global',
        });
      } catch {
        // Missing or unreadable optional global config files do not block project settings.
      }
    }
    return { config: effectiveConfig, sources };
  }

  async updateOpenCodePermissionConfig(rules: PermissionRule[]): Promise<OpenCodePermissionConfig> {
    let snapshot = await this.readOpenCodeConfigObject();
    while (true) {
      const lockPath = getCanonicalOpenCodeConfigPath(snapshot.target.path);
      const result = await withOpenCodeConfigUpdateLock(lockPath, async () => {
        const currentSnapshot = await this.readOpenCodeConfigObject();
        const { target } = currentSnapshot;
        if (getCanonicalOpenCodeConfigPath(target.path) !== lockPath) {
          return { kind: 'retry' as const, snapshot: currentSnapshot };
        }
        const dirtyDocument = vscode.workspace.textDocuments.find(
          (document) =>
            document.isDirty &&
            (document.uri.toString() === target.uri.toString() ||
              isSameWorkspacePath(document.uri.fsPath, target.uri.fsPath))
        );
        if (dirtyDocument) {
          throw new Error(
            `Project ${target.path.endsWith('.jsonc') ? 'opencode.jsonc' : 'opencode.json'} has unsaved changes; save or revert the document before updating permissions`
          );
        }

        const initialStat = await this.readConfigStat(target.uri);
        let nextRaw = target.raw.trim() ? target.raw : '{}\n';
        if (typeof target.config.$schema !== 'string' || !target.config.$schema.trim()) {
          nextRaw = applyJsoncChange(nextRaw, ['$schema'], 'https://opencode.ai/config.json');
        }
        const permissionConfig: Record<
          string,
          PermissionRule['action'] | Record<string, PermissionRule['action']>
        > = {};
        const native = Array.isArray(target.config.permissions);
        for (const rule of rules) {
          if (!native && isScalarConfigPermission(rule.permission)) {
            if (rule.pattern !== '*') {
              throw new Error(
                `Project permission ${rule.permission} only supports the wildcard pattern in OpenCode config`
              );
            }
            permissionConfig[rule.permission] = rule.action;
            continue;
          }
          const permissionRules = permissionConfig[rule.permission];
          const patterns =
            permissionRules && typeof permissionRules !== 'string' ? permissionRules : {};
          patterns[rule.pattern] = rule.action;
          permissionConfig[rule.permission] = patterns;
        }
        nextRaw = applyJsoncChange(
          nextRaw,
          [native ? 'permissions' : 'permission'],
          native
            ? rules.map((rule) => ({
                action: v2Action(rule.permission),
                resource: rule.pattern,
                effect: rule.action,
              }))
            : rules.length > 0
              ? permissionConfig
              : undefined
        );

        const latestStat = await this.readConfigStat(target.uri);
        if (!this.areConfigStatsEqual(initialStat, latestStat)) {
          throw new Error(
            `Project ${target.path.endsWith('.jsonc') ? 'opencode.jsonc' : 'opencode.json'} changed while updating permissions; please retry`
          );
        }
        const encoded = new TextEncoder().encode(nextRaw.endsWith('\n') ? nextRaw : `${nextRaw}\n`);
        if (!initialStat)
          await vscode.workspace.fs.createDirectory(
            vscode.Uri.file(getOpenCodePathApi(target.path).dirname(target.path))
          );
        await vscode.workspace.fs.writeFile(target.uri, encoded);
        return { kind: 'complete' as const };
      });
      if (result.kind === 'complete') return this.readOpenCodePermissionConfig();
      snapshot = result.snapshot;
    }
  }

  private selectOpenCodeModelRoutingTarget(
    request: Extract<OpenCodeConfigRequest, { kind: 'update' }>,
    snapshot: OpenCodeConfigSnapshot
  ): OpenCodeConfigFile | null {
    if (!request.unset) return snapshot.target;
    return (
      snapshot.files.toReversed().find((file) => {
        const route =
          request.target === 'small_model'
            ? parseModelRoute(
                asRecord(asRecord(file.config.agents)?.title)?.model ?? file.config.small_model
              )
            : parseModelRoute(
                asRecord(asRecord(file.config.agents)?.[request.agentName || ''])?.model ??
                  asRecord(asRecord(file.config.agent)?.[request.agentName || ''])?.model
              );
        return route?.providerID === request.providerID && route.modelID === request.modelID;
      }) ?? null
    );
  }

  private async readConfigStat(uri: vscode.Uri) {
    try {
      return await vscode.workspace.fs.stat(uri);
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err.code === 'FileNotFound' || err.code === 'ENOENT')
      ) {
        return null;
      }
      throw err;
    }
  }

  private areConfigStatsEqual(left: vscode.FileStat | null, right: vscode.FileStat | null) {
    if (left === null || right === null) {
      return left === right;
    }
    return left.mtime === right.mtime && left.size === right.size;
  }
}

export function resolveOpenCodeProjectConfigPaths(
  directory: string,
  pathExists: (path: string) => boolean = existsSync,
  apiVersion: 1 | 2 = 1
) {
  const files: string[] = [];
  const directories: string[] = [];
  const pathApi = getOpenCodePathApi(directory);
  let current = pathApi.resolve(directory);
  while (true) {
    directories.push(current);
    for (const name of ['opencode.jsonc', 'opencode.json']) {
      const candidate = pathApi.join(current, name);
      if (pathExists(candidate)) files.push(candidate);
    }
    if (apiVersion === 1 && pathExists(pathApi.join(current, '.git'))) break;
    const parent = pathApi.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const ordered = files.toReversed();
  if (apiVersion === 2) {
    for (const ancestor of directories.toReversed()) {
      for (const name of ['opencode.json', 'opencode.jsonc']) {
        const candidate = pathApi.join(ancestor, '.opencode', name);
        if (pathExists(candidate)) ordered.push(candidate);
      }
    }
  }
  return ordered;
}

function getOpenCodePathApi(path: string) {
  // VS Code can expose POSIX paths from remote workspaces even on Windows.
  return /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\') ? win32 : posix;
}

function getCanonicalOpenCodeConfigPath(path: string) {
  const pathApi = getOpenCodePathApi(path);
  let resolved = pathApi.resolve(path);
  try {
    resolved = realpathSync.native(resolved);
  } catch {
    try {
      resolved = pathApi.join(
        realpathSync.native(pathApi.dirname(resolved)),
        pathApi.basename(resolved)
      );
    } catch {
      // The target and its parent can both be absent before the first config write.
    }
  }
  return normalizeWorkspaceIdentity(resolved) ?? resolved;
}

async function withOpenCodeConfigUpdateLock<T>(
  path: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = openCodeConfigUpdateLocks.get(path);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  openCodeConfigUpdateLocks.set(path, current);
  if (previous) await previous;
  try {
    return await operation();
  } finally {
    release();
    if (openCodeConfigUpdateLocks.get(path) === current) openCodeConfigUpdateLocks.delete(path);
  }
}

function parseOpenCodeConfig(raw: string, path: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const errors: ParseError[] = [];
  const parsed = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(`Invalid OpenCode config at ${path}: ${printParseErrorCode(errors[0]!.error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`OpenCode config at ${path} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function isPermissionAction(value: unknown): value is PermissionRule['action'] {
  return value === 'allow' || value === 'ask' || value === 'deny';
}

function mergeOpenCodeConfig(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const current = asRecord(merged[key]);
    const incoming = asRecord(value);
    merged[key] = current && incoming ? mergeOpenCodeConfig(current, incoming) : value;
  }
  return merged;
}

function applyJsoncChange(raw: string, path: (string | number)[], value: unknown) {
  return applyEdits(
    raw,
    modify(raw, path, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    })
  );
}
