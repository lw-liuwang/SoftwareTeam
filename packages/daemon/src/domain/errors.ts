export class SoftwareTeamNotFoundError extends Error {
  constructor(softwareTeamId: string) {
    super(`SoftwareTeam ${softwareTeamId} not found`);
    this.name = "SoftwareTeamNotFoundError";
  }
}
