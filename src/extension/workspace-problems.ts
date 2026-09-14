import * as vscode from 'vscode';
import type { EditorDiagnostic, WorkspaceProblemsSnapshot } from '../shared/protocol';
import { isSameWorkspacePath } from '../shared/workspace-path';
import { isNumber, isString } from '../shared/type-utils';

export function getWorkspaceProblems(workspacePath: string | undefined): WorkspaceProblemsSnapshot {
  if (
    !workspacePath ||
    !vscode.workspace.workspaceFolders?.some((folder) =>
      isSameWorkspacePath(folder.uri.fsPath, workspacePath)
    )
  )
    throw new Error('Select an open workspace before attaching problems');
  if (
    !vscode.workspace.getConfiguration('varro').get<boolean>('chat.enableProblemsContext', true)
  ) {
    throw new Error('Problems context is disabled in settings');
  }
  const diagnostics = vscode.languages
    .getDiagnostics()
    .flatMap(([uri, items]) => {
      if (!isSameWorkspacePath(vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath, workspacePath))
        return [];
      return items
        .filter((item) => item.severity <= vscode.DiagnosticSeverity.Warning)
        .map((item) => toEditorDiagnostic(uri.fsPath, item));
    })
    .toSorted(
      (a, b) =>
        Number(a.severity !== 'error') - Number(b.severity !== 'error') ||
        a.path.localeCompare(b.path) ||
        a.line - b.line
    );
  return { diagnostics, total: diagnostics.length };
}

export function toEditorDiagnostic(
  path: string,
  d: vscode.Diagnostic,
  selected = false
): EditorDiagnostic {
  return {
    path,
    severity:
      d.severity === vscode.DiagnosticSeverity.Error
        ? 'error'
        : d.severity === vscode.DiagnosticSeverity.Warning
          ? 'warning'
          : 'info',
    message: d.message,
    line: d.range.start.line + 1,
    column: (d.range.start.character ?? 0) + 1,
    endLine: (d.range.end?.line ?? d.range.start.line) + 1,
    endColumn: (d.range.end?.character ?? d.range.start.character ?? 0) + 1,
    source: d.source,
    code: isString(d.code) || isNumber(d.code) ? d.code : d.code?.value,
    intersectsSelection: selected,
    relatedInformation: d.relatedInformation?.map((related) => ({
      path: related.location.uri.fsPath,
      line: related.location.range.start.line + 1,
      column: related.location.range.start.character + 1,
      message: related.message,
    })),
  };
}
