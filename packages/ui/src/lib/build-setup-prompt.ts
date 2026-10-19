export interface SetupPromptInput {
  name: string;
  summary?: string;
  sourcePath: string;
}

export function buildSetupPrompt(input: SetupPromptInput): string {
  const lines: string[] = [
    `Install and launch the "${input.name}" managed app using SoftwareTeam.`,
    "",
  ];

  if (input.summary) {
    lines.push(`About: ${input.summary}`, "");
  }

  lines.push(
    `Source: ${input.sourcePath}`,
    "",
    "Steps:",
    `1. Run: SoftwareTeam up ${input.name}`,
    `2. Monitor: SoftwareTeam ps --nodes --software-team ${input.name}`,
    "3. Check env: SoftwareTeam env status <software-team-name>",
  );

  return lines.join("\n");
}
