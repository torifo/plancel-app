import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.19";
import { loadPwaAssets, servePwaAsset } from "../pwa.ts";

Deno.test("PWA manifest has standalone display and installable icons", async () => {
  const assets = await loadPwaAssets();
  const response = servePwaAsset("/manifest.webmanifest", assets);
  if (response === null) throw new Error("manifest response missing");

  assertEquals(response.headers.get("content-type"), "application/manifest+json; charset=utf-8");
  assertEquals(response.headers.get("cache-control"), "no-cache");
  const manifest = JSON.parse(await response.text());
  assertEquals(manifest.display, "standalone");
  assertEquals(manifest.start_url, "/");
  assertEquals(manifest.icons.map((icon: { sizes: string }) => icon.sizes), [
    "192x192",
    "512x512",
    "512x512",
  ]);
  assertEquals(manifest.icons[2].purpose, "maskable");
});

Deno.test("service worker is always revalidated and supports explicit update activation", async () => {
  const assets = await loadPwaAssets();
  const response = servePwaAsset("/sw.js", assets);
  if (response === null) throw new Error("service worker response missing");

  assertEquals(response.headers.get("cache-control"), "no-cache, no-store, must-revalidate");
  assertEquals(response.headers.get("service-worker-allowed"), "/");
  const script = await response.text();
  assertStringIncludes(script, "SKIP_WAITING");
  assertStringIncludes(script, 'pathname.startsWith("/api/")');
  assertStringIncludes(script, 'pathname === "/healthz"');
  assertStringIncludes(script, "if (response.ok)");
  assertStringIncludes(script, 'caches.match("/")');
});

Deno.test("PWA icons are served as cacheable PNGs and unknown paths fall through", async () => {
  const assets = await loadPwaAssets();
  const icon = servePwaAsset("/icons/icon-192.png", assets);
  if (icon === null) throw new Error("icon response missing");

  assertEquals(icon.headers.get("content-type"), "image/png");
  assertEquals(icon.headers.get("cache-control"), "public, max-age=86400");
  assertEquals((await icon.arrayBuffer()).byteLength > 0, true);
  assertEquals(servePwaAsset("/not-a-pwa-asset", assets), null);
});

Deno.test("web shell exposes install/update controls and registers the service worker", async () => {
  const html = await Deno.readTextFile(new URL("../../../web/index.html", import.meta.url));
  assertStringIncludes(html, 'rel="manifest" href="/manifest.webmanifest"');
  assertStringIncludes(html, 'id="pwaInstallBtn"');
  assertStringIncludes(html, 'id="pwaUpdateBtn"');
  assertStringIncludes(html, 'navigator.serviceWorker.register("/sw.js"');
  assertStringIncludes(html, 'waiting.postMessage({ type: "SKIP_WAITING" })');
  assertStringIncludes(html, "grid-template-columns: repeat(5, minmax(0, 1fr))");
  assertStringIncludes(html, '<span class="bn-label">Over</span>');
  assertStringIncludes(html, 'googleLink.style.display = ME.google ? "none" : "inline"');
  assertStringIncludes(html, "✅ Google アカウント連携済み。Google でログインできます。");
});
