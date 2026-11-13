import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { clipNotes, NOTES_MAX } from "../notes.ts";

Deno.test("notes: a note read from a mail is cut to the limit with an ellipsis, a short one is left as it is", () => {
  assertEquals(NOTES_MAX, 200);
  assertEquals(clipNotes("  夕朝食付き  "), "夕朝食付き");
  assertEquals(clipNotes("あ".repeat(200)), "あ".repeat(200));
  const cut = clipNotes("あ".repeat(250));
  assertEquals([cut.length, cut.endsWith("…")], [200, true]);
});

Deno.test("notes: the page counts against the same limit as the server", async () => {
  const html = await Deno.readTextFile(new URL("../../../web/index.html", import.meta.url));
  assertEquals(html.includes(`const NOTES_MAX = ${NOTES_MAX};`), true);
  assertEquals(html.includes(`id="f_notes" rows="2" maxlength="${NOTES_MAX}"`), true);
});
