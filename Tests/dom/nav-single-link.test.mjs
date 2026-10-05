// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：§P5 導覽區內的單一連結。
//
// 導覽選單最常見的寫法是一項一個 `<li>`、`<a>` 是 `<li>` 的唯一內容。這種 block 不經過純連結
// run 拆單元（≥2 才拆），整段軸的 anchor 是 `<li>`、而 `<li>` 不是 button-class ⇒ 每一項都在
// 底下多掛一行不可點的譯文。導覽區內的單一連結比照 run 拆出的連結單元走 button-class 判準：
// 過得了就以 `<a>` 當 anchor 就地換字（`href` 留著、仍可點），過不了一個字都不動。
//
// 本檔的兩面都要釘：**導覽區內該換的換**；**導覽區外、或過不了判準的一個字都不動**
// （anchor 仍是 block、插回仍是並列）——後者是既有頁面插回落點的保證。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { koine, stubGetStyle, assertSame } from "./helpers.mjs";

function docFrom(bodyHtml, htmlAttrs = "") {
	const { document } = parseHTML(`<!doctype html><html${htmlAttrs}><body>${bodyHtml}</body></html>`);
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

/** 斷言整份文件的段全都「沒被這條路碰到」：anchor 是 `<li>`、插回是並列。 */
function assertUntouched(doc, segs) {
	const items = [...doc.querySelectorAll("li")];
	assert.equal(segs.length, items.length, "一項一段");
	for (const [i, seg] of segs.entries()) {
		assertSame(seg.anchor.block, items[i], `第 ${i + 1} 段的 anchor 應仍是 <li>`);
		assert.equal(seg.anchor.insertMode, "after-segment");
		assert.equal(seg.kind, undefined, "不歸 button-class");
	}
}

// ---------------------------------------------------------------------------
// N1–N3：該換的形狀
// ---------------------------------------------------------------------------

test("N1 `<nav>` 內一項一個 `<li>` 的短連結：anchor 是 `<a>`、走就地換字、region 仍是 chrome", () => {
	const doc = docFrom(`<nav><ul>`
		+ `<li><a href="/">Home</a></li>`
		+ `<li><a href="/about">About us</a></li>`
		+ `<li><a href="/contact">Contact</a></li>`
		+ `</ul></nav>`);
	const segs = collectFrom(doc);
	const anchors = [...doc.querySelectorAll("a")];

	assert.deepEqual(segs.map((s) => s.source), ["Home", "About us", "Contact"]);
	assert.deepEqual(segs.map((s) => s.order), [0, 1, 2], "order 仍是文件序、連號");
	for (const [i, seg] of segs.entries()) {
		assertSame(seg.anchor.block, anchors[i], `第 ${i + 1} 段的 anchor 應是對應的 <a>`);
		assert.equal(seg.anchor.insertMode, "replace", "短連結走就地換字");
		assert.equal(seg.kind, "button", "與 run 拆出的連結單元同類");
		assert.equal(seg.region, koine.Region.CHROME, "region 沿用所在 block（導覽區＝chrome）");
	}
});

test("N2 `role=\"navigation\"` 的容器與 `<nav>` 同等", () => {
	const doc = docFrom(`<div role="navigation"><ul><li><a href="/">Home</a></li></ul></div>`);
	const segs = collectFrom(doc);
	assert.equal(segs.length, 1);
	assertSame(segs[0].anchor.block, doc.querySelector("a"));
	assert.equal(segs[0].anchor.insertMode, "replace");
});

test("N3 block 本身就是 `<nav>`、或連結夾著空白與分隔標點：仍算唯一內容", () => {
	const self = docFrom(`<nav><a href="/">Home</a></nav>`);
	const s1 = collectFrom(self);
	assert.equal(s1.length, 1);
	assertSame(s1[0].anchor.block, self.querySelector("a"));
	assert.equal(s1[0].anchor.insertMode, "replace");

	const sep = docFrom(`<nav><ul><li> · <a href="/">Home</a> | </li></ul></nav>`);
	const s2 = collectFrom(sep);
	assert.equal(s2.length, 1);
	assertSame(s2[0].anchor.block, sep.querySelector("a"));
	assert.equal(s2[0].source, "Home");
});

test("N4 子選單：上層項目的連結與巢狀清單的連結各自就地換字", () => {
	const doc = docFrom(`<nav><ul><li><a href="/p">Products</a>`
		+ `<ul><li><a href="/p/a">Laptops</a></li><li><a href="/p/b">Phones</a></li></ul>`
		+ `</li></ul></nav>`);
	const segs = collectFrom(doc);
	const anchors = [...doc.querySelectorAll("a")];
	assert.deepEqual(segs.map((s) => s.source), ["Products", "Laptops", "Phones"]);
	for (const [i, seg] of segs.entries()) {
		assertSame(seg.anchor.block, anchors[i]);
		assert.equal(seg.anchor.insertMode, "replace");
	}
});

// ---------------------------------------------------------------------------
// N5–N10：一個字都不動的形狀（導覽區外、或過不了判準）
// ---------------------------------------------------------------------------

test("N5 導覽區外的單一連結不動：無 landmark、頁首、頁尾、側欄、正文", () => {
	for (const wrap of [
		(x) => x,
		(x) => `<header>${x}</header>`,
		(x) => `<footer>${x}</footer>`,
		(x) => `<aside>${x}</aside>`,
		(x) => `<main>${x}</main>`,
		(x) => `<div role="contentinfo">${x}</div>`,
	]) {
		const doc = docFrom(wrap(`<ul><li><a href="/">Home</a></li><li><a href="/x">Privacy</a></li></ul>`));
		assertUntouched(doc, collectFrom(doc));
	}
});

test("N6 最近的 landmark 決定、role 先於 tag", () => {
	// `<nav>` 裡再包一層 `<main>`：最近的是 main ⇒ 不算導覽區。
	const inner = docFrom(`<nav><main><ul><li><a href="/">Home</a></li></ul></main></nav>`);
	assertUntouched(inner, collectFrom(inner));
	// `<main>` 裡的 `<nav>`（文章內目錄）：最近的是 nav ⇒ 算。
	const toc = docFrom(`<main><nav><ul><li><a href="#a">Intro</a></li></ul></nav></main>`);
	const segs = collectFrom(toc);
	assertSame(segs[0].anchor.block, toc.querySelector("a"));
	// `<nav role="main">`：顯式 landmark role 覆蓋 tag ⇒ 不算。
	const roleMain = docFrom(`<nav role="main"><ul><li><a href="/">Home</a></li></ul></nav>`);
	assertUntouched(roleMain, collectFrom(roleMain));
	// `<nav role="list">`：`list` 不是 landmark role、不覆蓋 tag ⇒ 仍算導覽區。
	const roleList = docFrom(`<nav role="list"><ul><li><a href="/">Home</a></li></ul></nav>`);
	assertSame(collectFrom(roleList)[0].anchor.block, roleList.querySelector("a"));
});

test("N7 超過長度閘的連結不動：anchor 不換、並列 wrapper 照舊掛在 block 之後", () => {
	const doc = docFrom(`<nav><ul><li><a href="/x">A navigation label well past the gate</a></li></ul></nav>`);
	assertUntouched(doc, collectFrom(doc));
});

test("N8 帶元素子代的連結不動：`<a><span>…</span></a>`（透明包裝另案）", () => {
	// 維基百科側欄的形狀。就地換字用 textContent 整個覆寫、會連帶砍掉那顆 `<span>`；
	// 換 anchor 又換不到就地換字 ⇒ 唯一效果是挪動並列 wrapper 的落點，故一個字都不動。
	const doc = docFrom(`<nav><ul><li><a href="/"><span>Main page</span></a></li></ul></nav>`);
	assertUntouched(doc, collectFrom(doc));
});

test("N9 不是唯一內容的不動：連結旁有實質文字、或與 icon 連結並排", () => {
	const prose = docFrom(`<nav><ul><li>See <a href="/">Home</a></li></ul></nav>`);
	assertUntouched(prose, collectFrom(prose));
	// icon 連結＋文字連結：形狀上有兩個 `<a>`，不是「唯一內容」；run 拆單元也因只有一個有文字
	// 的連結而不拆 ⇒ 整段一段、anchor 仍是 `<li>`。
	const icon = docFrom(`<nav><ul><li><a href="/rss"><img src="r.png"></a><a href="/">Home</a></li></ul></nav>`);
	assertUntouched(icon, collectFrom(icon));
});

// ---------------------------------------------------------------------------
// N10 / N11：render 面與二次採集
// ---------------------------------------------------------------------------

test("N10 插回：`<a>` 與 href、外層 `<li>` 都留著，原文逐字備份", () => {
	const doc = docFrom(`<nav><ul><li><a href="/about">About us</a></li></ul></nav>`);
	const segs = draftPending(collectFrom(doc));
	assert.equal(koine.insertTranslations(segs).length, 1, "有產出、不得靜默丟失");

	const a = doc.querySelector("a");
	assert.equal(a.getAttribute("href"), "/about", "href 不得動");
	assertSame(a.parentElement, doc.querySelector("li"), "外層 <li> 不得被換掉");
	assert.equal(a.textContent, "譯‹About us›", "文字換成譯文");
	assert.equal(a.getAttribute("data-koine-original"), "About us", "原文逐字備份在 data 屬性");
	assert.equal(doc.querySelector("li").childNodes.length, 1, "沒有多掛並列 wrapper");
});

test("N11 二次採集不自吞：插回後重採零段、譯文不被當新原文採回", () => {
	const doc = docFrom(`<nav><ul><li><a href="/">Home</a></li><li><a href="/b">Blog</a></li></ul></nav>`);
	const first = draftPending(collectFrom(doc));
	assert.equal(koine.insertTranslations(first).length, 2, "前提：譯文真的寫回去了");
	const second = collectFrom(doc, { walkId: 2 });
	assert.equal(second.length, 0);
});

// ---------------------------------------------------------------------------
// N12：純函式層
// ---------------------------------------------------------------------------

test("N12 isInNavigationLandmark／soleNavigationLink 逐條", () => {
	const doc = docFrom(`<nav id="n"><ul><li id="a"><a href="/">Home</a></li>`
		+ `<li id="b"><a href="/x">X</a><a href="/y">Y</a></li>`
		+ `<li id="c"><a id="top"></a></li></ul></nav><p id="p"><a href="/">Home</a></p>`);
	const byId = (id) => doc.getElementById(id);
	assert.equal(koine.isInNavigationLandmark(byId("a")), true);
	assert.equal(koine.isInNavigationLandmark(byId("n")), true, "含自身");
	assert.equal(koine.isInNavigationLandmark(byId("p")), false);

	const li = byId("a");
	assertSame(koine.soleNavigationLink([...li.childNodes], li), li.firstChild);
	const two = byId("b");
	assert.equal(koine.soleNavigationLink([...two.childNodes], two), null, "兩個連結歸 run 拆單元、不歸這條");
	const empty = byId("c");
	assert.equal(koine.soleNavigationLink([...empty.childNodes], empty), null, "無實質文字的連結成不了段");
	const p = byId("p");
	assert.equal(koine.soleNavigationLink([...p.childNodes], p), null, "導覽區外");
});
