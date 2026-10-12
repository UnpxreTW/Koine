// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：第二遍走訪進 block 宿主的 open shadow root（§5 C3）。
//
// 以 `<body>` 為根採集時，宿主的 light 子代走完、先 flush，再把 `el.shadowRoot` 當巢狀容器走一輪：
// shadow 內的 block 子代以自己為 anchor，頂層裸文字／inline 的 run 以 shadow root 為 anchor，
// 後者的插回與觀察沿用容器根那兩支解析器（插回退到段末節點、觀察退到宿主）。
//
// `<slot>` 的子代是後備內容：有節點指派進來時不渲染，整棵跳過；被指派的節點住在宿主的 light DOM、
// 由 light 走訪採一次。沒有指派時後備內容照舊下行。
//
// 本檔不涵蓋的邊界（行為照舊、由其他檔或日後的件處理）：inline 宿主的 shadow 文字（宿主整顆進
// buffer，extractText 不跨 shadow 邊界，見 shadow-root-walk.test.mjs）、`display:contents` 宿主
// （被攤平、不經 collect）、closed shadow root（`shadowRoot` 為 null）、未被指派進任何 slot 的 light
// 子代（不渲染，但 light 走訪仍會採）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { koine, stubGetStyle, assertSame } from "./helpers.mjs";

function docFrom(bodyHtml, htmlAttrs = "") {
	const { document } = parseHTML(`<!doctype html><html${htmlAttrs}><body>${bodyHtml}</body></html>`);
	return document;
}

function collectFrom(root, walkId = 1) {
	const ctx = koine.makeContext({ getStyle: stubGetStyle });
	return koine.collectSegments(root, ctx, { walkId });
}

/** 在 `#host`（或指定選擇器）上掛 open shadow root 並填入內容，回傳該 root。 */
function attachShadow(doc, html, sel = "#host") {
	const root = doc.querySelector(sel).attachShadow({ mode: "open" });
	root.innerHTML = html;
	return root;
}

const DRAFT = (s) => `譯‹${s.source}›`;
function draftPending(segs) {
	for (const s of segs) {
		if (s.state === koine.SegmentState.PENDING) {
			s.draft = DRAFT(s);
			s.state = koine.SegmentState.DRAFTED;
		}
	}
	return segs;
}

test("S1 block 宿主：light 段在前、shadow 段在後；shadow 頂層 run 的 anchor 是 shadow root", () => {
	const doc = docFrom(`<div id="host"><p>Light paragraph here.</p></div>`);
	const root = attachShadow(doc, `Shadow bare words <i id="i">inline</i><p id="p">Shadow paragraph here.</p>`);
	const segs = collectFrom(doc.body);

	assert.deepEqual(segs.map((s) => s.source), [
		"Light paragraph here.",
		"Shadow bare words inline",
		"Shadow paragraph here.",
	]);
	assertSame(segs[1].anchor.block, root, "shadow 頂層 run 應以 shadow root 為 anchor");
	assertSame(segs[1].anchor.refNode, root.querySelector("#i"), "refNode 是段末節點");
	assertSame(segs[2].anchor.block, root.querySelector("#p"), "shadow 內的 block 以自己為 anchor");
	assert.equal(segs[1].anchor.insertMode, "after-segment", "容器錨恆為並列");
});

test("S2 light 的 inline run 與 shadow 頂層 run 不併段（兩者在渲染樹上不相鄰）", () => {
	const doc = docFrom(`<div id="host">Light bare words <b>bold</b></div>`);
	attachShadow(doc, `Shadow bare words <i>inline</i><p>Shadow para.</p>`);
	const segs = collectFrom(doc.body);
	assert.deepEqual(segs.map((s) => s.source), [
		"Light bare words bold",
		"Shadow bare words inline",
		"Shadow para.",
	]);
});

test("S3 shadow 頂層 run 的 region 取宿主所在的區，與同棵 shadow 內元素錨的段同值", () => {
	const doc = docFrom(`<nav><div id="host"></div></nav>`, ` lang="en"`);
	const root = attachShadow(doc, `Shadow bare words here <i>inline</i><p>Shadow para here now.</p>`);
	const segs = collectFrom(doc.body);
	assert.equal(segs.length, 2);
	assertSame(segs[0].anchor.block, root, "前提：第一段的錨要是 shadow root，否則本例沒測到容器錨");
	assert.equal(segs[0].region, koine.Region.CHROME, "宿主在 <nav> 內 ⇒ 容器錨的段也是 chrome");
	assert.equal(segs[1].region, koine.Region.CHROME, "元素錨的段同樣是 chrome（對照組）");
});

