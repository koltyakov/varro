import type { BackgroundProcess } from '../../shared/background-process';
import type { Message, Part } from '../types';

export function buildStopProcessPrompt(process: BackgroundProcess): string {
  return `Stop the background process${process.pid === undefined ? '' : ` with PID ${process.pid}`} running this command:\n${process.command}\nProcess ID: ${process.id}\nWorking directory: ${process.cwd}`;
}

export function getStopProcessActionLabel(info: Message, parts: readonly Part[]): string | null {
  const part = parts[0];
  if (
    info.role !== 'user' ||
    parts.length !== 1 ||
    part?.type !== 'text' ||
    part.synthetic ||
    part.ignored
  )
    return null;
  const match =
    /^Stop the background process(?: with PID (\d+))? running this command:\n([\s\S]+)\nProcess ID: ([^\n]+)\nWorking directory: ([^\n]+)$/.exec(
      part.text
    );
  return match ? `Stop process ${match[1] ?? match[3]}` : null;
}
