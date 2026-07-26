export interface PwaAsset {
  body: BodyInit;
  contentType: string;
  cacheControl: string;
  serviceWorkerAllowed?: string;
}

export type PwaAssets = ReadonlyMap<string, PwaAsset>;

/** Loads the fixed PWA shell once at process startup. */
export async function loadPwaAssets(): Promise<PwaAssets> {
  const root = new URL("../../web/", import.meta.url);
  const [manifest, serviceWorker, icon192, icon512, iconMaskable512] = await Promise.all([
    Deno.readTextFile(new URL("manifest.webmanifest", root)),
    Deno.readTextFile(new URL("sw.js", root)),
    Deno.readFile(new URL("icons/icon-192.png", root)),
    Deno.readFile(new URL("icons/icon-512.png", root)),
    Deno.readFile(new URL("icons/icon-maskable-512.png", root)),
  ]);

  return new Map([
    [
      "/manifest.webmanifest",
      {
        body: manifest,
        contentType: "application/manifest+json; charset=utf-8",
        cacheControl: "no-cache",
      },
    ],
    [
      "/sw.js",
      {
        body: serviceWorker,
        contentType: "text/javascript; charset=utf-8",
        cacheControl: "no-cache, no-store, must-revalidate",
        serviceWorkerAllowed: "/",
      },
    ],
    [
      "/icons/icon-192.png",
      {
        body: icon192,
        contentType: "image/png",
        cacheControl: "public, max-age=86400",
      },
    ],
    [
      "/icons/icon-512.png",
      {
        body: icon512,
        contentType: "image/png",
        cacheControl: "public, max-age=86400",
      },
    ],
    [
      "/icons/icon-maskable-512.png",
      {
        body: iconMaskable512,
        contentType: "image/png",
        cacheControl: "public, max-age=86400",
      },
    ],
  ]);
}

/** Returns null when the pathname is not one of the fixed PWA assets. */
export function servePwaAsset(pathname: string, assets: PwaAssets): Response | null {
  const asset = assets.get(pathname);
  if (asset === undefined) return null;
  const headers = new Headers({
    "content-type": asset.contentType,
    "cache-control": asset.cacheControl,
    "x-content-type-options": "nosniff",
  });
  if (asset.serviceWorkerAllowed !== undefined) {
    headers.set("service-worker-allowed", asset.serviceWorkerAllowed);
  }
  return new Response(asset.body, { headers });
}
