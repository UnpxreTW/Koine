// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：§P5 純連結 run 拆單元。
//
// 導覽列常寫成「一個 block 裡並排幾個短連結」（`<p><a>Blog</a><br><a>Archives</a>…</p>`）。
// 整段採集把它們併成一段，譯文只能以單一 wrapper 掛在該 block 之後——原本一項一個連結的形狀
// 變成一整條不可點的文字。拆單元讓每個 `<a>` 各自成段、各自當自己的 anchor，短連結因此走得到
// 就地換字（`<a>` 與 `href` 都留著、仍可點）。
//
// 本檔的兩面都要釘：**該拆的拆**（run 全是連結與分隔物）、**不該拆的一個字都不動**
// （prose 裡的連結、單一連結的 block、run 裡混了其他元素）。後者是這條路最大的風險——
// 把一句話按連結切開會壞語序，正是碎片軸刻意不做的事。

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

// ---------------------------------------------------------------------------
// L1 / L2：該拆的形狀
// ---------------------------------------------------------------------------

test("L1 `<br>` 分隔的四個短連結各自成段，anchor 是自己的 `<a>`、走就地換字", () => {
	// 實測樣本：mjtsai.com/blog 左欄（一個 `<p>` 內四個短 `<a>` 以 `<br>` 分隔）。
	const doc = docFrom(`<div id="navbar"><p>`
		+ `<a href="/blog/">Blog</a> <br />`
		+ `<a href="/blog/archives/">Archives</a> <br />`
		+ `<a href="/blog/tag-cloud/">Tag Cloud</a> <br />`
		+ `<a href="/blog/tag/top-posts/">Top Posts</a>`
		+ `</p></div>`);
	const segs = collectFrom(doc);
	const anchors = [...doc.querySelectorAll("a")];

	assert.deepEqual(segs.map((s) => s.source), ["Blog", "Archives", "Tag Cloud", "Top Posts"]);
	assert.deepEqual(segs.map((s) => s.order), [0, 1, 2, 3], "order 仍是文件序、連號");
	for (const [i, seg] of segs.entries()) {
		assertSame(seg.anchor.block, anchors[i], `第 ${i + 1} 段的 anchor 應是對應的 <a>`);
		assert.equal(seg.anchor.insertMode, "replace", "短連結走就地換字");
		assert.equal(seg.kind, "button", "拆出的連結單元歸 button-class 這一類");
	}
});

test("L2 `·` 這類只有標點的文字節點同樣算分隔物（沿用 §4 的 RE_PUNCT_ONLY）", () => {
	const doc = docFrom(`<p><a href="/rss">RSS Feed</a> &middot; <a href="/x">Twitter</a></p>`);
	const segs = collectFrom(doc);
	assert.deepEqual(segs.map((s) => s.source), ["RSS Feed", "Twitter"]);
	assert.deepEqual(segs.map((s) => s.anchor.insertMode), ["replace", "replace"]);
});

// ---------------------------------------------------------------------------
// L3–L6：不該拆的形狀（負面集；改動前後逐項同值）
// ---------------------------------------------------------------------------

test("L3 prose 裡的連結不拆：整段仍一段、anchor 仍是 block", () => {
	const doc = docFrom(`<p>Click <a href="#">this link</a> here.</p>`);
	const segs = collectFrom(doc);
	assert.equal(segs.length, 1);
	assert.equal(segs[0].source, "Click this link here.");
	assertSame(segs[0].anchor.block, doc.querySelector("p"), "anchor 仍是 <p>");
	assert.equal(segs[0].anchor.insertMode, "after-segment");
});

test("L4 連結之間夾實質文字 ⇒ 不拆（判準是「除連結外只有分隔物」、不是「有連結就拆」）", () => {
	const doc = docFrom(`<p><a href="#">Blog</a> and <a href="#">Archives</a></p>`);
	const segs = collectFrom(doc);
	assert.equal(segs.length, 1, "夾了 and 就不是純連結 run");
	assert.equal(segs[0].source, "Blog and Archives");
	assertSame(segs[0].anchor.block, doc.querySelector("p"));
});

test("L5 單一連結的 block 不拆：段數與 anchor 與改動前同值（≥2 才拆）", () => {
	// 拆了段數不變、唯一差別是 anchor 從 block 換成 `<a>`——那會改動既有頁面的插回落點，
	// 而好處只在導覽列那種語境成立（該路要的是「`<nav>` 內單一連結」這個另一個條件）。
	const doc = docFrom(`<li><a href="/main">Main page</a></li>`);
	const segs = collectFrom(doc);
	assert.equal(segs.length, 1);
	assertSame(segs[0].anchor.block, doc.querySelector("li"), "anchor 仍是 <li>、不是 <a>");
	assert.equal(segs[0].anchor.insertMode, "after-segment");
});

