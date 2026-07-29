// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：§2.4 `display:contents` 透明穿透。
// 該元素不產生盒，走訪時就地以子節點取代自身——容器不是 flush 邊界、容器內外的 inline 併同一段、
// 段的 anchor.block 永遠落在真正有盒的祖先上。FORCE_BLOCK 白名單與整棵跳過的過濾規則優先。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { koine, collect } from "./helpers.mjs";

/** 造 doc（body 內塞 html 片段）。 */
function docOf(html) {
	const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
	return document;
}

/** 收段並回 source 陣列（文件序）。 */
function sourcesOf(html) {
	return collect(docOf(html)).map((s) => s.source);
}

test("isTransparentDisplay：只有 contents 為真（inline 家族與 block 皆否）", () => {
	assert.equal(koine.isTransparentDisplay("contents"), true);
	assert.equal(koine.isTransparentDisplay("inline"), false);
	assert.equal(koine.isTransparentDisplay("inline-grid"), false);
	assert.equal(koine.isTransparentDisplay("block"), false);
	assert.equal(koine.isTransparentDisplay(""), false);
	// 無盒 ⇒ 絕不可被當成 block 邊界（§2.4：contents 仍走 isInlineDisplay 的非 block 側）。
	assert.equal(koine.isInlineDisplay("contents"), true);
});

test("容器內外的 inline 併同一段：contents 不是 flush 邊界", () => {
	assert.deepEqual(
		sourcesOf('<div>Hello <span data-d="contents">world</span> again</div>'),
		["Hello world again"],
	);
});

test("含 block 子：block 子各自成段，前後 inline 跨容器邊界併段", () => {
	assert.deepEqual(
		sourcesOf('<div>Head <span data-d="contents">mid <p>Block child</p> tail</span> foot</div>'),
		["Head mid", "Block child", "tail foot"],
	);
});

test("巢狀 contents 一路攤平到最近的有盒祖先", () => {
	assert.deepEqual(
		sourcesOf(
			'<div>x <span data-d="contents">y <em data-d="contents">z <p>P</p> w</em> v</span> u</div>',
		),
		["x y z", "P", "w v u"],
	);
});

test("anchor.block 不落在 contents 元素上（無盒元素當 anchor 會讓譯文插到錯位置）", () => {
	const doc = docOf('<div>Head <span data-d="contents">mid <p>Block child</p> tail</span> foot</div>');
	const segs = collect(doc);
	const blocks = segs.map((s) => s.anchor.block);
	for (const block of blocks) {
		assert.notEqual(block.getAttribute("data-d"), "contents", "anchor.block 仍指到 display:contents 元素");
	}
	assert.deepEqual(blocks.map((b) => b.tagName), ["DIV", "P", "DIV"]);
});

test("FORCE_BLOCK 白名單勝過 contents：section 仍是 flush 邊界（§2.2 白名單一律贏）", () => {
	assert.deepEqual(
		sourcesOf('<div>before <section data-d="contents">inside</section> after</div>'),
		["before", "inside", "after"],
	);
});

test("整棵跳過的過濾規則優先於穿透：hidden 的 contents 容器連同子代不採集", () => {
	assert.deepEqual(
		sourcesOf('<div>before <span data-d="contents" hidden>skipped <p>also skipped</p></span> after</div>'),
		["before after"],
	);
});

test("forceBlock 訊號穿過 contents 上傳：inline 祖先仍走混排 flush（§2.5）", () => {
	assert.deepEqual(
		sourcesOf('<div><span>outer <em data-d="contents"><p>deep block</p></em> tail</span></div>'),
		["outer", "deep block", "tail"],
	);
});

test("region landmark 仍穿過 contents 繼承（§6.5 分類看語意祖先鏈、不看盒）", () => {
	const doc = docOf(
		'<main><span data-d="contents"><p>Main body paragraph text</p></span></main>'
		+ '<footer><span data-d="contents"><p>Footer copyright text</p></span></footer>',
	);
	const bySource = new Map(collect(doc).map((s) => [s.source, s.region]));
	assert.equal(bySource.get("Main body paragraph text"), koine.Region.MAIN);
	assert.equal(bySource.get("Footer copyright text"), koine.Region.CHROME);
});

test("order 連號升序不因穿透斷號", () => {
	const segs = collect(docOf(
		'<div>a <span data-d="contents">b <p>c</p> d</span> e</div>'
		+ '<div>f <span data-d="contents"><p>g</p><p>h</p></span> i</div>',
	));
	assert.deepEqual(segs.map((s) => s.order), segs.map((_, i) => i));
});
