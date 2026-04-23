export const window = {
  activeTextEditor: undefined,
};

export const workspace = {
  getWorkspaceFolder() {
    return undefined;
  },
  workspaceFolders: undefined,
};

const vscode = {
  window,
  workspace,
};

export default vscode;
