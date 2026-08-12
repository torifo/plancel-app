import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { buildLabel, healthzBody } from "../build.ts";

const env = (vars: Record<string, string>) => ({ get: (k: string) => vars[k] });

// ラベルの意味をここで固定する。ズレると、デプロイ後に本番へ入った版を外から
// 確かめる手段が（また）無くなる。
Deno.test("buildLabel: the running build wins, the deployment id stands in", () => {
  assertEquals(buildLabel(env({ DENO_DEPLOY_BUILD_ID: "bld_123" })), "bld_123");
  // ビルドIDが無い環境では、デプロイ設定のIDでも版の入れ替わりは分かる。
  assertEquals(buildLabel(env({ DENO_DEPLOYMENT_ID: "dep_456" })), "dep_456");
  assertEquals(
    buildLabel(env({ DENO_DEPLOY_BUILD_ID: "bld_123", DENO_DEPLOYMENT_ID: "dep_456" })),
    "bld_123",
  );
});

Deno.test("buildLabel: off Deploy — and an empty value — read as dev", () => {
  assertEquals(buildLabel(env({})), "dev");
  // 空文字は「設定されているが空」。版として意味を持たないので dev と同じ扱い。
  assertEquals(buildLabel(env({ DENO_DEPLOY_BUILD_ID: "" })), "dev");
  assertEquals(
    buildLabel(env({ DENO_DEPLOY_BUILD_ID: "", DENO_DEPLOYMENT_ID: "dep_456" })),
    "dep_456",
  );
});

Deno.test("healthzBody: still starts with ok", () => {
  // 監視や手元の確認が `ok` を見ているので、先頭は変えない。
  assertEquals(healthzBody(env({ DENO_DEPLOY_BUILD_ID: "bld_123" })), "ok bld_123");
  assertEquals(healthzBody(env({})), "ok dev");
  assertEquals(healthzBody(env({})).startsWith("ok"), true);
});
