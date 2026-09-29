// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：容器節點當採集根（`Document` / `DocumentFragment` / `ShadowRoot`）。
//
// 容器沒有標籤、屬性與 computed style，§5 的自身訊號一條都不適用 ⇒ 一律下行、剪枝全由子代
// 自己的訊號決定。代價落在**頂層直接掛裸文字或 inline 的那一段**：它在容器上成段，於是
// `anchor.block` 不是 Element，而並列插回與進場觀察原本都只吃 Element。兩處各補一支解析器——
// 插回退到段末節點（`resolveInsertRef`）、觀察退到 `ShadowRoot.host`（`resolveObserveTarget`），
// 無代理者不觀察而直接入列。
//
// 保證面分三級，本檔逐級釘住：
// ① `Document` 與 `<body>` 為根同輸出（root 不變式，全 fixture）；
// ② 連接態 `ShadowRoot` 全程可用（種子取宿主、觀察取宿主、插回落在 shadow 樹內）；
// ③ detached 的 `DocumentFragment` 接受但無保證——跑道 A 注入 stub getStyle 才有產出，真引擎
//    下未連接元素的 computed display 為空字串、§5 [9] 會整批剪掉（跑道 B 釘那一面）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { koine, stubGetStyle, assertSame, FIXTURES } from "./helpers.mjs";

function docFrom(bodyHtml, htmlAttrs = "") {
	const { document } = parseHTML(`<!doctype html><html${htmlAttrs}><body>${bodyHtml}</body></html>`);
	return document;
}

function collectFrom(root, ctxOpts = {}) {
	const ctx = koine.makeContext({ getStyle: stubGetStyle, ...ctxOpts });
	return koine.collectSegments(root, ctx, { walkId: ctxOpts.walkId ?? 1 });
}

/**
 * root 不變式比對形狀：比 golden 通道多帶 `insertMode` 與 `region`（golden 刻意丟 anchor，
 * 只比 source 會讓「插回模式跟著根變」漏網）。
 *
 * 排除掛在頁面根上的**屬性段**：`collect` 只採子代的 `title`、從不採根自身的，所以
 * `<body title>` 在 `<html>`／`Document` 為根時成段、在 `<body>` 為根時不成段。那是採集根的
 * 既有性質、與容器支援無關。
 */
