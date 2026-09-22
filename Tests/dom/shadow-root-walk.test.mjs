// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// §6.5 走訪層對 shadow 子樹的處理：walkAndLabel 在走完宿主元素的 light DOM 子節點之後，若該元素帶
// shadowRoot，另以同一組繼承值（下行增量後的 region／hint／有效 lang）走一次 shadow 子節點，並把
// shadow 內的 block 訊號一併上傳給宿主。第二遍 collect 只走 childNodes，不跨 shadow 邊界 ⇒ shadow
// 內的文字從不成段，這條迴圈的唯一外顯效果是「宿主要不要當 block flush 邊界」。
//
// 既有測試全部以 linkedom 解析的純 light DOM 為 fixture、無人呼叫 attachShadow，故 `el.shadowRoot`
// 恆為 falsy、整段迴圈零執行（2026-09-16 coverage 一手：content.js:1032-1037 零命中）。
// 2026-09-16 突變實測（基線 287 綠）三種退化各 0 fail：拿掉整段 shadow 迴圈、走了 shadow 但不
// 上傳 block 訊號、把 shadow 子節點換回 light DOM 子節點。
//
// 期望值一律由實跑取得，非從規則推導。**不動 shadow 的走訪規則本身**（那是 production 改動、另一道閘）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { koine, stubGetStyle } from "./helpers.mjs";

/** 建一份文件，對 `hostSel` 掛 open shadow root 並填入 `shadowHtml`（不填＝不掛）。 */
function collectWith(bodyHtml, hostSel, shadowHtml) {
	const { document } = parseHTML(`<!doctype html><html><body>${bodyHtml}</body></html>`);
	if (shadowHtml !== undefined) {
		document.querySelector(hostSel).attachShadow({ mode: "open" }).innerHTML = shadowHtml;
	}
	const ctx = koine.makeContext({ getStyle: stubGetStyle, pageLangIsZh: false });
	return koine.collectSegments(document.body, ctx, { walkId: 1 });
}

// 宿主是 inline 的 <span>，前後各有裸文字：沒有 block 訊號時三者併成一段，
// 有 block 訊號時宿主變 flush 邊界、切成三段——這個差是本檔的觀測點。
const MIXED = `<p>Leading sentence here. <span id="host">inline host words</span> trailing words.</p>`;

test("對照：宿主不帶 shadowRoot → 前後裸文字與 inline 宿主併成單段", () => {
	const segs = collectWith(MIXED, "#host", undefined);
	assert.equal(segs.length, 1);
	assert.equal(segs[0].source, "Leading sentence here. inline host words trailing words.");
});

test("shadow 內的 block 子上傳到宿主 → 宿主升為 block flush 邊界、段落切成三段", () => {
	const segs = collectWith(MIXED, "#host", `<div>Shadow block content.</div>`);
	assert.deepEqual(segs.map((s) => s.source), [
		"Leading sentence here.",
		"inline host words",
		"trailing words.",
	]);
});

test("shadow 內只有 inline 內容 → 無 block 訊號可上傳、宿主仍是 inline、不切段", () => {
	const segs = collectWith(MIXED, "#host", `<em>shadow inline only</em>`);
	assert.equal(segs.length, 1);
	assert.equal(segs[0].source, "Leading sentence here. inline host words trailing words.");
});

test("shadow 內的文字從不成段、也不混進 light DOM 段的原文（第二遍不跨 shadow 邊界）", () => {
	const segs = collectWith(
		`<div id="host"><p>Light child paragraph.</p></div>`,
		"#host",
		`<p>Shadow paragraph one.</p><span>Shadow inline text.</span>`,
	);
	assert.deepEqual(segs.map((s) => s.source), ["Light child paragraph."]);
	assert.ok(!segs.some((s) => s.source.includes("Shadow")), "shadow 內的字不得出現在任何段");
});

test("shadow 內的 block 子讓 button-class 窄判準落空 → insertMode 自 replace 退回 after-segment", () => {
	const plain = collectWith(`<div><button id="host">Save now</button></div>`, "#host", undefined);
	assert.equal(plain[0].source, "Save now");
	assert.equal(plain[0].anchor.insertMode, "replace");

	const shadowed = collectWith(
		`<div><button id="host">Save now</button></div>`,
		"#host",
		`<div>Shadow block inside button.</div>`,
	);
	assert.equal(shadowed[0].source, "Save now");
	assert.equal(shadowed[0].anchor.insertMode, "after-segment", "shadow 的 block 訊號應計入 hasBlockDescendant");
});
