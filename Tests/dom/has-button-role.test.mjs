// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：hasButtonRole 對 role 值的正規化直接斷言。
// button-class.test.mjs 只餵標準的 role="button"，大小寫、前後空白、多值與非元素節點
// 都沒有斷言。本檔直接餵元素，期望值取自現行實作實跑。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { koine } from "./helpers.mjs";

const { document } = parseHTML("<!doctype html><html><body></body></html>");

/** 造一個 div；role 傳 null 表示不設該屬性。 */
function div(role) {
	const el = document.createElement("div");
	if (role !== null) el.setAttribute("role", role);
	return el;
}

test("role 值比對前先小寫、再去前後空白", () => {
	assert.equal(koine.hasButtonRole(div("button")), true);
	assert.equal(koine.hasButtonRole(div("BUTTON")), true);
	assert.equal(koine.hasButtonRole(div("Button")), true);
	assert.equal(koine.hasButtonRole(div("  button  ")), true);
	assert.equal(koine.hasButtonRole(div("\tBUTTON\n")), true);
});

test("整個 role 值必須等於 button：多值與部分符合都不算", () => {
	// ARIA 允許 role 寫多值後援清單，現行實作不拆 token、整串比對。
	assert.equal(koine.hasButtonRole(div("button link")), false);
	assert.equal(koine.hasButtonRole(div("link button")), false);
	assert.equal(koine.hasButtonRole(div("buttonbar")), false);
	assert.equal(koine.hasButtonRole(div("menuitem")), false);
});

test("沒有 role、空字串與純空白皆為 false", () => {
	assert.equal(koine.hasButtonRole(div(null)), false);
	assert.equal(koine.hasButtonRole(div("")), false);
	assert.equal(koine.hasButtonRole(div("   ")), false);
});

test("拿不到 getAttribute 的節點回 false、不丟例外", () => {
	// 文字節點沒有 getAttribute；判準走的是 typeof 守門而非 nodeType。
	assert.equal(koine.hasButtonRole(document.createTextNode("送出")), false);
	assert.equal(koine.hasButtonRole(document.createComment("送出")), false);
});