function shape(segs, doc) {
	return segs
		.filter((s) => !(s.kind === "attribute"
			&& (s.anchor.block === doc.documentElement || s.anchor.block === doc.body)))
		.map((s) => ({
			order: s.order,
			source: s.source,
			state: s.state,
			insertMode: s.anchor.insertMode,
			region: s.region,
		}));
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

/** 跑一段程式並攔下 console.warn（該出聲與不該出聲同樣是界線、值得斷言）。 */
function captureWarn(fn) {
	const original = console.warn;
	/** @type {any[][]} */
	const calls = [];
	console.warn = (...args) => { calls.push(args); };
	try {
		fn();
	} finally {
		console.warn = original;
	}
	return calls;
}

/** 在 `<div id="host">` 上掛 open shadow root 並填入內容，回傳該 root。 */
function attachShadow(doc, html) {
	const host = doc.getElementById("host");
	const root = host.attachShadow({ mode: "open" });
	root.innerHTML = html;
	return root;
}

// ---------------------------------------------------------------------------
// C1：root 不變式（Document 與兩種元素根同輸出）
// ---------------------------------------------------------------------------

test("C1 root 不變式：全 fixture 下 Document 為根 ≡ documentElement 為根 ≡ body 為根", () => {
	const manifest = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8"));
	// 兩組包裹：裸的那組驗「容器根被放行後沒有多採或少採」，`html lang` 那組驗它不是靠兩邊
	// 一起歸零成立的（頁面根身分豁免已由 page-level-exempt 釘住，這裡只借它確認不變式有內容）。
	const wraps = [
		{ desc: "裸包裹", html: "" },
		{ desc: "html lang", html: ` lang="zh-TW"` },
	];
	let compared = 0;
	let total = 0;
	for (const c of manifest.cases) {
		const caseHtml = readFileSync(join(FIXTURES, "cases", `${c.name}.html`), "utf8");
		for (const w of wraps) {
			const doc = docFrom(caseHtml, w.html);
			const viaBody = shape(collectFrom(doc.body), doc);
			const viaHTML = shape(collectFrom(doc.documentElement), doc);
			const viaDoc = shape(collectFrom(doc), doc);
			assert.deepEqual(viaHTML, viaBody, `${c.name} / ${w.desc}：documentElement 根`);
			assert.deepEqual(viaDoc, viaBody, `${c.name} / ${w.desc}：Document 根`);
			compared++;
			total += viaBody.length;
		}
	}
	assert.equal(compared, manifest.cases.length * wraps.length);
	assert.ok(total > 0, "不變式不得靠三邊一起零段成立");
});

// ---------------------------------------------------------------------------
// C2 / C3：容器頂層 run 的 anchor 形狀
// ---------------------------------------------------------------------------

test("C2 DocumentFragment 頂層裸文字＋inline 自成一段，anchor.block 是該容器、refNode 是段末節點", () => {
	const doc = docFrom("");
	const frag = doc.createDocumentFragment();
	const em = doc.createElement("em");
	em.textContent = "inline";
	const p = doc.createElement("p");
	p.textContent = "Paragraph inside the fragment.";
	frag.appendChild(doc.createTextNode("Bare words at the top "));
	frag.appendChild(em);
	frag.appendChild(p);

	const segs = collectFrom(frag);
	assert.equal(segs.length, 2, "頂層 run 一段、<p> 一段");
	assertSame(segs[0].anchor.block, frag, "頂層 run 的 anchor.block 應是容器本身");
	assertSame(segs[0].anchor.refNode, em, "refNode 應是段末節點");
	assertSame(segs[1].anchor.block, p, "block 子代照舊以自己為 anchor");
});

test("C3 ShadowRoot 頂層 run 的 anchor.block 是該 shadow root", () => {
	const doc = docFrom(`<div id="host"></div>`);
	const root = attachShadow(doc, `Shadow bare <i>inline</i><p>Shadow para here.</p>`);
	const segs = collectFrom(root);
	assert.equal(segs.length, 2);
	assertSame(segs[0].anchor.block, root, "shadow 頂層 run 的 anchor.block 應是 shadow root");
});

// ---------------------------------------------------------------------------
// C4：ShadowRoot 為根時的 lang／region 種子取自宿主
// ---------------------------------------------------------------------------

test("C4 ShadowRoot 為根：shadow 內節點的 lang／region 與宿主為根時同值（種子自宿主含自身）", () => {
	const doc = docFrom(`<nav><div id="host" lang="ja"></div></nav>`, ` lang="en"`);
	const root = attachShadow(doc, `<p id="p">Shadow paragraph with enough words.</p>`);
	const ctx = koine.makeContext({ getStyle: stubGetStyle });
	const p = root.getElementById ? root.getElementById("p") : root.querySelector("#p");

	// 對照組：以 <body> 為根走一遍——第一遍走訪本來就會進 el.shadowRoot，那條路的值即正解。
	const viaBody = koine.walkAndLabel(doc.body, ctx).get(p);
	const viaShadow = koine.walkAndLabel(root, ctx).get(p);
	assert.equal(viaShadow.lang, viaBody.lang, "有效 lang 不得因換根而不同");
	assert.equal(viaShadow.region, viaBody.region, "region 不得因換根而不同");
	assert.equal(viaShadow.lang, "ja", "種子含宿主自身：宿主的 lang 要算進來");
	assert.equal(viaShadow.region, koine.Region.CHROME, "宿主在 <nav> 內 ⇒ 繼承 chrome");
});

test("C4b ShadowRoot 為根：容器錨的段與同棵樹內元素錨的段 region 同值（皆取宿主所在區）", () => {
	// 容器錨的段（頂層裸文字 run）其 `anchor.block` 是 shadow root 本身、不是 Element。
	// 段 region 若在讀 label 之前先被 nodeType 守衛短路，同一棵 shadow 內的兩段會落在相反的區，
	// 而 region 決定進場觀察的 tier 與 eager 預算的分配。
	const doc = docFrom(`<nav><div id="host"></div></nav>`, ` lang="en"`);
	const root = attachShadow(doc, `Shadow bare words here <i>inline</i><p>Shadow para here now.</p>`);
	const segs = collectFrom(root);

	assert.equal(segs.length, 2);
	assertSame(segs[0].anchor.block, root, "前提：第一段的錨要是容器本身，否則本例沒測到容器錨");
	assert.equal(segs[0].region, segs[1].region, "同一棵 shadow 內的兩段 region 不得相反");
	assert.equal(segs[0].region, koine.Region.CHROME, "宿主在 <nav> 內 ⇒ 容器錨的段也是 chrome");
	assert.equal(segs[1].region, koine.Region.CHROME, "元素錨的段同樣是 chrome（對照組）");
});

// ---------------------------------------------------------------------------
// C5 / C6：插回參考點解析
// ---------------------------------------------------------------------------

test("C5 插回：容器錨的段以段末節點為參考點插回，元素錨的落點一字未改", () => {
	const doc = docFrom(`<div id="host"></div>`);
	const root = attachShadow(doc, `Shadow bare <i id="i">inline</i><p id="p">Shadow para here.</p>`);
	const segs = draftPending(collectFrom(root));
	assert.equal(segs.length, 2);

	const inserted = koine.insertTranslations(segs);
	assert.equal(inserted.length, 2, "插入數應等於已譯數（容器錨那段不得靜默丟失）");

	const i = root.querySelector("#i");
	const p = root.querySelector("#p");
	assertSame(i.nextSibling, inserted[0], "容器錨：wrapper 落在段末節點之後");
	assertSame(p.nextSibling, inserted[1], "元素錨：wrapper 仍落在 block 之後");
	assert.equal(inserted[0].getAttribute("data-koine-id"), segs[0].id);
	assert.equal(root.querySelectorAll("[data-koine-id]").length, 2, "兩份譯文都該落在 shadow 樹內");
	assert.equal(doc.body.querySelectorAll("[data-koine-id]").length, 0, "不得跑到宿主的 light DOM");
});

test("C6 插回：段末節點已被移出容器 → 不插、出一則警訊（不錯位、不靜默）", () => {
	const doc = docFrom(`<div id="host"></div>`);
	const root = attachShadow(doc, `Shadow bare <i id="i">inline</i>`);
	const segs = draftPending(collectFrom(root));
	assert.equal(segs.length, 1);

	// 採集與插回之間站台把段末節點搬走：容器錨沒有別的落點可退，插下去就是錯位。
	const i = root.querySelector("#i");
	doc.body.appendChild(i);

	const warns = captureWarn(() => {
		assert.equal(koine.insertTranslations(segs).length, 0, "落點不可信就不插");
	});
	assert.equal(warns.length, 1, "插不進去要出聲");
	assert.equal(root.querySelectorAll("[data-koine-id]").length, 0);
	assert.equal(doc.body.querySelectorAll("[data-koine-id]").length, 0, "不得插到搬走後的新位置");
});

// ---------------------------------------------------------------------------
// C7：觀察目標解析
// ---------------------------------------------------------------------------

test("C7 觀察：ShadowRoot 錨觀察宿主元素；無代理的容器錨不觀察、直接入列", async () => {
	const doc = docFrom(`<div id="host"></div>`);
	const root = attachShadow(doc, `Shadow bare <i>inline</i>`);
	const host = doc.getElementById("host");
	const frag = doc.createDocumentFragment();
	frag.appendChild(doc.createTextNode("Bare words in a detached fragment."));

	const segs = [...collectFrom(root), ...collectFrom(frag, { walkId: 2 })];
	assert.equal(segs.length, 2, "兩段各自掛在一個容器錨上");

	/** 嚴格 stub：與真 IntersectionObserver 同樣只收 Element（WebIDL 簽名），餵進容器就丟。 */
	const observed = [];
	const makeObserver = () => ({
		observe: (el) => {
			if (!el || el.nodeType !== 1) throw new TypeError("observe: not an Element");
			observed.push(el);
		},
		unobserve: () => {},
		disconnect: () => {},
	});
	const entered = [];
	koine.observeSegments(segs, {
		onEnter: (seg) => { entered.push(seg); },
		makeObserver,
		eagerBudget: 0,       // 關掉載入即發，入列只可能來自觀察解析這條路
		measure: () => 0,
	});

	await new Promise((r) => setTimeout(r, 0)); // onEnter 走 promise 鏈、跨一個 macrotask 才結算

	assert.deepEqual(observed, [host], "shadow 錨觀察宿主元素、fragment 錨不觀察");
	assert.deepEqual(entered.map((s) => s.anchor.block === frag), [true],
		"沒有代理可觀察的段要立即入列（detached 容器永遠不會進場）");
});

// ---------------------------------------------------------------------------
// C8 / C9 / C10：容器錨的插回模式、自吞、根閘
// ---------------------------------------------------------------------------

test("C8 容器錨的 insertMode 恆為並列：簡中頁的漢字 run 也不得就地換字", () => {
	const doc = docFrom(`<div id="host"></div>`, ` lang="zh-CN"`);
	const root = attachShadow(doc, `这是一段简体中文的内容 <i>行内</i>`);
	const segs = collectFrom(root, { targetLang: "zh-TW" });
	assert.equal(segs.length, 1);
	assert.equal(segs[0].anchor.insertMode, "after-segment",
		"容器沒有可寫的屬性與 textContent 邊界，就地換字軸結構上不適用");
	assert.notEqual(segs[0].kind, "fragment", "也不得碎片化");
});

test("C9 容器根二次走訪不自吞：插回後重採，段數不變、原文不含譯文", () => {
	const doc = docFrom(`<div id="host"></div>`);
	const root = attachShadow(doc, `Shadow bare <i>inline</i><p>Shadow para here.</p>`);
	const first = draftPending(collectFrom(root));
	assert.equal(first.length, 2, "前提：第一輪真的採到段（零段時本條無內容）");
	assert.equal(koine.insertTranslations(first).length, 2, "前提：譯文真的插回去了");

	const second = collectFrom(root, { walkId: 2 });
	assert.equal(second.length, first.length, "重採段數不得增加");
	const leaked = second.filter((s) => s.source.includes("譯‹"));
	assert.equal(leaked.length, 0, "譯文 wrapper 不得被當成新原文採回來");
});

test("C10 根閘不受容器放行影響：`<article translate=no>` 為根仍 0 段", () => {
	const doc = docFrom(`<article translate="no"><p>Text inside a no-translate article.</p></article>`);
	assert.equal(collectFrom(doc.querySelector("article")).length, 0,
		"根自身的剪枝訊號照舊整棵不採（豁免只及頁面根與容器）");
});
