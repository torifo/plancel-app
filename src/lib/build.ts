/**
 * Which build is answering.
 *
 * Deno Deploy returns no header that identifies the running revision, and
 * `/healthz` said only `ok`, so after a push there was no way from outside to
 * tell whether the new code was live — the same `ok` came back either way, and
 * "wait a bit and hope" was the whole procedure (2026-08-12).
 *
 * `DENO_DEPLOY_BUILD_ID` is the id of the running build, so it changes on every
 * deploy: that is what answers "did my push land?". `DENO_DEPLOYMENT_ID` covers
 * the whole deployment configuration (app, build, context, env vars,
 * connections) and stands in when the build id is absent. Neither exists off
 * Deploy, which is exactly what "dev" should mean.
 */

/**
 * Structural on purpose: `Deno.env` satisfies it, so does the reader
 * `src/deploy/notifier.ts` already injects, and so does a fake in a test —
 * without this module depending on any of them.
 */
type EnvGet = { get(key: string): string | undefined };

export function buildLabel(env: EnvGet = Deno.env): string {
  const id = env.get("DENO_DEPLOY_BUILD_ID") || env.get("DENO_DEPLOYMENT_ID");
  return id === undefined || id === "" ? "dev" : id;
}

/** The `/healthz` body: `ok` first, so anything matching on it keeps working. */
export function healthzBody(env: EnvGet = Deno.env): string {
  return `ok ${buildLabel(env)}`;
}
