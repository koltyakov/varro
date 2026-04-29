import { createOpenCodeRuntime, type OpenCodeRuntime } from './open-code-runtime-instance';

let currentOpenCodeRuntime = createOpenCodeRuntime();

function getCurrentOpenCodeRuntime() {
  return currentOpenCodeRuntime;
}

export { createOpenCodeRuntime, type OpenCodeRuntime };

export function installOpenCodeRuntime(runtime: OpenCodeRuntime) {
  const previous = currentOpenCodeRuntime;
  currentOpenCodeRuntime = runtime;
  return () => {
    currentOpenCodeRuntime = previous;
  };
}

export function useOpenCode() {
  return getCurrentOpenCodeRuntime().useOpenCode();
}

export async function recheckSessionStatus(sessionId: string) {
  await getCurrentOpenCodeRuntime().recheckSessionStatus(sessionId);
}

export async function refreshRoutingState() {
  await getCurrentOpenCodeRuntime().refreshRoutingState();
}

export async function applySessionMcps(names: string[], sessionId?: string | null) {
  await getCurrentOpenCodeRuntime().applySessionMcps(names, sessionId);
}

export async function selectSession(id: string, options?: { markSeen?: boolean }) {
  await getCurrentOpenCodeRuntime().selectSession(id, options);
}

export async function createSession(title?: string, initialPermissionMode?: 'default' | 'full') {
  return getCurrentOpenCodeRuntime().createSession(title, initialPermissionMode);
}

export async function deleteSession(id: string) {
  await getCurrentOpenCodeRuntime().deleteSession(id);
}

export async function restoreSession(rootID: string) {
  await getCurrentOpenCodeRuntime().restoreSession(rootID);
}

export async function deleteSessionPermanently(rootID: string) {
  await getCurrentOpenCodeRuntime().deleteSessionPermanently(rootID);
}

export async function emptyRecycleBin() {
  await getCurrentOpenCodeRuntime().emptyRecycleBin();
}

export async function sendMessage(text: string, options?: { noReply?: boolean }) {
  await getCurrentOpenCodeRuntime().sendMessage(text, options);
}

export async function retryMessage(messageId: string, sessionId?: string | null) {
  await getCurrentOpenCodeRuntime().retryMessage(messageId, sessionId);
}

export async function implementPlan(prompt: string, sessionId?: string | null) {
  await getCurrentOpenCodeRuntime().implementPlan(prompt, sessionId);
}

export async function openPlan(markdown: string, sessionId?: string | null) {
  await getCurrentOpenCodeRuntime().openPlan(markdown, sessionId);
}

export async function abortSession() {
  await getCurrentOpenCodeRuntime().abortSession();
}

export async function undoSession() {
  await getCurrentOpenCodeRuntime().undoSession();
}

export async function redoSession() {
  await getCurrentOpenCodeRuntime().redoSession();
}

export async function initSession() {
  await getCurrentOpenCodeRuntime().initSession();
}

export async function runSlashCommandByName(name: string, args: string) {
  return getCurrentOpenCodeRuntime().runSlashCommandByName(name, args);
}

export async function reviewSession() {
  await getCurrentOpenCodeRuntime().reviewSession();
}

export async function compactSession() {
  await getCurrentOpenCodeRuntime().compactSession();
}

export async function respondPermission(
  sessionId: string,
  permissionId: string,
  response: 'once' | 'always' | 'reject',
  options?: { rethrow?: boolean }
) {
  await getCurrentOpenCodeRuntime().respondPermission(sessionId, permissionId, response, options);
}

export async function respondQuestion(requestID: string, answers: Array<Array<string>>) {
  await getCurrentOpenCodeRuntime().respondQuestion(requestID, answers);
}

export async function updatePermissionModeForSession(
  mode: 'default' | 'full',
  sessionId?: string | null
) {
  await getCurrentOpenCodeRuntime().updatePermissionModeForSession(mode, sessionId);
}

export async function rejectQuestion(requestID: string) {
  await getCurrentOpenCodeRuntime().rejectQuestion(requestID);
}
