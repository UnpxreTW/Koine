// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：§6.5 heuristicRegion 三訊號評分的直接斷言。
// region.test.mjs 走 collectSegments 端到端、只驗典型值；本檔直接餵 (block, hint)，
// 釘住權重表、三條門檻、同分規則與 link-density 的計法。期望值全取自現行實作實跑。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { koine } from "./helpers.mjs";

const R = koine.Region;

/** 造一個 block 元素（body 內單一 div，內容由 html 給）。 */
function block(html) {
	const { document } = parseHTML(`<!doctype html><html><body><div id="b">${html}</div></body></html>`);
	return document.getElementById("b");
}

/** n 個非空白字元。 */
function text(n) {
	return "x".repeat(n);
}

test("三訊號的權重：hint ±2、link-density +2 chrome、長文 +2 main、短文 +1 chrome", () => {
	// 只有 hint：hint 那側直接定案。
	assert.equal(koine.heuristicRegion(block(text(80)), R.CHROME), R.CHROME);
	assert.equal(koine.heuristicRegion(block(text(80)), R.MAIN), R.MAIN);
	// hint MAIN(2) vs link-density(2)：同分 → MAIN；hint 權重若掉到 1 這條會翻。
	assert.equal(koine.heuristicRegion(block(`<a href="#">${text(80)}</a>`), R.MAIN), R.MAIN);
	// hint MAIN(2) vs link-density(2)+短文(1)：3 > 2 → CHROME；link 權重若掉到 1 這條會翻。
	assert.equal(koine.heuristicRegion(block(`<a href="#">${text(30)}</a>`), R.MAIN), R.CHROME);
	// 長文(2) vs hint CHROME(2)：同分 → MAIN。
	assert.equal(koine.heuristicRegion(block(text(121)), R.CHROME), R.MAIN);
	// 短文(1) 單獨即可定 CHROME。
	assert.equal(koine.heuristicRegion(block(text(39)), null), R.CHROME);
});

test("門檻邊界：長文 >120、短文 <40、link-density >0.5 三條都是嚴格大於／小於", () => {
	// 長文門檻：120 不加分（hint CHROME 獨走）、121 加分後與 hint 同分 → MAIN。
	assert.equal(koine.heuristicRegion(block(text(120)), R.CHROME), R.CHROME);
	assert.equal(koine.heuristicRegion(block(text(121)), R.CHROME), R.MAIN);
	// 短文門檻：40 不加分、39 加分。
	assert.equal(koine.heuristicRegion(block(text(40)), null), R.MAIN);
	assert.equal(koine.heuristicRegion(block(text(39)), null), R.CHROME);
	// link-density 門檻：恰 0.5 不加分、61/120 加分。
	assert.equal(koine.heuristicRegion(block(`<a href="#">${text(60)}</a>${text(60)}`), null), R.MAIN);
	assert.equal(koine.heuristicRegion(block(`<a href="#">${text(61)}</a>${text(59)}`), null), R.CHROME);
});

test("link-density 的計法：後代 a 全數計入、分母為 trim 後的長度", () => {
	// a 不必是直接子節點。
	assert.equal(koine.heuristicRegion(block(`<div><a href="#">${text(61)}</a></div>${text(59)}`), null), R.CHROME);
	// 低密度長文不加 chrome 分。
	assert.equal(koine.heuristicRegion(block(`<a href="#">${text(32)}</a>${text(48)}`), R.MAIN), R.MAIN);
	// 39 個字元加上前後空白仍算短文：長度取 trim 之後。
	assert.equal(koine.heuristicRegion(block(`   ${text(39)}   `), null), R.CHROME);
});

test("同分與零訊號一律 MAIN；空 block 因短文加分落 CHROME", () => {
	// 零訊號（中等長度、無連結、無 hint）→ MAIN。
	assert.equal(koine.heuristicRegion(block(text(80)), null), R.MAIN);
	// hint 傳 undefined 等同無 hint。
	assert.equal(koine.heuristicRegion(block(text(80)), undefined), R.MAIN);
	// 空文字：不進 link 分支、但吃到短文 +1 → CHROME。
	assert.equal(koine.heuristicRegion(block(""), null), R.CHROME);
});