test("L6 run 裡混了其他元素 ⇒ 不拆（`<code>` 是不可分割原子、不是分隔物）", () => {
	const doc = docFrom(`<p><a href="#">Blog</a> <code>npm</code> <a href="#">Archives</a></p>`);
	const segs = collectFrom(doc);
	assert.equal(segs.length, 1);
	assertSame(segs[0].anchor.block, doc.querySelector("p"));
});

test("L12 jump target `<a id=\"top\"></a>` 不計入 ≥2 門檻：仍是「單一連結的 block」、一個字都不動", () => {
	// 無文字的 `<a>` 成不了段（`source === ""` 早退），算進門檻只會讓 L5 那條排除項被繞過：
	// anchor 會從 `<li>` 漂到 `<a>`、插回模式由並列變成破壞性的就地換字。
	const doc = docFrom(`<li><a id="top"></a><a href="/main">Main page</a></li>`);
	const segs = collectFrom(doc);
	assert.equal(segs.length, 1, "有實質文字的連結只有一個 ⇒ 不拆");
	assert.equal(segs[0].source, "Main page");
	assertSame(segs[0].anchor.block, doc.querySelector("li"), "anchor 仍是 <li>、不是 <a>");
	assert.equal(segs[0].anchor.insertMode, "after-segment", "不得變成 replace（破壞性寫入）");
});

test("L13 只包 icon 的 `<a><img></a>` 同樣不計入門檻（側欄／頁腳最常見的形）", () => {
	const doc = docFrom(`<li><a href="/rss"><img src="/i.png"></a><a href="/main">Main page</a></li>`);
	const segs = collectFrom(doc);
	const texts = segs.filter((s) => s.kind !== "attribute");
	assert.equal(texts.length, 1, "icon 連結無文字 ⇒ 有實質文字者只剩一個 ⇒ 不拆");
	assertSame(texts[0].anchor.block, doc.querySelector("li"), "anchor 仍是 <li>");
	assert.equal(texts[0].anchor.insertMode, "after-segment");
});

test("L15 文字藏在被過濾子樹裡的 icon 連結同樣不計入門檻（門檻與 `source` 走同一條路）", () => {
	// L12／L13 只覆蓋 `textContent` 就是空的 icon；無障礙 icon 更常見的寫法是把文字藏在
	// 會被 §3 濾掉的子樹裡，那時 `textContent` 非空而 `source` 為空。門檻若自己用 `textContent`
	// 判，這類連結會被計進 ≥2、而它成不了段 ⇒ 只有一個真連結的 block 照樣被拆，anchor 由 `<li>`
	// 漂到 `<a>`、插回模式由並列變成破壞性的就地換字（原文會被譯文覆蓋掉）。
	const icons = {
		"sr-only class": `<span class="sr-only">RSS</span>`,
		"visually-hidden class": `<span class="visually-hidden">RSS</span>`,
		"svg title": `<svg><title>Twitter</title></svg>`,
		"aria-hidden": `<span aria-hidden="true">Twitter</span>`,
		'translate="no"': `<span translate="no">Twitter</span>`,
	};
	for (const [name, inner] of Object.entries(icons)) {
		const doc = docFrom(`<li><a href="/rss">${inner}</a><a href="/main">Main page</a></li>`);
		const segs = collectFrom(doc).filter((s) => s.kind !== "attribute");
		assert.equal(segs.length, 1, `${name}：有實質文字的連結只剩一個 ⇒ 不拆`);
		assert.equal(segs[0].source, "Main page", `${name}：段的原文是真連結那一條`);
		assertSame(segs[0].anchor.block, doc.querySelector("li"), `${name}：anchor 仍是 <li>`);
		assert.equal(segs[0].anchor.insertMode, "after-segment", `${name}：不得變成 replace`);
	}
});

test("L16 過濾後仍有文字的連結照樣計入：兩條真連結不因新門檻被誤濾（反向守衛）", () => {
	// L15 的濾法若下手過重（例如整個 `<a>` 有元素子代就不算），導覽列最常見的
	// `<a><span>Main page</span></a>` 會整批不再拆單元。此條與 L8 一起把兩個方向都夾住。
	const doc = docFrom(`<p><a href="/a"><span>Blog</span></a><br />`
		+ `<a href="/b"><span class="sr-only">icon</span><span>Archives</span></a></p>`);
	const segs = collectFrom(doc);
	assert.deepEqual(segs.map((s) => s.source), ["Blog", "Archives"], "兩條都算有實質文字 ⇒ 照拆");
	assert.equal(segs[1].source, "Archives", "被濾掉的 sr-only 文字不進 source");
});

