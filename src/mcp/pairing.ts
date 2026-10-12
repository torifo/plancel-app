/**
 * The PC side of device pairing (issue #1) — a small state machine the MCP
 * tools consult on every call.
 *
 *   idle ──start()──▶ pending ──poll: approved──▶ paired
 *                        │ poll: access_denied ──▶ denied   (no automatic retry)
 *                        └ poll: expired_token ──▶ expired  (next start() asks again)
 *   paired ──401 from the API──▶ idle                        (credentials dropped)
 *
 * The tool call that finds the client unpaired does not wait: it returns the
 * code and the instructions at once, and the polling runs in the background.
 * The MCP client's default call timeout is a minute; approval takes as long
 * as a person takes.
 *
 * Time, sleep, fetch and the credential store are injected, so a test drives
 * the whole thing with a fake fetch and manual ticks.
 */
import type { Clock } from "../core/clock/mod.ts";
import type { CredentialEntry, CredentialStore } from "./credentials.ts";

export type PairingState =
  | { kind: "idle" }
  | {
    kind: "pending";
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresAtMs: number;
    intervalMs: number;
  }
  | { kind: "paired"; entry: CredentialEntry }
  | { kind: "denied" }
  | { kind: "expired" };

export interface PairingDeps {
  baseUrl: string;
  clientName: string;
  store: CredentialStore;
  clock: Clock;
  fetchFn: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** Explicit env token wins over the file; undefined = none. */
  envToken?: string;
}

export class PairingClient {
  private state: PairingState = { kind: "idle" };
  private polling: Promise<void> | null = null;

  constructor(private readonly deps: PairingDeps) {}

  get current(): PairingState {
    return this.state;
  }

  /**
   * The token to use right now, or null. Order: env, then the file, then
   * whatever a background poll just paired. Env is explicit configuration and
   * must win over an implicit file (CI, scripted checks).
   */
  async token(): Promise<string | null> {
    if (this.deps.envToken !== undefined && this.deps.envToken !== "") return this.deps.envToken;
    if (this.state.kind === "paired") return this.state.entry.token;
    const saved = await this.deps.store.get(this.deps.baseUrl);
    if (saved !== null) {
      this.state = { kind: "paired", entry: saved };
      return saved.token;
    }
    return null;
  }

  /** The API answered 401: this token is dead. Forget it; the next call re-pairs. */
  async forget(): Promise<void> {
    await this.deps.store.remove(this.deps.baseUrl);
    this.state = { kind: "idle" };
  }

  /**
   * Starts (or reports) a pairing request. Idempotent while one is pending:
   * the same code comes back. A denied request is not retried on its own —
   * the person said no — but an explicit `force` starts over.
   */
  async start(force = false): Promise<PairingState> {
    const now = this.deps.clock.now().epochMilliseconds;
    if (this.state.kind === "pending" && this.state.expiresAtMs > now) return this.state;
    if (this.state.kind === "denied" && !force) return this.state;
    const res = await this.deps.fetchFn(`${this.deps.baseUrl}/auth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: this.deps.clientName }),
    });
    if (!res.ok) throw new Error(`pairing request failed: http ${res.status}`);
    const j = await res.json() as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    };
    this.state = {
      kind: "pending",
      deviceCode: j.device_code,
      userCode: j.user_code,
      verificationUri: j.verification_uri,
      expiresAtMs: now + j.expires_in * 1000,
      intervalMs: Math.max(1, j.interval) * 1000,
    };
    this.polling = this.pollUntilDone().finally(() => {
      this.polling = null;
    });
    return this.state;
  }

  /** Tests await this to drive the background loop deterministically. */
  get background(): Promise<void> | null {
    return this.polling;
  }

  private async pollUntilDone(): Promise<void> {
    while (this.state.kind === "pending") {
      const pending = this.state;
      await this.deps.sleep(pending.intervalMs);
      if (this.state !== pending) return; // restarted or forgotten meanwhile
      let res: Response;
      try {
        res = await this.deps.fetchFn(`${this.deps.baseUrl}/auth/device/token`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ device_code: pending.deviceCode }),
        });
      } catch {
        continue; // network blip: keep the interval and try again
      }
      const body = await res.json().catch(() => ({})) as {
        access_token?: string;
        token_id?: string;
        account?: { label: string };
        error?: string;
      };
      if (res.ok && body.access_token !== undefined && body.token_id !== undefined) {
        const entry: CredentialEntry = {
          token: body.access_token,
          tokenId: body.token_id,
          account: { label: body.account?.label ?? "" },
          pairedAt: this.deps.clock.now().toString(),
        };
        await this.deps.store.set(this.deps.baseUrl, entry);
        this.state = { kind: "paired", entry };
        return;
      }
      switch (body.error) {
        case "authorization_pending":
          continue;
        case "slow_down":
          this.state = { ...pending, intervalMs: pending.intervalMs + 5000 };
          continue;
        case "access_denied":
          this.state = { kind: "denied" };
          return;
        case "expired_token":
        default:
          this.state = { kind: "expired" };
          return;
      }
    }
  }
}
