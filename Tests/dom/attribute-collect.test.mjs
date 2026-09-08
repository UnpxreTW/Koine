// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：可見屬性文字（alt／placeholder／按鈕型 value）的採集與原地覆寫。
// 這批標籤（IMG／AREA／INPUT／TEXTAREA）在 SKIP_SUBTREE_TAGS 裡、沒有可採集的子文字，
// 屬性上的字卻是使用者讀得到的介面文字——整頁翻完後仍是原文即為可見漏譯。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { koine, collect } from "./helpers.mjs";

function docFrom(bodyHtml) {
	const { document } = parseHTML(`<!doctype html><html><body>${bodyHtml}</body></html>`);
	return document;
}

const DRAFT = (s) => `譯‹${s.source}›`;

/** 採集 → 填假譯文 → 插回（render 只消費 drafted）。 */
function translateOnce(doc, opts = {}) {
	const segs = collect(doc, opts);
	for (const s of segs) {
		if (s.state === koine.SegmentState.PENDING) {
			s.draft = DRAFT(s);
			s.state = koine.SegmentState.DRAFTED;
		}
	}
	koine.insertTranslations(segs);
	return segs;
}

/** 只留屬性段，方便逐條斷言。 */
function attrSegs(segs) {
	return segs.filter((s) => s.anchor && s.anchor.insertMode === "replace-attr");
}

// ---------------------------------------------------------------------------
// 採集：白名單命中
// ---------------------------------------------------------------------------

test("img 的 alt 成為一段，錨帶屬性名、kind = attribute", () => {
	const segs = attrSegs(collect(docFrom(`<img src="a.png" alt="A cat sleeping">`)));
	assert.equal(segs.length, 1);
	assert.equal(segs[0].source, "A cat sleeping");
	assert.equal(segs[0].kind, "attribute");
	assert.equal(segs[0].anchor.attr, "alt");
	assert.equal(segs[0].anchor.block.tagName, "IMG");
	assert.equal(segs[0].state, koine.SegmentState.PENDING);
	assert.equal(segs[0].meta.replaceSnapshot, "A cat sleeping");
});

test("input 的 placeholder 與 textarea 的 placeholder 都採得到", () => {
	const doc = docFrom(`<input type="search" placeholder="Search docs"><textarea placeholder="Leave a note"></textarea>`);
	const sources = attrSegs(collect(doc)).map((s) => s.source);
	assert.deepEqual(sources, ["Search docs", "Leave a note"]);
});

test("value 只在按鈕型 input 上採：submit 採、text 不採", () => {
	const doc = docFrom(`<input type="submit" value="Send now"><input type="text" value="Ada Lovelace">`);
	const segs = attrSegs(collect(doc));
	assert.deepEqual(segs.map((s) => s.source), ["Send now"]);
	assert.equal(segs[0].anchor.attr, "value");
});

test("具名 submit 的 value 不採：它會跟著表單送出", () => {
	const doc = docFrom(`<form><input type="submit" name="commit" value="Save"><input type="submit" value="Send now"></form>`);
	const segs = attrSegs(translateOnce(doc));
	assert.deepEqual(segs.map((s) => s.source), ["Send now"]);
	// 整輪跑完後具名 submit 的送出值必須逐字不動、也不得留下任何我方標記。
	const named = doc.querySelector(`input[name="commit"]`);
	assert.equal(named.getAttribute("value"), "Save");
	assert.equal(named.hasAttribute("data-koine-translated-value"), false);
	assert.equal(named.hasAttribute("data-koine-original-value"), false);
});

test("submit 的 name 為空字串時照採：空 name 的欄位不進 form data set", () => {
	const doc = docFrom(`<form><input type="submit" name="" value="Continue"></form>`);
	const segs = attrSegs(collect(doc));
	assert.deepEqual(segs.map((s) => s.source), ["Continue"]);
});

test("具名的 button／reset 照採：這兩型從不參與送出", () => {
	const doc = docFrom(`<form><input type="button" name="a" value="Show more"><input type="reset" name="b" value="Clear"></form>`);
	const segs = attrSegs(collect(doc));
	assert.deepEqual(segs.map((s) => s.source), ["Show more", "Clear"]);
});

test("alt 只在 type=image 的 input 上採", () => {
	const yes = attrSegs(collect(docFrom(`<input type="image" alt="Submit form">`)));
	assert.deepEqual(yes.map((s) => s.anchor.attr), ["alt"]);
	const no = attrSegs(collect(docFrom(`<input type="checkbox" alt="Submit form">`)));
	assert.equal(no.length, 0);
});