// ---------------------------------------------------------------------------
// L14：拆出的單元 region 沿用所在 block
// ---------------------------------------------------------------------------

test("L14 拆出的單元 region 沿用所在 block、不由 `<a>` 自己重算", () => {
	// `heuristicRegion` 的連結密度算的是**子代**連結，anchor 自己是 `<a>` 時 linkLen 恆為 0 ⇒
	// 導覽列賴以判 CHROME 的那道密度訊號永不觸發。連結各 43 字（不落 `len < 40` 那條 +1）、無
	// landmark 也無 class/id hint：拆前整個 div 密度 86／89 → CHROME，拆後每個單元若自己重算就會
	// 翻成 MAIN（rootMargin 400px→1200px、且吃 eager main 預算，導覽列搶在正文之前取譯）。
	const label = (n) => `Navigation destination label number ${n} there`;
	assert.equal(label(1).length, 43, "前提：每條連結都在 40 字以上（不吃 heuristic 的短文 +1）");
	const run = `<a href="/a">${label(1)}</a> | <a href="/b">${label(2)}</a>`;

	const bare = collectFrom(docFrom(`<div>${run}</div>`));
	assert.equal(bare.length, 2, "前提：這個 run 真的拆成兩段");
	assert.deepEqual(
		bare.map((s) => s.region), [koine.Region.CHROME, koine.Region.CHROME],
		"無 landmark：沿用整個 div 的 link-density 判定（CHROME）",
	);

	// landmark 對照：同一個 run 放進 <nav> 與 <main>，region 隨所在 landmark 走、不隨拆單元變。
	const inNav = collectFrom(docFrom(`<nav>${run}</nav>`));
	assert.deepEqual(inNav.map((s) => s.region), [koine.Region.CHROME, koine.Region.CHROME]);
	const inMain = collectFrom(docFrom(`<main>${run}</main>`));
	assert.deepEqual(inMain.map((s) => s.region), [koine.Region.MAIN, koine.Region.MAIN]);
});

// ---------------------------------------------------------------------------
// L7 / L8：拆出來的單元各自過 §P4 的其餘三道閘
// ---------------------------------------------------------------------------

test("L7 超過長度閘的連結退回並列、短的照舊就地換字（同一個 run 內兩種模式並存）", () => {
	const long = "A navigation label well past the gate";
	assert.ok(long.length > koine.BUTTON_CLASS_MAX_CHARS, "前提：這條真的超過長度閘");
	const doc = docFrom(`<p><a href="#">${long}</a><br /><a href="#">Short</a></p>`);
	const segs = collectFrom(doc);
	const anchors = [...doc.querySelectorAll("a")];

	assert.equal(segs.length, 2, "仍逐連結各一段");
	assertSame(segs[0].anchor.block, anchors[0]);
	assert.equal(segs[0].anchor.insertMode, "after-segment", "長連結退回並列");
	assert.notEqual(segs[0].kind, "button", "退回並列者不歸 button-class");
	assert.equal(segs[1].anchor.insertMode, "replace", "短連結不受同伴影響");
});

test("L8 帶元素子代的連結不就地換字：`<a><span>…</span></a>` 退回並列（本支不做透明包裝）", () => {
	// 維基百科側欄的形狀（`<a><span>Main page</span></a>`）。就地換字用 textContent 整個覆寫、
	// 會連帶砍掉那顆 `<span>`，故照 §P4 的「只有純文字子代」一律退回並列。要支援得讓寫入目標
	// 下探到包裝內的文字節點，那是 render 契約的新面、另案。
	const doc = docFrom(`<p><a href="/a"><span>Main page</span></a><br /><a href="/b"><span>Contents</span></a></p>`);
	const segs = collectFrom(doc);
	assert.equal(segs.length, 2, "仍逐連結各一段（拆單元與能不能就地換字是兩件事）");
	assert.deepEqual(segs.map((s) => s.anchor.insertMode), ["after-segment", "after-segment"]);
});

// ---------------------------------------------------------------------------
// L9 / L10：render 面與二次採集
// ---------------------------------------------------------------------------

