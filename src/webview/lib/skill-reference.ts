export function formatSkillReference(name: string): string {
  return `$[${encodeURIComponent(name)}]`;
}

export function getSkillReferences(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/\$\[([^\]\s]+)\]/g)) {
    try {
      const name = decodeURIComponent(match[1]!);
      if (name && formatSkillReference(name) === match[0]) names.add(name);
    } catch {
      // Malformed pasted markers remain ordinary text.
    }
  }
  return [...names];
}

export function formatSkillAttachment(name: string): string {
  return `[Attached skill: ${formatSkillReference(name)}]\nUse the skill tool to load ${JSON.stringify(name)} before responding. ${formatSkillReference(name)} in the prompt refers to this skill.`;
}

export function parseSkillAttachment(text: string): string | null {
  const name = getSkillReferences(text)[0];
  return name && text === formatSkillAttachment(name) ? name : null;
}