test("白名單依 type 收窄：圖片按鈕只收 alt，不順手收上面的 placeholder", () => {
	const segs = attrSegs(collect(docFrom(`<input type="image" alt="Upload avatar" placeholder="Never shown">`)));
	assert.deepEqual(segs.map((s) => s.anchor.attr), ["alt"]);
});

// ---------------------------------------------------------------------------
// 判準：極短門檻只治段落單位
// ---------------------------------------------------------------------------

test("單字母屬性照譯——段落的極短門檻不套用在屬性上", () => {
	const segs = attrSegs(collect(docFrom(`<input type="submit" value="Q">`)));
	assert.equal(segs.length, 1);
	assert.equal(segs[0].state, koine.SegmentState.PENDING);
	// 同一個字串走段落單位會被 min-length 判掉，兩種單位的差別就在這一條。
	assert.equal(koine.worthTranslating("Q").reason, "min-length");
	assert.equal(koine.worthTranslating("Q", { unit: "attribute" }).worth, true);
});

test("URL／純數字類屬性仍被判掉——其餘九條規則不分單位照套", () => {
	const doc = docFrom(`<img alt="https://example.com/a.png"><input type="submit" value="2026">`);
	const segs = attrSegs(collect(doc));
	assert.deepEqual(segs.map((s) => s.state), [koine.SegmentState.SKIPPED, koine.SegmentState.SKIPPED]);
	assert.deepEqual(segs.map((s) => s.meta.skipReason), ["url", "numeric"]);
});

test("整頁已是目標語時中文屬性判 already-target", () => {
	const segs = attrSegs(collect(docFrom(`<img alt="一隻睡著的貓">`), { pageLangIsZh: true }));
	assert.equal(segs.length, 1);
	assert.equal(segs[0].meta.skipReason, "already-target");
});

// ---------------------------------------------------------------------------
// 剪枝：自身訊號與祖先訊號都要擋住
// ---------------------------------------------------------------------------

test("hidden／aria-hidden／translate=no／display:none 的元素一個屬性都不採", () => {
	// 末尾那顆是對照組：同一份輸入裡必須恰好採到它一個，否則「什麼都沒採到」也會讓本條過。
	const doc = docFrom([
		`<img hidden alt="Hidden art">`,
		`<img aria-hidden="true" alt="Decorative art">`,
		`<input type="search" translate="no" placeholder="Query string">`,
		`<input type="search" data-d="none" placeholder="Invisible box">`,
		`<img alt="Visible art">`,
	].join(""));
	assert.deepEqual(attrSegs(collect(doc)).map((s) => s.source), ["Visible art"]);
});

test("祖先落 SKIP_SUBTREE 時子代的屬性一併不採", () => {
	const doc = docFrom(`<div hidden><img alt="Inside hidden block"></div><img alt="Visible art">`);
	assert.deepEqual(attrSegs(collect(doc)).map((s) => s.source), ["Visible art"]);
});

test("自身 lang 已是目標語的元素不採其屬性", () => {
	const doc = docFrom(`<img lang="zh-TW" alt="一隻睡著的貓"><img alt="Visible art">`);
	assert.deepEqual(attrSegs(collect(doc)).map((s) => s.source), ["Visible art"]);
});

// ---------------------------------------------------------------------------
// 與段落軸的關係
// ---------------------------------------------------------------------------

test("屬性段不切段、不影響段落邊界，order 仍連號", () => {
	const doc = docFrom(`<p>First sentence here <img alt="A cat"> second sentence here</p>`);
	const segs = collect(doc);
	assert.deepEqual(segs.map((s) => s.order), segs.map((_, i) => i));
	const texts = segs.filter((s) => s.anchor.insertMode !== "replace-attr").map((s) => s.source);
	assert.deepEqual(texts, ["First sentence here second sentence here"]);
	assert.deepEqual(attrSegs(segs).map((s) => s.source), ["A cat"]);
});

test("行內包裝底下的圖片也採得到——連結包圖是真實頁面最常見的擺法", () => {
	const doc = docFrom(`<p><a href="/"><img alt="Logo mark"></a> Home page link</p>`);
	const segs = collect(doc);
	assert.deepEqual(attrSegs(segs).map((s) => s.source), ["Logo mark"]);
	// 段落文字面不受影響：行內包裝仍整顆併進同一段。
	assert.deepEqual(segs.filter((s) => s.anchor.insertMode !== "replace-attr").map((s) => s.source),
		["Home page link"]);
});

