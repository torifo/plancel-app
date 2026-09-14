/**
 * Runs the ENTIRE inline client script of web/index.html, top to bottom, under
 * a minimal stand-in DOM — the way a browser does at page load.
 *
 * Why: on 2026-09-02 a top-level statement used `q(...)` 160 lines before
 * `const q` was declared. Every browser threw at load, every screen stayed
 * blank, and for twelve days nothing noticed: the parse check saw valid
 * syntax, the mirror test evaluates one extracted region, and the error
 * reporter never ran because it lives after the line that died. This test is
 * the one that executes the top level in order.
 *
 * The stand-in is deliberately dumb: every element is a Proxy that accepts
 * any property set, returns an inert element for any get, and answers
 * queries with an empty list. `fetch` answers 401 so `boot()` takes the
 * login-overlay branch and returns. Nothing here asserts behaviour; only
 * that page load completes without an exception.
 */
import { assertEquals } from "jsr:@std/assert@^1.0.19";

const html = await Deno.readTextFile(new URL("../../../web/index.html", import.meta.url));
const match = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/);
if (match === null) throw new Error("web/index.html: inline <script> not found");
const source = match[1]!;
const firstLine = html.slice(0, match.index).split("\n").length + 1;

/**
 * One inert DOM node: callable (so `.onclick()` and `.before(...)` work),
 * accepts any property set, and answers any unknown property with another
 * node. Known collection/boolean/string properties answer with something of
 * the right shape so the script's own guards take their normal branches.
 */
function node(): unknown {
  const store: Record<PropertyKey, unknown> = {
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    textContent: "",
    innerHTML: "",
    value: "",
    checked: false,
    disabled: false,
    hidden: false,
    open: false,
  };
  const target = function () {};
  const self: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === "then") return undefined; // never a thenable
      if (typeof prop === "symbol") return undefined;
      if (prop in store) return store[prop];
      switch (prop) {
        case "querySelectorAll":
        case "getElementsByTagName":
        case "getElementsByClassName":
          return () => [];
        case "children":
        case "files":
        case "options":
        case "childNodes":
          return [];
        case "getBoundingClientRect":
          return () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 });
        case "matches":
        case "contains":
        case "hasAttribute":
          return () => false;
        case "getAttribute":
          return () => null;
        case "parentElement":
        case "parentNode":
        case "nextElementSibling":
        case "previousElementSibling":
        case "firstElementChild":
        case "lastElementChild":
          return null;
        default:
          return node();
      }
    },
    set(_t, prop, value) {
      store[prop] = value;
      return true;
    },
    apply() {
      return node();
    },
  });
  return self;
}

function makeGlobals(): Record<string, unknown> {
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, String(v)),
    removeItem: (k: string) => void storage.delete(k),
  };
  const document = {
    querySelector: () => node(),
    querySelectorAll: () => [],
    getElementById: () => node(),
    createElement: () => node(),
    addEventListener() {},
    removeEventListener() {},
    body: node(),
    documentElement: node(),
    head: node(),
    hidden: false,
  };
  const listeners: Record<string, ((ev: unknown) => void)[]> = {};
  const window = {
    addEventListener: (type: string, fn: (ev: unknown) => void) =>
      (listeners[type] ??= []).push(fn),
    removeEventListener() {},
    location: {
      search: "",
      hash: "",
      pathname: "/",
      href: "http://localhost/",
      origin: "http://localhost",
    },
    history: { replaceState() {}, pushState() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    scrollTo() {},
    alert() {},
    confirm: () => false,
    prompt: () => null,
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
    innerWidth: 390,
    innerHeight: 844,
  };
  return {
    document,
    window,
    self: window,
    localStorage,
    sessionStorage: localStorage,
    navigator: {
      userAgent: "test",
      clipboard: { writeText: () => Promise.resolve() },
      onLine: true,
    },
    location: window.location,
    history: window.history,
    matchMedia: window.matchMedia,
    scrollTo: window.scrollTo,
    alert: window.alert,
    confirm: window.confirm,
    prompt: window.prompt,
    requestAnimationFrame: window.requestAnimationFrame,
    addEventListener: window.addEventListener,
    removeEventListener: window.removeEventListener,
    // 401 so boot() shows the login overlay and returns; nothing else is fetched.
    fetch: () => Promise.resolve(new Response("", { status: 401 })),
    IntersectionObserver: class {
      observe() {}
      disconnect() {}
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    createImageBitmap: () => Promise.reject(new Error("no images in tests")),
    FileReader: class {},
    Image: class {},
  };
}

Deno.test("client: the inline script runs top to bottom at page load without throwing", async () => {
  const globals = makeGlobals();
  const names = Object.keys(globals);
  const values = names.map((n) => globals[n]);
  let thrown: unknown = null;
  try {
    // The script body is the function body; the stand-ins are its parameters,
    // so `document`, `localStorage`, … resolve to them instead of Deno's.
    new Function(...names, source)(...values);
  } catch (e) {
    thrown = e;
  }
  // Let boot()'s first await (fetch → 401) settle.
  await new Promise((r) => setTimeout(r, 20));
  if (thrown !== null) {
    const err = thrown as Error;
    const at = /<anonymous>:(\d+):(\d+)/.exec(err.stack ?? "");
    const where = at ? `web/index.html:${Number(at[1]) + firstLine - 4}` : "(line unknown)";
    throw new Error(`page load threw at ${where}: ${err.name}: ${err.message}`);
  }
  assertEquals(thrown, null);
});