test("S4 換根不變：以 <body> 為根採到的 shadow 段 ≡ 以該 shadow root 為根採到的段", () => {
	const doc = docFrom(`<main><section id="host" lang="ja"><p>Light para.</p></section></main>`, ` lang="en"`);
	const root = attachShadow(doc, `Top run words <em>here</em><p>Shadow block para.</p><ul><li>Item one</li></ul>`);
	const shape = (s) => ({ source: s.source, insertMode: s.anchor.insertMode, region: s.region, lang: s.lang });

	const viaBody = collectFrom(doc.body)
		.filter((s) => s.anchor.block === root || root.contains(s.anchor.block))
		.map(shape);
	const viaShadow = collectFrom(root).map(shape);
	assert.ok(viaShadow.length >= 3, "前提：shadow 樹內真的有段");
	assert.deepEqual(viaBody, viaShadow);
});

test("S5 <slot> 有指派：後備內容不採，指派進來的 light 節點只採一次", () => {
	const doc = docFrom(`<div id="host"><span slot="title">Light slotted title</span></div>`);
	attachShadow(doc, `<h3><slot name="title">Fallback title text</slot></h3><p>Shadow body para.</p>`);
	const sources = collectFrom(doc.body).map((s) => s.source);
	assert.ok(!sources.some((s) => s.includes("Fallback")), "看不到的後備文字不得送翻");
	assert.equal(sources.filter((s) => s.includes("Light slotted title")).length, 1, "指派節點恰採一次");
	assert.ok(sources.includes("Shadow body para."));
});

test("S6 <slot> 沒有指派：後備內容照舊採", () => {
	const doc = docFrom(`<div id="host"></div>`);
	attachShadow(doc, `<h3><slot name="title">Fallback title text</slot></h3>`);
	const sources = collectFrom(doc.body).map((s) => s.source);
	assert.deepEqual(sources, ["Fallback title text"]);
});

test("S7 有指派的 <slot> 不讓後備內容的 block 訊號上傳給 inline 宿主", () => {
	// slot 在真引擎下是 display:contents；後備內容裡的 <div> 若被算進來，inline 宿主會升成 block、
	// 把一句話從中切開。
	const html = `<p>Lead words <span id="host"><b slot="x">slotted words</b></span> tail words.</p>`;
	const doc = docFrom(html);
	attachShadow(doc, `<slot name="x" data-d="contents"><div>Fallback block</div></slot>`);
	const segs = collectFrom(doc.body);
	assert.deepEqual(segs.map((s) => s.source), ["Lead words slotted words tail words."]);
});

test("S8 插回落在 shadow 樹內、重採不自吞", () => {
	const doc = docFrom(`<div id="host"><p>Light paragraph here.</p></div>`);
	const root = attachShadow(doc, `Shadow bare <i id="i">inline</i><p id="p">Shadow para here.</p>`);
	const first = draftPending(collectFrom(doc.body));
	assert.equal(first.length, 3, "前提：light 一段、shadow 兩段");

	const inserted = koine.insertTranslations(first);
	assert.equal(inserted.length, 3, "插入數應等於已譯數");
	assertSame(root.querySelector("#i").nextSibling, inserted[1], "容器錨：wrapper 落在段末節點之後");
	assertSame(root.querySelector("#p").nextSibling, inserted[2], "元素錨：wrapper 落在 block 之後");
	assert.equal(root.querySelectorAll("[data-koine-id]").length, 2, "shadow 段的譯文落在 shadow 樹內");

	const second = collectFrom(doc.body, 2);
	assert.equal(second.length, first.length, "重採段數不得增加");
	assert.equal(second.filter((s) => s.source.includes("譯‹")).length, 0, "譯文不得被當原文採回");
});

test("S9 觀察：shadow 頂層 run 觀察宿主、shadow 內 block 觀察自己（只收 Element 的嚴格 observer）", () => {
	const doc = docFrom(`<div id="host"></div>`);
	const root = attachShadow(doc, `Shadow bare <i>inline</i><p id="p">Shadow para here.</p>`);
	const segs = collectFrom(doc.body);
	assert.equal(segs.length, 2);

	const observed = [];
	const makeObserver = () => ({
		observe: (el) => {
			if (!el || el.nodeType !== 1) throw new TypeError("observe: not an Element");
			observed.push(el);
		},
		unobserve: () => {},
		disconnect: () => {},
	});
	koine.observeSegments(segs, { onEnter: () => {}, makeObserver, eagerBudget: 0, measure: () => 0 });
	assert.equal(observed.length, 2);
	assert.ok(observed.includes(doc.getElementById("host")), "容器錨退到宿主");
	assert.ok(observed.includes(root.querySelector("#p")), "元素錨觀察自己");
});

test("S10 巢狀 shadow：shadow 內的 block 宿主再帶 shadow root 也走得進去", () => {
	const doc = docFrom(`<div id="host"></div>`);
	const outer = attachShadow(doc, `<section id="inner"><p>Outer shadow para.</p></section>`);
	const inner = outer.querySelector("#inner").attachShadow({ mode: "open" });
	inner.innerHTML = `<p>Inner shadow para.</p>`;
	const sources = collectFrom(doc.body).map((s) => s.source);
	assert.deepEqual(sources, ["Outer shadow para.", "Inner shadow para."]);
});
