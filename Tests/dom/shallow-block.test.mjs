// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：isShallowBlock 在 display 取不到時的退化分支直接斷言。
// 這顆函式決定一顆元素是不是 block flush 邊界，採集期每顆元素都經它。既有測試一律
// 經 helpers 的 stubGetStyle 餵值，而該 stub 永遠回一個帶 display 的物件（tag 預設或
// data-d），所以「樣式物件缺席」與「display 為空字串」兩支從未進到這顆函式。突變實測
// 指出該段零看守：把 `d === "none" || d === ""` 這條短路改成只看 "none"、只看空字串、
// 或整條翻成 return true，以及樣式物件缺席時的預設由空字串改成 "block"，四種退化整套
// 測試照樣全綠。期望值一律取自現行實作的實測輸出（characterization）；本檔只記錄行為，
// 不主張它應該如此。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { koine } from "./helpers.mjs";

const { document } = parseHTML(
	"<!doctype html><html><body>"
	+ "<div id=\"d\">x</div><span id=\"s\">y</span><li id=\"li\">z</li><h2 id=\"h\">w</h2>"
	+ "<span id=\"r\" role=\"button\">b</span><div id=\"dr\" role=\"BUTTON\">c</div>"
	+ "</body></html>",
);
const el = (id) => document.getElementById(id);

test("樣式物件缺席 ⇒ 不是 block 邊界", () => {
	// cs 為 null／undefined 時 display 取空字串，落短路分支回 false——標籤本身的預設
	// display 不參與判定，天生 block 的 <div> 同樣回 false。
	assert.equal(koine.isShallowBlock(el("d"), null), false);
	assert.equal(koine.isShallowBlock(el("d"), undefined), false);
	assert.equal(koine.isShallowBlock(el("s"), null), false);
});

test("display 為 none 或空字串 ⇒ 不是 block 邊界", () => {
	assert.equal(koine.isShallowBlock(el("d"), { display: "none" }), false);
	assert.equal(koine.isShallowBlock(el("d"), { display: "" }), false);
	assert.equal(koine.isShallowBlock(el("s"), { display: "none" }), false);
	// 字面比對、不折大小寫：大寫的 NONE 不走短路，落一般分類分支。
	assert.equal(koine.isShallowBlock(el("d"), { display: "NONE" }), true);
});

test("樣式物件在但沒有 display 鍵 ⇒ 是 block 邊界（與缺席不同支）", () => {
	// 取到的是 undefined，兩個字面比對皆不成立，落一般分類分支；isInlineDisplay(undefined)
	// 為 false ⇒ 回 true。與上面「樣式物件缺席」的結果相反。
	assert.equal(koine.isShallowBlock(el("d"), {}), true);
	assert.equal(koine.isShallowBlock(el("d"), { display: undefined }), true);
});

test("退化值不推翻前兩支優先分支", () => {
	// 標籤白名單與 role=button 都在讀 display 之前判定，退化值進不到它們。
	assert.equal(koine.isShallowBlock(el("li"), null), true);
	assert.equal(koine.isShallowBlock(el("li"), { display: "none" }), true);
	assert.equal(koine.isShallowBlock(el("li"), { display: "inline" }), true);
	assert.equal(koine.isShallowBlock(el("h"), undefined), true);
	assert.equal(koine.isShallowBlock(el("r"), null), true);
	assert.equal(koine.isShallowBlock(el("r"), { display: "none" }), true);
	assert.equal(koine.isShallowBlock(el("dr"), { display: "" }), true);
});

test("對照：display 有值時照 inline／block 分類", () => {
	assert.equal(koine.isShallowBlock(el("d"), { display: "block" }), true);
	assert.equal(koine.isShallowBlock(el("s"), { display: "flex" }), true);
	assert.equal(koine.isShallowBlock(el("d"), { display: "inline" }), false);
	assert.equal(koine.isShallowBlock(el("s"), { display: "inline-block" }), false);
	assert.equal(koine.isShallowBlock(el("d"), { display: "contents" }), false);
});
