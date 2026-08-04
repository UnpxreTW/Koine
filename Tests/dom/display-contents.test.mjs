// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：§2.4 `display:contents` 透明穿透。
// 該元素不產生盒，走訪時就地以子節點取代自身——容器不是 flush 邊界、容器內外的 inline 併同一段。
//
// ⚠ 攤平的適用範圍是有條件的：FORCE_BLOCK 白名單、`role=button`、整棵跳過的過濾規則都優先於
// 穿透。前兩者因此**仍會當自己的 anchor.block、即使自身無盒**——那是已知殘留（見本檔「殘留」
// 一條），不是漏寫的不變式。能講的只有「非 FORCE_BLOCK、非 role=button 的 contents 容器不再當
// anchor」。（舊檔頭寫成「anchor.block 永遠落在有盒祖先上」，與下一句的「白名單優先」互相打架
// ——白名單那條路正是製造出無盒 anchor 的來源。）

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { koine, collect, assertSame, stubGetStyle } from "./helpers.mjs";

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
	// ⚠ 這條**分不出**攤平前後：容器內只有 inline 時，攤平前的 span 本來就是 inline、
	// extractText 遞迴照樣取到同一串文字。留著當可讀的規格敘述，別把它當回歸探針——
	// 有鑑別力的是下一條。
	assert.deepEqual(
		sourcesOf('<div>Hello <span data-d="contents">world</span> again</div>'),
		["Hello world again"],
	);
});

test("段的組成：容器內的尾段 inline 與容器外的 inline 併進同一段（不是數段數）", () => {
	// 容器帶 block 子時，攤平與否才看得出差別：
	//   攤平前 —— 容器有 block 子 ⇒ 自身升為 flush 邊界，"tail" 與 "foot" 分屬兩段。
	//   攤平後 —— 容器就地展開，"tail" 與 "foot" 成為同一層的相鄰 inline、併進同一段。
	// 斷言放在「哪些文字併在一起」而非「共幾段」。
	// ⚠ 本條**不是本檔唯一有鑑別力的**：把攤平折掉（effectiveChildren 不再展開 transparent）時，
	// 既有的「含 block 子」「巢狀 contents」「anchor.block 不落在被攤平的」三條會與本條一起轉紅。
	// 別依上一條的註解把那三條也當成純規格敘述刪掉——它們是真探針。本條補的是那三條沒有的：
	// 用節點身分（而非 tagName）釘住併段後的 anchor 究竟是哪一個元素。
	const doc = docOf('<div><span data-d="contents"><p>Block child</p> tail</span> foot</div>');
	const segs = collect(doc);
	assert.deepEqual(segs.map((s) => s.source), ["Block child", "tail foot"]);
	assertSame(segs[1].anchor.block, doc.querySelector("div"), "併段後的 anchor 應落在容器外的有盒祖先 DIV");
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

test("anchor.block 不落在被攤平的 contents 元素上（無盒元素當 anchor 會讓譯文插到錯位置）", () => {
	// ⚠ 範圍：本 case 的容器是普通 span（非 FORCE_BLOCK、非 role=button）才會被攤平。
	// 那兩類容器的殘留行為由下面「殘留」一條釘住，不在本條的斷言範圍內。
	const doc = docOf('<div>Head <span data-d="contents">mid <p>Block child</p> tail</span> foot</div>');
	const segs = collect(doc);
	const blocks = segs.map((s) => s.anchor.block);
	for (const block of blocks) {
		assert.notEqual(block.getAttribute("data-d"), "contents", "anchor.block 仍指到 display:contents 元素");
	}
	assert.deepEqual(blocks.map((b) => b.tagName), ["DIV", "P", "DIV"]);
});

test("殘留（刻意釘住）：FORCE_BLOCK 與 role=button 的 contents 容器仍當自己的 anchor、即使無盒", () => {
	// 這兩條路在 isShallowBlock 內排在讀 display 之前（§2.2 / §P4 KO-5），故 transparent 恆為假、
	// 不被攤平，容器自己成為 anchor.block —— 但它的 computed display 仍是 contents、不產生盒。
	// 後果：量測時 getBoundingClientRect() 全零 ⇒ defaultMeasure 回 0，該段永遠被排程當成「正在
	// 視窗內」，因而壓過真正已捲出視窗的段（無盒這件事不會讓它贏過同樣在視窗內的段——完整推導見 content.js
	// effectiveChildren 的 §2.4 註解）。
	// 釘住而非修掉：真修的方向與「role=button 要能取得自身 anchor」這條既有規則相反，屬另一題。
	const doc = docOf(
		'<div><section data-d="contents">section text</section>'
		+ '<span role="button" data-d="contents">button text</span></div>',
	);
	const bySource = new Map(collect(doc).map((s) => [s.source, s.anchor.block]));
	const section = doc.querySelector("section");
	const button = doc.querySelector("span");
	assertSame(bySource.get("section text"), section, "FORCE_BLOCK 的 contents 容器應仍是自己的 anchor");
	assertSame(bySource.get("button text"), button, "role=button 的 contents 容器應仍是自己的 anchor");
	// 殘留的重點：這兩個 anchor 自己無盒。⚠ 必須**經實作**斷言——回讀本測試自己寫死的 data-d
	// 字串等於什麼都沒釘（那是 fixture 自證），isTransparentDisplay 整條拿掉時照樣全綠。
	for (const el of [section, button]) {
		assert.equal(
			koine.isTransparentDisplay(stubGetStyle(el).display), true,
			`${el.tagName} 應被實作判為無盒（display:contents）`,
		);
		// 同時釘住「為什麼它仍是 anchor」：白名單／role 那兩條路本身。
		assert.equal(
			koine.isShallowBlock(el, stubGetStyle(el)), true,
			`${el.tagName} 應被 isShallowBlock 判為 block 邊界（故 transparent 恆為假、不被攤平）`,
		);
	}
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
