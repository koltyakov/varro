export type ServerLaunch = {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
};

export function resolveServerLaunch(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform
): ServerLaunch {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    return {
      command: env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', [quoteCmdArg(command), ...args.map(quoteCmdArg)].join(' ')],
      windowsVerbatimArguments: true,
    };
  }

  return { command, args };
}

function quoteCmdArg(value: string): string {
  if (!value) {
    return '""';
  }

  if (!/[\s"&()<>^|]/.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '""')}"`;
}
