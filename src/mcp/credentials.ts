/**
 * Where a paired MCP keeps its token (issue #1).
 *
 * `$XDG_CONFIG_HOME/plancel/credentials.json`, falling back to
 * `~/.config/plancel/`; `PLANCEL_CREDENTIALS` overrides the whole path.
 * Keyed by the API's base URL so a dev server and production never share an
 * entry. Directory 0700, file 0600 — best effort on platforms without POSIX
 * modes. The token lives here and nowhere else: not in the MCP config, not
 * in the conversation.
 *
 * File IO is injected so tests run in a temp directory and never touch the
 * real config.
 */
import { z } from "zod";

const entrySchema = z.object({
  token: z.string().min(1),
  tokenId: z.string().min(1),
  account: z.object({ label: z.string() }),
  pairedAt: z.string(),
});
export type CredentialEntry = z.infer<typeof entrySchema>;
const fileSchema = z.record(entrySchema);

export interface CredentialFs {
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}

/** Real filesystem; a missing file reads as null, every other error throws. */
export const denoFs: CredentialFs = {
  async readText(path) {
    try {
      return await Deno.readTextFile(path);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return null;
      throw err;
    }
  },
  writeText: (path, text) => Deno.writeTextFile(path, text, { mode: 0o600 }),
  mkdir: (path) => Deno.mkdir(path, { recursive: true, mode: 0o700 }),
  async chmod(path, mode) {
    try {
      await Deno.chmod(path, mode);
    } catch {
      // Windows and the like: modes are advisory there.
    }
  },
};

/** Resolves the credentials path from the environment (injected for tests). */
export function credentialsPath(env: (name: string) => string | undefined): string {
  const explicit = env("PLANCEL_CREDENTIALS");
  if (explicit !== undefined && explicit !== "") return explicit;
  const xdg = env("XDG_CONFIG_HOME");
  const base = xdg !== undefined && xdg !== "" ? xdg : `${env("HOME") ?? "."}/.config`;
  return `${base}/plancel/credentials.json`;
}

export class CredentialStore {
  constructor(private readonly path: string, private readonly fs: CredentialFs = denoFs) {}

  private async readAll(): Promise<Record<string, CredentialEntry>> {
    const text = await this.fs.readText(this.path);
    if (text === null) return {};
    try {
      const parsed = fileSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  private async writeAll(all: Record<string, CredentialEntry>): Promise<void> {
    const dir = this.path.slice(0, this.path.lastIndexOf("/"));
    if (dir !== "") {
      await this.fs.mkdir(dir);
      await this.fs.chmod(dir, 0o700);
    }
    await this.fs.writeText(this.path, JSON.stringify(all, null, 2) + "\n");
    await this.fs.chmod(this.path, 0o600);
  }

  async get(baseUrl: string): Promise<CredentialEntry | null> {
    return (await this.readAll())[baseUrl] ?? null;
  }

  async set(baseUrl: string, entry: CredentialEntry): Promise<void> {
    const all = await this.readAll();
    all[baseUrl] = entry;
    await this.writeAll(all);
  }

  async remove(baseUrl: string): Promise<boolean> {
    const all = await this.readAll();
    if (!(baseUrl in all)) return false;
    delete all[baseUrl];
    await this.writeAll(all);
    return true;
  }
}
