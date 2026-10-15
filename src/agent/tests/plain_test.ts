import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.19";
import { plainText, STATUS_LABEL } from "../plain.ts";
import { call, fcResponse, say, ScriptedModel, withWorld } from "./fixtures.ts";

Deno.test("plainText strips Markdown the screen would print literally", () => {
  assertEquals(
    plainText("**トラットリア アルバ（記念日ディナー）**が重なっています。"),
    "トラットリア アルバ（記念日ディナー）が重なっています。",
  );
  assertEquals(plainText("__強調__と`コード`と*斜体*"), "強調とコードと斜体");
  assertEquals(plainText("## 結果\n本文"), "結果\n本文");
  assertEquals(plainText("###見出し無しの記号") === "###見出し無しの記号", true); // not a heading: no space
  assertEquals(plainText("* 一つ目\n- 二つ目\n  * 三つ目"), "・一つ目\n・二つ目\n・三つ目");
  assertEquals(plainText("[詳細](https://example.com/x)を見る"), "詳細を見る");
  assertEquals(plainText("```\nコード\n```"), "コード");
});

Deno.test("plainText leaves plain Japanese, amounts and dates alone", () => {
  for (
    const s of [
      "本日23:59を過ぎると8,000円（50%）のキャンセル料が発生します。",
      "2 * 3 = 6 ではなく、料率は 50% です。",
      "ID 01M4XQY76GJ034TT10CNV6627B は触らない",
    ]
  ) assertEquals(plainText(s), s);
});

Deno.test("plainText names statuses the way the screen does, but not inside longer identifiers", () => {
  assertEquals(
    plainText(
      "「アルバ」は to_cancel、「ビストロ」は candidate、「鮨」は confirmed、もう一件は cancelled。",
    ),
    "「アルバ」は 要キャンセル、「ビストロ」は 候補、「鮨」は 確定、もう一件は キャンセル済み。",
  );
  assertEquals(plainText("旅館 花ごろも（candidate）"), "旅館 花ごろも（候補）");
  assertEquals(plainText("status: finished"), "status: 終了済み");
  assertEquals(plainText("TO_CANCEL"), "要キャンセル");
  // identifiers that merely contain a status word are not touched
  assertEquals(
    plainText("confirmed_reservation_cannot_be_proposed / candidates / unconfirmed"),
    "confirmed_reservation_cannot_be_proposed / candidates / unconfirmed",
  );
  assertEquals(Object.keys(STATUS_LABEL).sort(), [
    "cancelled",
    "candidate",
    "confirmed",
    "finished",
    "to_cancel",
  ]);
});

Deno.test("a run stores the model's words clean: summary, decision steps, proposal and notification", async () => {
  await withWorld(async (w) => {
    const hotels = [] as string[];
    const model = new ScriptedModel((req, n) => {
      if (n === 0) return fcResponse({ name: "list_reservations", args: {} });
      if (n === 1) {
        const listed = req.contents.at(-1)!.parts[0]!.functionResponse!.response as {
          reservations: { id: string; service: string; status: string }[];
        };
        const alba = listed.reservations.find((r) => r.status === "to_cancel")!;
        hotels.push(
          ...listed.reservations.filter((r) => r.service.includes("ホテル")).map((r) => r.id),
        );
        return fcResponse({
          name: "propose_cancellation",
          args: {
            reservation_id: alba.id,
            reason: "**トラットリア アルバ**は to_cancel で、今夜まで無料です。",
            draft_message: "## ご連絡\n**予約のキャンセル**をお願いします。",
          },
        }, {
          name: "notify_user",
          args: {
            title: "**宿の決定**",
            body: "* ホテル鴨川は candidate のままです。",
            level: "warning",
            reservation_ids: hotels,
          },
        });
      }
      return say(
        "**トラットリア アルバ（記念日ディナー）**を提案しました。状態は to_cancel です。\n* 宿は candidate",
      );
    });
    const { run } = await (await call(w.deps(model), "POST", "/api/agent/run", w.demo)).json();

    const everything = JSON.stringify(run);
    for (const raw of ["**", "to_cancel", "candidate", "##", "* "]) {
      assertEquals(everything.includes(raw), false, `"${raw}" must not reach the screen`);
    }
    assertEquals(
      run.summary,
      "トラットリア アルバ（記念日ディナー）を提案しました。状態は 要キャンセル です。\n・宿は 候補",
    );
    assertStringIncludes(run.proposals[0].reason, "トラットリア アルバは 要キャンセル で");
    assertStringIncludes(run.proposals[0].draftMessage, "予約のキャンセルをお願いします。");
    assertEquals(run.notifications[0].title, "宿の決定");
    assertStringIncludes(run.notifications[0].body, "・ホテル鴨川は 候補 のまま");
    // The reasoning step shows the cleaned text too.
    const decide = run.steps.find((s: { phase: string }) => s.phase === "decide");
    assertStringIncludes(decide.result, "トラットリア アルバは 要キャンセル で");
  });
});