test("L9 插回：短連結就地換字、`<a>` 與 href 都留著；長連結的 wrapper 落在自己的連結之後", () => {
	const long = "A navigation label well past the gate";
	const doc = docFrom(`<p><a href="/blog">Blog</a><br /><a href="/long">${long}</a></p>`);
	const segs = draftPending(collectFrom(doc));
	assert.equal(segs.length, 2);

	const inserted = koine.insertTranslations(segs);
	assert.equal(inserted.length, 2, "兩段都要有產出（不得靜默丟失）");

	const a0 = doc.querySelector(`a[href="/blog"]`);
	assert.equal(a0.tagName, "A", "就地換字不得換掉元素本身");
	assert.equal(a0.getAttribute("href"), "/blog", "href 不得動");
	assert.equal(a0.textContent, "譯‹Blog›", "文字換成譯文");
	assert.equal(a0.getAttribute("data-koine-original"), "Blog", "原文逐字備份在 data 屬性");

	const a1 = doc.querySelector(`a[href="/long"]`);
	assertSame(a1.nextSibling, inserted[1], "長連結的 wrapper 緊接在它自己之後、不是整個 <p> 之後");
	assert.equal(a1.textContent, long, "並列插回不動原文");
});

test("L10 二次採集不自吞：插回後重採段數不變、譯文不被當新原文採回", () => {
	const doc = docFrom(`<p><a href="/a">Blog</a><br /><a href="/b">Archives</a></p>`);
	const first = draftPending(collectFrom(doc));
	assert.equal(first.length, 2, "前提：第一輪真的採到兩段");
	assert.equal(koine.insertTranslations(first).length, 2, "前提：譯文真的寫回去了");

	const second = collectFrom(doc, { walkId: 2 });
	assert.equal(second.length, 0, "兩顆連結都已標記已譯 ⇒ 重採零段");
	assert.equal(second.filter((s) => s.source.includes("譯‹")).length, 0, "譯文不得被採回");
});

// ---------------------------------------------------------------------------
// L11：純函式層（判準本身，與 DOM 走訪解耦）
// ---------------------------------------------------------------------------

test("L11 pureLinkRunLinks：分隔物集合與 ≥2 門檻逐條", () => {
	const doc = docFrom("");
	const mk = (html) => {
		const p = doc.createElement("p");
		p.innerHTML = html;
		return [...p.childNodes];
	};
	const count = (html) => {
		const r = koine.pureLinkRunLinks(mk(html));
		return r ? r.length : null;
	};
	assert.equal(count(`<a>x</a><br><a>y</a>`), 2, "`<br>` 是分隔物");
	assert.equal(count(`<a>x</a> | <a>y</a>`), 2, "純標點文字是分隔物");
	assert.equal(count(`<a>x</a>\n\t<a>y</a>`), 2, "純空白是分隔物");
	assert.equal(count(`<a>x</a>`), null, "只有一個連結 ⇒ 不拆");
	assert.equal(count(`<a></a><a>y</a>`), null, "無文字的連結不計入門檻 ⇒ 只剩一個 ⇒ 不拆");
	assert.equal(count(`<a><img></a><a>y</a>`), null, "只包 icon 的連結同樣不計入");
	assert.equal(count(`<a>|</a><a>y</a>`), null, "文字只有標點的連結同樣不計入");
	assert.equal(count(`<a>x</a><a></a><a>y</a>`), 2, "無文字者視同分隔物、不擋下有文字的那兩個");
	assert.equal(count(`<a>x</a> and <a>y</a>`), null, "實質文字 ⇒ 不拆");
	assert.equal(count(`<a>x</a><span>y</span><a>z</a>`), null, "其他元素 ⇒ 不拆");
	assert.equal(count(`plain text only`), null, "沒有連結 ⇒ 不拆");

	// labelOf：門檻與 `makeSegmentFromBuffer` 同路的那一層。傳進來的過濾結果會讓文字藏在
	// 被濾子樹裡的連結不計入門檻（DOM 面見 L15）；不傳則整條過濾不套用，門檻等同未過濾文字。
	const withLabel = (html, skipTag) => {
		const buf = mk(html);
		const labelOf = (n) => ({
			disp: n.nodeType === 1 && n.tagName === skipTag ? "SKIP_SUBTREE" : "WALK",
		});
		const r = koine.pureLinkRunLinks(buf, labelOf);
		return r ? r.length : null;
	};
	assert.equal(
		withLabel(`<a><i>RSS</i></a><a>Main page</a>`, "I"), null,
		"labelOf 濾掉唯一文字子樹 ⇒ 該連結不計入 ⇒ 只剩一個 ⇒ 不拆",
	);
	assert.equal(
		withLabel(`<a><i>RSS</i></a><a>Main page</a>`, "B"), 2,
		"同一份 markup、過濾不命中 ⇒ 兩條都算有實質文字",
	);
});
