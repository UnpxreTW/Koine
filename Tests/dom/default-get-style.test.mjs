// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：makeContext 未給 getStyle 時的預設樣式讀取（§8 的 WeakMap 快取）。
// 既有測試一律經 helpers.mjs 的 stubGetStyle 注入，預設那條從未執行——少數不帶 getStyle 的
// makeContext 呼叫（純函式測試）都沒有呼叫過 ctx.getStyle。本檔以 getComputedStyle
// 替身驅動預設路徑，斷言三欄投影、一元素一次的快取、快取的鍵與共享，期望值取自現行實作實跑。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { koine } from "./helpers.mjs";

/**
 * 裝上 getComputedStyle 替身並回計數器。
 *
 * `contentVisibility` 刻意餵一個不該被讀到的哨兵值：實作走的是
 * `getPropertyValue("content-visibility")`，讀成駝峰屬性就會被本檔抓到。
 * `color` 是投影範圍外的欄位，用來證明三欄以外的都不帶出。
 */
function stubComputedStyle() {
	const probe = { calls: 0, asked: /** @type {string[]} */ ([]) };
	globalThis.getComputedStyle = (el) => {
		probe.calls++;
		return {
			display: el.getAttribute("data-d") || "block",
			visibility: el.getAttribute("data-vis") || "visible",
			contentVisibility: "哨兵：不該被讀到",
			color: "rgb(255, 0, 0)",
			getPropertyValue(name) {
				probe.asked.push(name);
				return name === "content-visibility" ? (el.getAttribute("data-cv") || "auto") : "";
			},
		};
	};
	return probe;
}

/** 建兩顆有屬性可辨識的元素。 */
function twoElements() {
	const { document } = parseHTML(
		"<!doctype html><html><body>" +
		"<div id=\"a\" data-d=\"flex\" data-vis=\"hidden\" data-cv=\"hidden\"></div>" +
		"<div id=\"b\"></div>" +
		"</body></html>",
	);
	return { a: document.getElementById("a"), b: document.getElementById("b") };
}

test("預設讀取只投影三欄，content-visibility 走 getPropertyValue", () => {
	const probe = stubComputedStyle();
	const { a, b } = twoElements();
	const ctx = koine.makeContext();

	const sa = ctx.getStyle(a);
	assert.deepEqual(Object.keys(sa).sort(), ["contentVisibility", "display", "visibility"], "恰三欄、不多不少");
	assert.deepEqual(sa, { display: "flex", visibility: "hidden", contentVisibility: "hidden" });
	assert.deepEqual(probe.asked, ["content-visibility"], "只查這一個屬性名");

	// 駝峰的哨兵值沒有外流 ⇒ 讀的是 getPropertyValue 那條。
	assert.notEqual(sa.contentVisibility, "哨兵：不該被讀到");
	assert.equal("color" in sa, false, "投影範圍外的欄位不帶出");

	assert.deepEqual(ctx.getStyle(b), { display: "block", visibility: "visible", contentVisibility: "auto" });
});

test("同一元素只算一次：第二次回同一個物件、不再問 getComputedStyle", () => {
	const probe = stubComputedStyle();
	const { a } = twoElements();
	const ctx = koine.makeContext();

	const first = ctx.getStyle(a);
	assert.equal(probe.calls, 1);
	const second = ctx.getStyle(a);
	assert.equal(probe.calls, 1, "快取命中，不重算");
	assert.ok(first === second, "回的是同一個物件、不是等值的新物件");

	// 元素的屬性在兩次之間改了也不重算——快取是按元素記的，不看內容。
	a.setAttribute("data-d", "none");
	assert.equal(ctx.getStyle(a).display, "flex");
	assert.equal(probe.calls, 1);
});

test("快取以元素為鍵：不同元素各算一次", () => {
	const probe = stubComputedStyle();
	const { a, b } = twoElements();
	const ctx = koine.makeContext();

	ctx.getStyle(a);
	ctx.getStyle(b);
	assert.equal(probe.calls, 2, "兩顆元素各問一次");
	ctx.getStyle(a);
	ctx.getStyle(b);
	assert.equal(probe.calls, 2, "第二輪兩顆都命中快取");
	assert.ok(ctx.getStyle(a) !== ctx.getStyle(b), "兩顆元素各有自己的一份");
});

test("快取可經 _styleCache 交接，不給就各自新開一顆", () => {
	const probe = stubComputedStyle();
	const { a } = twoElements();

	const first = koine.makeContext();
	const shared = first.getStyle(a);
	assert.equal(probe.calls, 1);

	const inherited = koine.makeContext({ _styleCache: first._styleCache });
	assert.ok(inherited._styleCache === first._styleCache, "交接的是同一顆 WeakMap");
	assert.ok(inherited.getStyle(a) === shared, "同一元素讀到同一份");
	assert.equal(probe.calls, 1, "交接後不重算");

	const fresh = koine.makeContext();
	assert.ok(fresh._styleCache !== first._styleCache, "不交接就是新的一顆");
	assert.ok(fresh.getStyle(a) !== shared, "新快取重算、拿到另一份");
	assert.equal(probe.calls, 2);
});

test("明給 getStyle 時預設那條完全不執行", () => {
	const probe = stubComputedStyle();
	const { a } = twoElements();
	const injected = { display: "inline", visibility: "visible", contentVisibility: "visible" };
	const ctx = koine.makeContext({ getStyle: () => injected });

	assert.ok(ctx.getStyle(a) === injected);
	assert.ok(ctx.getStyle(a) === injected);
	assert.equal(probe.calls, 0, "getComputedStyle 一次都沒被問");
	assert.deepEqual(probe.asked, []);
});
