// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：attributeApplies 對 <input type> 的正規化與缺席預設直接斷言。
// attribute-collect.test.mjs 走 collectSegments 端到端，餵的 type 一律小寫、一律寫明，
// 大小寫折疊、前後空白與「缺 type 等同 text」三支因此沒有斷言。
// 本檔直接餵元素，期望值取自現行實作實跑。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { koine } from "./helpers.mjs";

const { document } = parseHTML("<!doctype html><html><body></body></html>");

/** 造一顆 <input>；type 傳 null 表示不設該屬性。 */
function input(type) {
	const el = document.createElement("input");
	if (type !== null) el.setAttribute("type", type);
	return el;
}

test("type 比對前先小寫折疊：三條白名單都認大寫寫法", () => {
	assert.equal(koine.attributeApplies(input("IMAGE"), "alt"), true);
	assert.equal(koine.attributeApplies(input("SUBMIT"), "value"), true);
	assert.equal(koine.attributeApplies(input("Reset"), "value"), true);
	assert.equal(koine.attributeApplies(input("TEXT"), "placeholder"), true);
	assert.equal(koine.attributeApplies(input("Email"), "placeholder"), true);
});

test("type 比對前先去前後空白", () => {
	assert.equal(koine.attributeApplies(input(" image "), "alt"), true);
	assert.equal(koine.attributeApplies(input("\tSUBMIT\n"), "value"), true);
	assert.equal(koine.attributeApplies(input("  search  "), "placeholder"), true);
});

test("缺 type 與空 type 都依規範等同 text", () => {
	// text 在 placeholder 白名單內、不在 alt 與 value 的白名單內。
	assert.equal(koine.attributeApplies(input(null), "placeholder"), true);
	assert.equal(koine.attributeApplies(input(null), "value"), false);
	assert.equal(koine.attributeApplies(input(null), "alt"), false);
	assert.equal(koine.attributeApplies(input(""), "placeholder"), true);
	assert.equal(koine.attributeApplies(input(""), "value"), false);
});

test("正規化之後仍過送出守門：大寫的具名 submit 一樣不採 value", () => {
	const named = input("SUBMIT");
	named.setAttribute("name", "commit");
	assert.equal(koine.attributeApplies(named, "value"), false);
	const anonymous = input("SUBMIT");
	anonymous.setAttribute("name", "");
	assert.equal(koine.attributeApplies(anonymous, "value"), true);
});

test("對照：非 INPUT 的組合恆成立，type 那一層整個不套", () => {
	const img = document.createElement("img");
	const textarea = document.createElement("textarea");
	assert.equal(koine.attributeApplies(img, "alt"), true);
	assert.equal(koine.attributeApplies(textarea, "placeholder"), true);
});
