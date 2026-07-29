// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：§9.2 insertMode 特徵化測試 —— replace 的**唯一**擴充點。
//
// 兩條觸發軸走同一條 render 分支：①段的種類（button-class，§P4 已由 button-class.test.mjs
// 覆蓋）②語言對（簡中來源 → 繁中目標）。本檔驗的是「兩軸收斂成同一個 insertMode 鍵、render
// 只看這一個鍵」，以及語言對軸的判定邊界與結構安全前提。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { koine, stubGetStyle } from "./helpers.mjs";

function docFrom(bodyHtml, htmlAttrs = "") {
	const { document } = parseHTML(`<!doctype html><html${htmlAttrs}><body>${bodyHtml}</body></html>`);
	return document;
}

/** 直接建 ctx（helpers.collect 不透 targetLang，語言對軸需要指定目標語）。 */
function collectWith(doc, ctxOpts = {}) {
	const ctx = koine.makeContext({ getStyle: stubGetStyle, pageLangIsZh: false, ...ctxOpts });
	return koine.collectSegments(doc.body, ctx, { walkId: 1 });
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
// 語言對軸：簡中來源 → 繁中目標 = replace
// ---------------------------------------------------------------------------

test("語言對軸：祖先標 lang=zh-CN 的純文字段 → insertMode=replace、kind 非 button", () => {
	const doc = docFrom(`<div lang="zh-CN"><p id="p">这是简体中文段落。</p></div>`);
	const segs = collectWith(doc);
	assert.equal(segs.length, 1);
	assert.ok(segs[0].anchor.block === doc.getElementById("p"), "anchor.block 應為該 p");
	assert.equal(segs[0].anchor.insertMode, "replace", "簡中來源→繁中目標應就地取代、不並排");
	assert.notEqual(segs[0].kind, "button", "語言對軸與段的種類軸互不冒充");
	assert.equal(segs[0].meta.replaceSnapshot, "这是简体中文段落。", "replace 段須帶防呆快照");
});

test("語言對軸：元素自身 lang=zh-Hans 同樣命中（①自身 lang 優先）", () => {
	const doc = docFrom(`<p id="p" lang="zh-Hans">简体段落。</p>`);
	assert.equal(collectWith(doc)[0].anchor.insertMode, "replace");
});

test("語言對軸：頁面級回退（③）—— <html lang=\"zh-CN\"> 底下未標 lang 的段也命中", () => {
	const doc = docFrom(`<p id="p">这是简体中文段落。</p>`, ` lang="zh-CN"`);
	assert.equal(collectWith(doc)[0].anchor.insertMode, "replace");
});

test("最近者勝：簡中頁內標 lang=en 的區塊不走 replace（不是整頁一刀切）", () => {
	const doc = docFrom(`<div lang="en"><p id="p">An English comment section.</p></div>`, ` lang="zh-CN"`);
	const seg = collectWith(doc)[0];
	assert.equal(seg.anchor.insertMode, "after-segment", "英文區塊應照常並列、不就地取代");
});

test("目標語非繁中時語言對不成立：targetLang=en 的簡中段走並列", () => {
	const doc = docFrom(`<p id="p" lang="zh-CN">简体段落。</p>`);
	assert.equal(collectWith(doc, { targetLang: "en" })[0].anchor.insertMode, "after-segment");
});

test("繁中來源不觸發 replace（lang=zh-Hant 整棵跳，本就不產段）", () => {
	const doc = docFrom(`<p id="p" lang="zh-Hant">繁體段落。</p>`);
	assert.equal(collectWith(doc).length, 0, "繁中來源本就整棵跳、不產段");
});

test("②區塊文字內容偵測尚未實作：無任何 lang 標記的簡中文字保守走並列", () => {
	// SPEC §13 #11（逐區塊語言判定）的門檻值／偵測方式／是否引入偵測相依三子題尚未裁定，
	// 故 effectiveLangOf 查不到 lang 就回 null、不猜。此測試是那條界線的釘子：
	// 哪天②落地、本測試會紅，屆時要連同這段說明一起改，而不是默默放寬。
	const doc = docFrom(`<p id="p">这是没有任何语言标记的简体段落。</p>`);
	assert.equal(collectWith(doc)[0].anchor.insertMode, "after-segment");
});

// ---------------------------------------------------------------------------
// 結構安全前提：兩軸共用
// ---------------------------------------------------------------------------

test("結構安全前提：簡中段含元素子代 → 退回 after-segment，原文結構原封不動", () => {
	// 原地換字用 textContent 整個覆寫，會連帶砍掉 <strong>／<a>／icon 等元素子代且無法還原。
	const doc = docFrom(`<div lang="zh-CN"><p id="p">简体<strong id="s">加粗</strong>段落。</p></div>`);
	const segs = collectWith(doc);
	assert.equal(segs.length, 1);
	assert.equal(segs[0].anchor.insertMode, "after-segment", "含元素子代不得就地取代");

	draftPending(segs);
	koine.insertTranslations(segs);
	assert.ok(doc.getElementById("s"), "原文的 <strong> 應原封不動保留");
	assert.equal(
		doc.querySelector(`[data-koine-id="${segs[0].id}"]`).tagName, "DIV",
		"應改走一般 wrapper 插回",
	);
});

// ---------------------------------------------------------------------------
// render 只認 insertMode 這一個鍵
// ---------------------------------------------------------------------------

test("render 分派只看 anchor.insertMode：簡中段原地換字、行為與 button 軸完全一致", () => {
	const doc = docFrom(`<div lang="zh-CN"><p id="p">这是简体中文段落。</p></div>`);
	const segs = draftPending(collectWith(doc));
	const inserted = koine.insertTranslations(segs);
	const p = doc.getElementById("p");

	assert.equal(inserted.length, 1);
	assert.ok(inserted[0] === p, "replace 應回傳原元素本身、非新建 wrapper");
	assert.equal(p.textContent, segs[0].draft, "textContent 應換成譯文");
	assert.equal(p.getAttribute("title"), "这是简体中文段落。", "原文應存 title");
	assert.equal(p.getAttribute("data-koine-original"), "这是简体中文段落。", "原文應存 data-koine-original");
	assert.ok(p.hasAttribute("data-koine-translated"), "缺防自吞標記");
	assert.equal(doc.querySelectorAll(".koine-translated").length, 0, "replace 不應建 wrapper");
});

test("render 分派只看 anchor.insertMode：kind=button 但 insertMode 被改回 after-segment → 走並列", () => {
	// 反向釘子：確認 render 端沒有殘留「看 seg.kind 決定 replace」的第二套判斷。
	const doc = docFrom(`<button id="b">送出</button>`);
	const segs = collectWith(doc);
	assert.equal(segs[0].kind, "button");
	segs[0].anchor.insertMode = "after-segment";
	draftPending(segs);
	koine.insertTranslations(segs);

	const btn = doc.getElementById("b");
	assert.equal(btn.textContent, "送出", "原文不應被覆寫");
	assert.ok(!btn.hasAttribute("data-koine-translated"));
	assert.equal(doc.querySelector(`[data-koine-id="${segs[0].id}"]`).tagName, "DIV");
});

test("replace 段的防呆快照對兩軸一致：插回前文字 drift → 放棄覆寫", () => {
	const doc = docFrom(`<div lang="zh-CN"><p id="p">这是简体中文段落。</p></div>`);
	const segs = draftPending(collectWith(doc));
	const p = doc.getElementById("p");
	p.textContent = "页面自己改掉了";

	const inserted = koine.insertTranslations(segs);
	assert.equal(inserted.length, 0, "文字已 drift、不應覆寫");
	assert.equal(p.textContent, "页面自己改掉了", "應保留當下真實文字");
	assert.ok(!p.hasAttribute("data-koine-translated"));
});

test("自吞防護：replace 過的簡中段再次採集整棵跳過、不產生新段", () => {
	const doc = docFrom(`<div lang="zh-CN"><p id="p">这是简体中文段落。</p></div>`);
	koine.insertTranslations(draftPending(collectWith(doc)));
	assert.equal(collectWith(doc).length, 0, "已標記段應被 classifyNode 自家標記擋下");
});

// ---------------------------------------------------------------------------
// 語言判定純函式邊界
// ---------------------------------------------------------------------------

test("isTraditionalChineseTarget 語碼邊界", () => {
	for (const t of ["zh", "zh-Hant", "zh-TW", "zh-hant-hk"]) {
		assert.equal(koine.isTraditionalChineseTarget(t), true, `${t} 應判為繁中目標`);
	}
	for (const t of ["zh-CN", "zh-Hans", "en", "ja", "", undefined]) {
		assert.equal(koine.isTraditionalChineseTarget(t), false, `${t} 不應判為繁中目標`);
	}
});

test("effectiveLangOf：自身優先於祖先、查無回 null", () => {
	const doc = docFrom(`<div lang="zh-CN"><p id="self" lang="EN "> x </p><p id="inherit">y</p></div>`);
	assert.equal(koine.effectiveLangOf(doc.getElementById("self")), "en", "自身 lang 應勝出、且已小寫 trim");
	assert.equal(koine.effectiveLangOf(doc.getElementById("inherit")), "zh-cn", "無自身 lang 應取最近祖先");

	const bare = docFrom(`<p id="p">z</p>`);
	assert.equal(koine.effectiveLangOf(bare.getElementById("p")), null, "整條祖先鏈無 lang 應回 null");
});

test("isSimplifiedToTraditional：簡中語碼變體全命中、其餘不命中", () => {
	const doc = docFrom(`<p id="p">x</p>`);
	const p = doc.getElementById("p");
	for (const lang of ["zh-CN", "zh-Hans", "zh-Hans-CN"]) {
		p.setAttribute("lang", lang);
		assert.equal(koine.isSimplifiedToTraditional(p, "zh-Hant"), true, `${lang} 應命中`);
	}
	for (const lang of ["zh-TW", "zh-Hant", "en", "ja"]) {
		p.setAttribute("lang", lang);
		assert.equal(koine.isSimplifiedToTraditional(p, "zh-Hant"), false, `${lang} 不應命中`);
	}
});
