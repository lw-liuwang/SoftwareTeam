import { join } from "node:path";

export function contextUsageDirectory(softwareteamHome: string): string {
  return join(softwareteamHome, "state", "context-usage");
}

export function legacyContextUsageDirectory(softwareteamHome: string): string {
  return join(softwareteamHome, "context");
}

export function providerUsageDirectory(softwareteamHome: string): string {
  return join(softwareteamHome, "state", "provider-usage");
}

export function legacyProviderUsageDirectory(softwareteamHome: string): string {
  return join(softwareteamHome, "provider-usage");
}

export function telemetrySidecarFilename(sessionName: string): string {
  return `${sessionName.replace(/[^a-zA-Z0-9@._-]/g, "_")}.json`;
}

export function telemetrySidecarPath(directory: string, sessionName: string): string {
  return join(directory, telemetrySidecarFilename(sessionName));
}
