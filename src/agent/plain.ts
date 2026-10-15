/** Text the model wrote, as the screen should show it: no Markdown, and the UI's words for statuses. */

/** The words web/index.html uses for each internal status id. */
export const STATUS_LABEL: Record<string, string> = {
  to_cancel: "要キャンセル",
  candidate: "候補",
  confirmed: "確定",
  cancelled: "キャンセル済み",
  finished: "終了済み",
};

const ID_BOUNDARY_BEFORE = "(?<![A-Za-z0-9_])";
const ID_BOUNDARY_AFTER = "(?![A-Za-z0-9_])";
const STATUS_ID = new RegExp(
  `${ID_BOUNDARY_BEFORE}(${Object.keys(STATUS_LABEL).join("|")})${ID_BOUNDARY_AFTER}`,
  "gi",
);

/**
 * Strips Markdown the screen would print literally (bold, italics, code, headings, bullets,
 * links) and rewrites internal status ids to their Japanese labels. Plain text passes through.
 */
export function plainText(text: string): string {
  return text
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/\[([^\]\n]+)\]\((?:[^)\s]+)\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, "$1")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*[*-][ \t]+/gm, "・")
    .replace(STATUS_ID, (id) => STATUS_LABEL[id.toLowerCase()]!)
    .trim();
}
