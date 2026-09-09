// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：§6.5 classifyRegion cascade 第 1 步（landmark）與第 2 步（class/id hint）
// 三段被 region.test.mjs 帶到但沒斷言的行為：ARIA role 值的正規化、未識別 role 落回 tag、
// hint 同時命中兩側時的 tie-break。landmarkRegionOf／regionHintOf 未匯出，一律透過
// classifyRegion(block) 觀察。期望值取自現行實作實測（characterization）；本檔只記錄行為。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { koine } from "./helpers.mjs";

const R = koine.Region;

/** 造 doc（body 內塞 html 片段）。 */
function docOf(html) {
	const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
	return document;
}

/** 對 `sel` 命中的元素跑 walk-up 版 classifyRegion。 */
function regionOf(html, sel) {
	return koine.classifyRegion(docOf(html).querySelector(sel));
}

// 長文（149 字 > 120）：無 landmark 時三訊號評分會判 MAIN，故可與 landmark/tag 的判定拉開。
const LONG = "long ".repeat(30).trim();

test("role 值正規化：大小寫與前後空白都吃（toLowerCase().trim()）", () => {
	// main 側：短文，若 role 未被正規化成 landmark，會落到三訊號短文加分 → CHROME。
	assert.equal(regionOf("<div role='MAIN'><p id='t'>x</p></div>", "#t"), R.MAIN, "大寫 MAIN 應正規化命中");
	assert.equal(regionOf("<div role=' main '><p id='t'>x</p></div>", "#t"), R.MAIN, "前後空白應 trim 掉");
	// chrome 側：長文，若 role 未被正規化，會落到三訊號長文加分 → MAIN，方向相反。
	assert.equal(regionOf(`<div role='NAVIGATION'><p id='t'>${LONG}</p></div>`, "#t"), R.CHROME, "大寫 NAVIGATION 應正規化命中");
	assert.equal(regionOf(`<div role=' navigation '><p id='t'>${LONG}</p></div>`, "#t"), R.CHROME, "前後空白應 trim 掉");
});

test("未識別的 role 落回 tag 判定：present-but-unknown 不中止 cascade", () => {
	// nav 帶未知 role（doc-toc）＋長文：landmark 由 tag NAV 定 CHROME；
	// 若未識別 role 就地回 null 中止 cascade，會落到三訊號長文 → MAIN，方向相反。
	assert.equal(regionOf(`<nav role='doc-toc'><p id='t'>${LONG}</p></nav>`, "#t"), R.CHROME, "未知 role 應讓位給 tag NAV");
	// main 帶未知 role＋短文：landmark 由 tag MAIN 定 MAIN；
	// 中止 cascade 則落到三訊號短文 → CHROME，方向相反。
	assert.equal(regionOf("<main role='doc-toc'><p id='t'>tiny</p></main>", "#t"), R.MAIN, "未知 role 應讓位給 tag MAIN");
});

test("class/id hint 同時命中 main 與 chrome 側：MAIN 先查偏 MAIN（tie-break）", () => {
	// 無 landmark、中長文（57 字、無連結，三訊號零加權）＝ 判定全落在 hint 上。
	// content 命中 main-hint、sidebar 命中 chrome-hint；MAIN 先查 → MAIN。
	const mid = "A medium length sentence with about sixty chars total ok.";
	assert.equal(regionOf(`<div class='content sidebar'><p id='t'>${mid}</p></div>`, "#t"), R.MAIN, "both-match 偏 MAIN");
	// class 內書寫順序不影響：決定權在程式的查詢順序、不在字串位置。
	assert.equal(regionOf(`<div class='sidebar content'><p id='t'>${mid}</p></div>`, "#t"), R.MAIN, "class 順序不改變 tie-break");
});