test("行內包裝自己帶剪枝訊號時整棵擋住", () => {
	const doc = docFrom(`<p><span hidden><img alt="Hidden logo"></span> <img alt="Visible art"> Sentence text</p>`);
	assert.deepEqual(attrSegs(collect(doc)).map((s) => s.source), ["Visible art"]);
});

test("不可分割的行內原子底下不下探", () => {
	const doc = docFrom(`<p><code><img alt="Inside code"></code> <img alt="Visible art"> Sentence text</p>`);
	assert.deepEqual(attrSegs(collect(doc)).map((s) => s.source), ["Visible art"]);
});

test("textarea 的使用者輸入仍不外洩——只收 placeholder", () => {
	const doc = docFrom(`<textarea placeholder="Leave a note">LEAKED</textarea>`);
	const sources = collect(doc).map((s) => s.source);
	assert.deepEqual(sources, ["Leave a note"]);
});

// ---------------------------------------------------------------------------
// 插回：原地覆寫與 drift 防呆
// ---------------------------------------------------------------------------

test("插回後屬性換成譯文，原文備份與防自吞標記各留一份", () => {
	const doc = docFrom(`<img id="a" alt="A cat sleeping">`);
	translateOnce(doc);
	const img = doc.getElementById("a");
	assert.equal(img.getAttribute("alt"), "譯‹A cat sleeping›");
	assert.equal(img.getAttribute("data-koine-original-alt"), "A cat sleeping");
	assert.equal(img.getAttribute("data-koine-translated-alt"), "譯‹A cat sleeping›");
});

test("採集後站台換掉屬性值：放棄覆寫、不留標記", () => {
	const doc = docFrom(`<img id="a" alt="A cat sleeping">`);
	const segs = collect(doc);
	assert.deepEqual(attrSegs(segs).map((s) => s.anchor.attr), ["alt"]);
	const img = doc.getElementById("a");
	img.setAttribute("alt", "A dog running");
	for (const s of segs) { s.draft = DRAFT(s); s.state = koine.SegmentState.DRAFTED; }
	koine.insertTranslations(segs);
	assert.equal(img.getAttribute("alt"), "A dog running");
	assert.equal(img.hasAttribute("data-koine-translated-alt"), false);
	assert.equal(img.hasAttribute("data-koine-original-alt"), false);
});

// ---------------------------------------------------------------------------
// 防自吞：逐屬性比對
// ---------------------------------------------------------------------------

test("譯文還在原位：二次採集不重採該屬性（否則自吞）", () => {
	const doc = docFrom(`<img id="a" alt="A cat sleeping">`);
	assert.equal(attrSegs(translateOnce(doc)).length, 1);
	assert.equal(attrSegs(collect(doc)).length, 0);
});

test("站台改掉屬性值：二次採集把新值當未譯內容重新採", () => {
	const doc = docFrom(`<img id="a" alt="A cat sleeping">`);
	translateOnce(doc);
	doc.getElementById("a").setAttribute("alt", "A dog running");
	const again = attrSegs(collect(doc));
	assert.equal(again.length, 1);
	assert.equal(again[0].source, "A dog running");
});

test("標記逐屬性各一份：別的屬性帶標記不影響本屬性採集", () => {
	// alt 掛著（別軸的）標記，placeholder 這一軸從未譯過 ⇒ 仍要採。
	const doc = docFrom(`<input type="search" placeholder="Search docs" data-koine-translated-alt="Upload avatar">`);
	assert.deepEqual(attrSegs(collect(doc)).map((s) => s.anchor.attr), ["placeholder"]);
	// 換成本屬性自己的標記且值相符才跳過。
	const done = docFrom(`<input type="search" placeholder="Search docs" data-koine-translated-placeholder="Search docs">`);
	assert.equal(attrSegs(collect(done)).length, 0);
});

test("屬性軸的標記不會誤觸整棵子樹的剪枝閘", () => {
	const doc = docFrom(`<div><img alt="A cat sleeping"><p>Plain paragraph text</p></div>`);
	translateOnce(doc);
	assert.equal(doc.querySelector("img").getAttribute("alt"), "譯‹A cat sleeping›");
	const second = collect(doc).map((s) => s.source);
	assert.ok(second.includes("Plain paragraph text"), "段落不該因為圖片屬性帶標記而被跳過");
});
