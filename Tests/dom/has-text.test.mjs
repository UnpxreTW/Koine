// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：hasText 的空白判準直接斷言。
// 既有測試只在採集流程裡間接走到這顆守門，空白的定義本身沒有斷言——尤其零寬空白
// 在此算有字、不斷行空白卻不算，判準與 worthTranslating 那側不同軸。期望值取自現行實作實跑。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { koine } from "./helpers.mjs";

const { document } = parseHTML("<!doctype html><html><body></body></html>");

/** 造一個 div，內容由 html 給。 */
function div(html) {
	const el = document.createElement("div");
	el.innerHTML = html;
	return el;
}

test("判準是 textContent 去前後空白後仍有長度", () => {
	assert.equal(koine.hasText(div("內容")), true);
	assert.equal(koine.hasText(div("  內容  ")), true);
	assert.equal(koine.hasText(div("")), false);
	assert.equal(koine.hasText(div("   ")), false);
	assert.equal(koine.hasText(div("\n\t ")), false);
});

test("零寬空白算有字、不斷行空白與位元組順序記號不算", () => {
	// U+200B 不在 JavaScript 的 trim 定義裡，於是算有字；U+00A0 與 U+FEFF 則被 trim 去掉。
	// worthTranslating 那側在判斷前會顯式去掉零寬空白與 soft-hyphen，此處只有 trim，兩軸判準不同。
	assert.equal(koine.hasText(div("​")), true);
	assert.equal(koine.hasText(div(" ")), false);
	assert.equal(koine.hasText(div("﻿")), false);
});

test("文字取整棵子樹、註解與屬性不算", () => {
	assert.equal(koine.hasText(div("<span><em>內容</em></span>")), true);
	assert.equal(koine.hasText(div("<!-- 內容 -->")), false);
	assert.equal(koine.hasText(div("<img alt='內容'>")), false);
	assert.equal(koine.hasText(div("<span> </span><span>內容</span>")), true);
});
