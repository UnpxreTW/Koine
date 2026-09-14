// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：classifyNode [1] 防自吞標記 data-koine-translated 的「空值」退化分支。
// 比對用的是 textContent.includes(標記值)，空字串 includes 恆真 ⇒ 退化成「有標記即跳」；
// 這是刻意保留的行為（升級前寫入空標記、已停在頁面上的元素照舊整棵跳過）。
// translated-marker.test.mjs 只餵非空標記、驗 includes 與全等的差異，空值分支沒有斷言——
// 把該分支改成「空標記視為未譯、往下走一般分類」本檔會紅、既有測試全綠。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { koine, stubGetStyle } from "./helpers.mjs";

function docFrom(bodyHtml) {
	const { document } = parseHTML(`<!doctype html><html><body>${bodyHtml}</body></html>`);
	return document;
}

function dispOf(el) {
	const ctx = koine.makeContext({ getStyle: stubGetStyle });
	return koine.classifyNode(el, ctx).disp;
}

test("空標記 + 有內容：includes 恆真 → 整棵跳過（升級前空標記的相容行為）", () => {
	const doc = docFrom(`<button id="b" data-koine-translated="">hello</button>`);
	assert.equal(dispOf(doc.getElementById("b")), "SKIP_SUBTREE");
});

test("空標記 + 空內容：同樣整棵跳過", () => {
	const doc = docFrom(`<button id="b" data-koine-translated=""></button>`);
	assert.equal(dispOf(doc.getElementById("b")), "SKIP_SUBTREE");
});

test("對照：無標記的同款元素一律續走訪（證明是標記、不是元素本身）", () => {
	const doc = docFrom(`<button id="b">hello</button>`);
	assert.equal(dispOf(doc.getElementById("b")), "WALK");
});

test("對照：非空標記但當下內容不含它 → 視為未譯、續走訪（空值才是特例）", () => {
	const doc = docFrom(`<button id="b" data-koine-translated="XYZ">hello</button>`);
	assert.equal(dispOf(doc.getElementById("b")), "WALK");
});
