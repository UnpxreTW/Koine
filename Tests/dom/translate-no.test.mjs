// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：§3.5 translate="no" 護欄門檻特徵化測試。
//
// golden fixture 12/13 只能證明「這兩份 HTML 產幾段」——13 翻面後期望值是空陣列，而空陣列
// 也是「採集器整個壞掉」的產物，鑑別力不足。本檔直接對 classifyNode 逐標籤斷言降級集合的邊界：
// 只有整站級 BODY 降級不尊重，MAIN／ARTICLE／SECTION 與其餘元素一律尊重。
// 把 BODY 從降級集合拿掉、或把 MAIN／ARTICLE／SECTION 加回去，本檔都會紅。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { koine, collect, stubGetStyle } from "./helpers.mjs";

function docFrom(bodyHtml) {
	const { document } = parseHTML(`<!doctype html><html><body>${bodyHtml}</body></html>`);
	return document;
}

function dispOf(el) {
	const ctx = koine.makeContext({ getStyle: stubGetStyle });
	return koine.classifyNode(el, ctx).disp;
}

test("降級集合只留整站級 BODY：body 上的 translate=no 仍視為框架誤標、續走訪", () => {
	// BODY 是 collectSegments 的預設 root。collectSegments 有一道 root 閘（root 的 disp 非 WALK
	// 就整棵不採），所以 BODY 留在降級集合裡是這條路徑成立的必要條件——見下一個測試的反向釘子。
	const doc = docFrom(`<p>Framework mislabel, still translated.</p>`);
	doc.body.setAttribute("translate", "no");
	assert.equal(dispOf(doc.body), "WALK", "body 的 translate=no 應降級不尊重");
	const segs = collect(doc);
	assert.equal(segs.length, 1, "body 降級後內文應照常採集");
	assert.equal(segs[0].source, "Framework mislabel, still translated.");
});

test("MAIN／ARTICLE／SECTION 上的 translate=no 一律尊重（站台意圖優先於救誤標）", () => {
	for (const tag of ["main", "article", "section"]) {
		const doc = docFrom(`<${tag} id="t"><p>Site said do not translate.</p></${tag}>`);
		const el = doc.getElementById("t");
		el.setAttribute("translate", "no");
		assert.equal(dispOf(el), "SKIP_SUBTREE", `<${tag} translate="no"> 應尊重、整棵跳`);
		assert.equal(collect(doc).length, 0, `<${tag} translate="no"> 底下不應產段`);
	}
});

test("一般元素（div／p／span）上的 translate=no 尊重（原本即如此、不受門檻收緊影響）", () => {
	for (const tag of ["div", "p", "span"]) {
		const doc = docFrom(`<${tag} id="t">Do not translate this.</${tag}>`);
		const el = doc.getElementById("t");
		el.setAttribute("translate", "no");
		assert.equal(dispOf(el), "SKIP_SUBTREE", `<${tag} translate="no"> 應尊重、整棵跳`);
	}
});

test(".notranslate class 與 translate=no 同一條路徑：門檻收緊後 article 上的 class 也尊重", () => {
	const doc = docFrom(`<article id="t" class="notranslate"><p>Do not translate.</p></article>`);
	assert.equal(dispOf(doc.getElementById("t")), "SKIP_SUBTREE");
	assert.equal(collect(doc).length, 0);
});

test("尊重範圍限於該子樹：article 標 no、兄弟段照常採集", () => {
	const doc = docFrom(`<article id="t" translate="no"><p>Skip me.</p></article><p>Translate me.</p>`);
	const segs = collect(doc);
	assert.equal(segs.length, 1, "只有 article 子樹被跳過");
	assert.equal(segs[0].source, "Translate me.");
});

test("translate 屬性只認 no：translate=\"yes\" 與空值皆不觸發跳過", () => {
	const doc = docFrom(`<article id="y" translate="yes"><p>Yes please.</p></article>`
		+ `<article id="e" translate=""><p>Empty value.</p></article>`);
	assert.equal(dispOf(doc.getElementById("y")), "WALK", 'translate="yes" 不應跳過');
	assert.equal(dispOf(doc.getElementById("e")), "WALK", 'translate="" 不應跳過（只認字面 no）');
	assert.equal(collect(doc).length, 2);
});

test("root 閘：root 自身即 SKIP_SUBTREE 時整棵不採（子代不落防禦路徑被重判成 WALK）", () => {
	// collect(root) 不看 root 自己的 disp 的話，子代根本沒進 labels（visit 在 SKIP_SUBTREE root
	// 即 return），會全落 classifyLabel 防禦路徑重判成 WALK——root 的處置被靜默吃掉。
	// 生產路徑 root 恆為 body（且 BODY 在降級集合裡）故現況不變，但以子樹為 root 呼叫時要成立。
	const doc = docFrom(`<article id="t" translate="no"><p>Skip the whole subtree.</p></article>`);
	const ctx = koine.makeContext({ getStyle: stubGetStyle });
	const article = doc.getElementById("t");
	assert.equal(koine.classifyNode(article, ctx).disp, "SKIP_SUBTREE");
	assert.equal(
		koine.collectSegments(article, ctx, { walkId: 1 }).length, 0,
		"以該 article 為 root 呼叫時應 0 段",
	);
	// 對照：同一棵樹以 body 為 root（body 未標 no）→ article 子樹被跳過、其餘照採。
	assert.equal(collect(doc).length, 0, "以 body 為 root 時 article 子樹同樣被跳過");
});
