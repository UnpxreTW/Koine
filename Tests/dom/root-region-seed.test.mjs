// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// §6.5 / §3.6 採集根（非頁面 body）的祖先 region／lang 種子：
// walkAndLabel 在下行 visit 之前，先自 root 的祖先鏈上溯最近的 landmark／class-id hint／lang，
// 當 root 自身的初始繼承值（root 的 region 由祖先決定、不是憑空落 MAIN）。collectSegments 被叫在
// 頁面 body 以外的子樹為 root 時，這條種子迴圈是 root 段落區域與語言的唯一來源。
//
// 既有測試一律自 document.body 收集，root 的祖先只剩 <html>（無 landmark／無 class-id hint、
// lang 例外由 lang-detect／insert-mode 各測一路）——故種子迴圈的 landmark／hint 兩支、以及
// root 祖先鏈上 lang="" 的阻斷邊界，全數零覆蓋。2026-09-10 突變實測（基線 237 綠）：把 landmark
// 種子改回 null、把 hint 種子改回 null、把 lang 種子的 `=== null` 改成 `!rootLang`（讓空字串
// 也繼續上溯），三退化各自 0 fail。本檔對三支各釘一條直接錨。
//
// 期望值一律由實跑取得，非從評分規則推導。**不動種子規則本身**（那是 production 改動、另一道閘）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { koine, stubGetStyle } from "./helpers.mjs";

const R = koine.Region;

/** 自指定子樹 root（非 body）收段。 */
function collectFrom(bodyHtml, rootSel, opts = {}) {
	const { document } = parseHTML(`<!doctype html><html><body>${bodyHtml}</body></html>`);
	const ctx = koine.makeContext({ getStyle: stubGetStyle, pageLangIsZh: opts.pageLangIsZh ?? false });
	return koine.collectSegments(document.querySelector(rootSel), ctx, { walkId: 1 });
}

// 40–120 字、無 <a>、class/id hint regex 不命中的中性段：三訊號評分同分 → 預設 MAIN，
// 故 region 只由祖先種子翻動、不被段身自帶訊號污染。
const MID = "This paragraph has enough words to land between forty and hundred.";

test("landmark 種子：root 的祖先是 <nav> → root 段落繼承 CHROME（無此種子時三訊號評分落 MAIN）", () => {
	const segs = collectFrom(`<nav><section id="r"><p>${MID}</p></section></nav>`, "#r");
	assert.equal(segs.length, 1);
	assert.equal(segs[0].source, MID);
	assert.equal(segs[0].region, R.CHROME, "root 祖先的 nav landmark 應上溯成 root 段落的 region");
});

test("landmark 種子對照：同段無祖先 landmark → 三訊號評分落 MAIN（釘住上一條的翻動來自種子）", () => {
	const segs = collectFrom(`<section id="r"><p>${MID}</p></section>`, "#r");
	assert.equal(segs[0].region, R.MAIN);
});

test("hint 種子：root 的祖先帶 chrome class hint（.sidebar）、無 landmark → 段落評分吃到 CHROME 加權", () => {
	const segs = collectFrom(`<div class="sidebar"><section id="r"><p>${MID}</p></section></div>`, "#r");
	assert.equal(segs[0].source, MID);
	assert.equal(segs[0].region, R.CHROME, "root 祖先的 .sidebar hint 應上溯進 heuristicRegion 評分");
});

test("hint 種子對照：祖先 class 不命中 hint regex → 落 MAIN（釘住上一條的翻動來自種子）", () => {
	const segs = collectFrom(`<div class="plain"><section id="r"><p>${MID}</p></section></div>`, "#r");
	assert.equal(segs[0].region, R.MAIN);
});

test('lang 種子邊界：root 祖先鏈上 lang="" 阻斷上溯 → 不繼承更上層 lang="zh-CN"、簡中段不就地取代', () => {
	// span lang="" 夾在 root 與 div lang="zh-CN" 之間：HTML 規範裡 lang="" ＝語言未知、明確不繼承。
	// 種子迴圈遇 "" 應停止上溯（`rootLang === null` 才續上溯），故 root 段落有效 lang="" ⇒ 非簡中
	// ⇒ insertMode=after-segment。若把判斷改成 `!rootLang`，"" 會被當未找到而繼續吃到 zh-CN、
	// 誤判簡中走 replace（就地覆寫、原文從頁面消失）——正是這條要擋的破壞性退化。
	const segs = collectFrom(
		`<div lang="zh-CN"><span lang=""><section id="r"><p>这是简体中文段落内容。</p></section></span></div>`,
		"#r",
	);
	assert.equal(segs[0].source, "这是简体中文段落内容。");
	assert.equal(segs[0].anchor.insertMode, "after-segment", 'lang="" 應阻斷上溯、不得判簡中就地取代');
});

test('lang 種子邊界對照：root 直接掛在 lang="zh-CN" 下（無空 lang 阻斷）→ 簡中段走 replace', () => {
	const segs = collectFrom(`<div lang="zh-CN"><section id="r"><p>这是简体中文段落内容。</p></section></div>`, "#r");
	assert.equal(segs[0].anchor.insertMode, "replace");
});
