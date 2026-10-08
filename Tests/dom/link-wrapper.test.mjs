// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：§P5 連結單元的透明包裝。
//
// 維基百科側欄的形狀是 `<li><a href title><span>Main page</span></a></li>`——連結的文字包在一顆
// `<span>` 裡。原地換字原本以 `textContent` 整個覆寫 anchor，會連帶砍掉這顆包裝，所以這種連結
// 一律退回並列。本檔釘的是寫入目標下探：`replaceWriteTarget` 沿「恰一個元素子代」往內走到只有
// 純文字的那一層，插回只覆寫那一層，`<a>`、`href` 與包裝元素都原樣留著。
//
// 兩面都要釘：**下探得到的換**；**下探不到的（兩個元素子代、夾文字、標籤不在名單）一個字都不動**；
// 以及按鈕軸不因此放寬。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { koine, stubGetStyle, assertSame } from "./helpers.mjs";

function docFrom(bodyHtml) {
	const { document } = parseHTML(`<!doctype html><html><body>${bodyHtml}</body></html>`);
	return document;
}

function collectFrom(doc, ctxOpts = {}) {
	const ctx = koine.makeContext({ getStyle: stubGetStyle, ...ctxOpts });
	return koine.collectSegments(doc.body, ctx, { walkId: ctxOpts.walkId ?? 1 });
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

const SIDEBAR = `<nav><ul>`
	+ `<li><a href="/wiki/Main_Page" title="Visit the main page"><span>Main page</span></a></li>`
	+ `<li><a href="/wiki/Contents"><span>Contents</span></a></li>`
	+ `</ul></nav>`;

// ---------------------------------------------------------------------------
// W1：純函式層
// ---------------------------------------------------------------------------

test("W1 replaceWriteTarget 逐形：下探得到回最內層、下探不到回 null", () => {
	const doc = docFrom(`<div id="root">`
		+ `<a id="plain">Home</a>`
		+ `<a id="span"><span id="span-in">Main page</span></a>`
		+ `<a id="deep"><span><b id="deep-in">Main page</b></span></a>`
		+ `<a id="ws"> <span id="ws-in">Home</span> </a>`
		+ `<a id="two"><span class="sr-only">icon</span><span>Main page</span></a>`
		+ `<a id="mixed">Go <span>home</span></a>`
		+ `<a id="code"><code>npm</code></a>`
		+ `<a id="img"><img src="x.png"></a>`
		+ `<a id="icon-in"><span><img src="x.png">Home</span></a>`
		+ `</div>`);
	const byId = (id) => doc.getElementById(id);
	assertSame(koine.replaceWriteTarget(byId("plain")), byId("plain"), "只有純文字子代：自己");
	assertSame(koine.replaceWriteTarget(byId("span")), byId("span-in"), "一層包裝");
	assertSame(koine.replaceWriteTarget(byId("deep")), byId("deep-in"), "多層包裝走到最內層");
	assertSame(koine.replaceWriteTarget(byId("ws")), byId("ws-in"), "包裝旁的純空白不擋");
	assertSame(koine.replaceWriteTarget(byId("two")), null, "兩個元素子代");
	assertSame(koine.replaceWriteTarget(byId("mixed")), null, "元素子代旁夾實質文字");
	assertSame(koine.replaceWriteTarget(byId("code")), null, "不可翻原子不在名單");
	assertSame(koine.replaceWriteTarget(byId("img")), null, "icon 不在名單");
	assertSame(koine.replaceWriteTarget(byId("icon-in")), null, "包裝內又帶 icon");
});

// ---------------------------------------------------------------------------
// W2–W4：側欄形狀的採集、插回與二次採集
// ---------------------------------------------------------------------------

test("W2 側欄形狀：anchor 是 `<a>`、走就地換字、寫入目標記在 anchor 上", () => {
	const doc = docFrom(SIDEBAR);
	const segs = collectFrom(doc).filter((s) => s.kind !== "attribute");
	const anchors = [...doc.querySelectorAll("a")];
	const spans = [...doc.querySelectorAll("span")];
	assert.deepEqual(segs.map((s) => s.source), ["Main page", "Contents"]);
	for (const [i, seg] of segs.entries()) {
		assertSame(seg.anchor.block, anchors[i]);
		assert.equal(seg.anchor.insertMode, "replace");
		assert.equal(seg.kind, "button");
		assertSame(seg.anchor.writeTarget, spans[i]);
		assert.equal(seg.meta.replaceSnapshot, anchors[i].textContent, "快照仍是 anchor 的逐字 textContent");
	}
});

test("W3 插回：只覆寫包裝內的文字，`<a>`、`href`、`<span>` 都留著，原文與標記記在 `<a>` 上", () => {
	const doc = docFrom(SIDEBAR);
	const segs = draftPending(collectFrom(doc).filter((s) => s.kind !== "attribute"));
	assert.equal(koine.insertTranslations(segs).length, 2, "兩段都要有產出");

	const a = doc.querySelector(`a[href="/wiki/Main_Page"]`);
	assert.equal(a.getAttribute("href"), "/wiki/Main_Page", "href 不得動");
	assert.equal(a.children.length, 1, "包裝元素仍在");
	assert.equal(a.firstElementChild.tagName, "SPAN");
	assert.equal(a.firstElementChild.textContent, "譯‹Main page›", "譯文寫進包裝內");
	assert.equal(a.getAttribute("data-koine-original"), "Main page", "原文逐字備份在 <a>");
	assert.equal(a.getAttribute("data-koine-translated"), "譯‹Main page›", "防自吞標記在 <a>");
	assert.equal(a.firstElementChild.hasAttribute("data-koine-translated"), false, "包裝上不留標記");
	assert.equal(doc.querySelectorAll("li")[0].childNodes.length, 1, "沒有多掛並列 wrapper");
});

test("W4 二次採集不自吞：插回後重採不再產生內文段", () => {
	const doc = docFrom(SIDEBAR);
	const first = draftPending(collectFrom(doc).filter((s) => s.kind !== "attribute"));
	assert.equal(koine.insertTranslations(first).length, 2, "前提：譯文真的寫回去了");
	const second = collectFrom(doc, { walkId: 2 }).filter((s) => s.kind !== "attribute");
	assert.equal(second.length, 0);
});

test("W5 包裝旁有空白：空白原樣留著、二次採集同樣不自吞", () => {
	const doc = docFrom(`<nav><ul><li><a href="/"> <span>Home</span> </a></li></ul></nav>`);
	const segs = draftPending(collectFrom(doc));
	assert.equal(segs.length, 1);
	assert.equal(koine.insertTranslations(segs).length, 1);
	assert.equal(doc.querySelector("a").textContent, " 譯‹Home› ", "包裝外的空白不被吃掉");
	assert.equal(collectFrom(doc, { walkId: 2 }).length, 0);
});

// ---------------------------------------------------------------------------
// W6：插回當下結構變了就放棄
// ---------------------------------------------------------------------------

test("W6 採集與插回之間結構變了：寫入目標換人或下探不到，一個字都不寫、不留標記", () => {
	// 文字一個字都沒變（textContent 快照照樣對得上），只換了結構——只靠快照擋不住。
	const cases = {
		"包裝換成另一顆": (a) => { a.innerHTML = "<b>Main page</b>"; },
		"包裝內多了 icon": (a) => { a.firstElementChild.insertBefore(a.ownerDocument.createElement("img"), a.firstElementChild.firstChild); },
		"包裝被拆掉": (a) => { a.textContent = "Main page"; },
	};
	for (const [name, mutate] of Object.entries(cases)) {
		const doc = docFrom(`<nav><ul><li><a href="/"><span>Main page</span></a></li></ul></nav>`);
		const segs = draftPending(collectFrom(doc));
		const a = doc.querySelector("a");
		mutate(a);
		assert.equal(a.textContent, "Main page", `${name}：前提＝文字沒變`);
		assert.equal(koine.insertTranslations(segs).length, 0, `${name}：放棄覆寫`);
		assert.equal(a.textContent, "Main page", `${name}：原文不動`);
		assert.equal(a.hasAttribute("data-koine-translated"), false, `${name}：不留標記`);
		assert.equal(a.hasAttribute("data-koine-original"), false, `${name}：不留備份`);
	}
});

// ---------------------------------------------------------------------------
// W7–W8：不該換的不動
// ---------------------------------------------------------------------------

test("W7 超過長度閘的包裝連結退回並列、anchor 不記寫入目標", () => {
	const long = "A navigation label well past the gate";
	const doc = docFrom(`<p><a href="/a"><span>${long}</span></a><br /><a href="/b"><span>Short</span></a></p>`);
	const segs = collectFrom(doc);
	assert.equal(segs.length, 2);
	assert.equal(segs[0].anchor.insertMode, "after-segment");
	assertSame(segs[0].anchor.writeTarget, undefined, "不記寫入目標");
	assert.equal(segs[1].anchor.insertMode, "replace", "短的不受同伴影響");
});

test("W8 按鈕軸不放寬：`<button><span>…</span></button>` 維持原判準、不就地換字", () => {
	const doc = docFrom(`<button><span>Save</span></button>`);
	const segs = collectFrom(doc);
	assert.equal(segs.length, 1);
	assert.equal(segs[0].anchor.insertMode, "after-segment");
	assert.notEqual(segs[0].kind, "button");
	assertSame(segs[0].anchor.writeTarget, undefined, "不記寫入目標");
});
