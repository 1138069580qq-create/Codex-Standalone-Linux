import path from "node:path";
import { promises as fs } from "node:fs";
import { ConfigStore, ConsoleError, isWithin, validateConfig, type ConsoleConfig } from "./backend/config";
/** The standalone credential database must never become a remotely accessible project. */
export class ProtectedConfigStore extends ConfigStore {
  private async check(value: ConsoleConfig) {
    const directory = path.dirname(this.file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const privatePath = await fs.realpath(directory);
    if (value.projects.some(p => isWithin(p.root, privatePath) || isWithin(privatePath, p.root)))
      throw new ConsoleError(400, "PRIVATE_DATA_DIRECTORY", "Projects must not overlap the WebUI data/credential directory.");
  }
  override async load() { await super.load(); await this.check(this.value); }
  override async save(input: unknown) { const value=await validateConfig(input); await this.check(value); await super.save(value); }
}
