// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：`title` 的採集與原地覆寫。`title` 是全域屬性、任何標籤都可能掛，
// 故不進 ATTRIBUTE_TARGETS 那張「標籤 → 屬性」表，宿主資格另有一條（見 GLOBAL_ATTRIBUTE_TARGET）。
// 本檔同時釘住「原文不再寫進 title」——tooltip 現在只承載譯文。

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

/** 只留 `title` 的段，依文件序回傳其 source。 */
function titleSources(segs) {
	return segs.filter((s) => s.anchor && s.anchor.attr === "title").map((s) => s.source);
}

// ---------------------------------------------------------------------------
// 宿主：走訪到的元素
// ---------------------------------------------------------------------------

test("一般 block 元素的 title 自成一段：kind = attribute、錨帶屬性名", () => {
	const segs = collect(docFrom(`<p title="補充說明">Paragraph body text.</p>`));
	const titles = segs.filter((s) => s.anchor.attr === "title");
	assert.equal(titles.length, 1);
	assert.equal(titles[0].source, "補充說明");
	assert.equal(titles[0].kind, "attribute");
	assert.equal(titles[0].anchor.insertMode, "replace-attr");
	assert.equal(titles[0].anchor.block.tagName, "P");
	assert.equal(titles[0].meta.replaceSnapshot, "補充說明");
});

test("行內子樹底下的 title 同樣採得到（<p><a title> 是最常見的擺法）", () => {
	const segs = collect(docFrom(`<p>Read the <a href="/x" title="開啟說明頁">docs</a> first.</p>`));
	assert.deepEqual(titleSources(segs), ["開啟說明頁"]);
});

test("OPAQUE 原子自身的 title 採得到（子樹仍不下探）", () => {
	const segs = collect(docFrom(`<p>Call <code title="這是函式名">fn()</code> now.</p>`));
	assert.deepEqual(titleSources(segs), ["這是函式名"]);
});

test("白名單宿主：alt 與 title 各成一段（同一顆 img 上兩條軸互不吃掉對方）", () => {
	const segs = collect(docFrom(`<img src="a.png" alt="A cat sleeping" title="點圖看大圖">`));
	const byAttr = Object.fromEntries(segs.filter((s) => s.anchor.attr).map((s) => [s.anchor.attr, s.source]));
	assert.deepEqual(byAttr, { alt: "A cat sleeping", title: "點圖看大圖" });
});

test("文字框：title 採、value 不採（value 是使用者資料、翻了就是竄改表單內容）", () => {
	const segs = collect(docFrom(`<input type="text" value="使用者輸入的值" title="請輸入全名">`));
	const attrs = segs.filter((s) => s.anchor.attr).map((s) => s.anchor.attr);
	assert.deepEqual(attrs, ["title"]);
	assert.deepEqual(titleSources(segs), ["請輸入全名"]);
});

test("同一顆元素的 title 只採一次（走訪與行內補走兩條路不得重複產段）", () => {
	const segs = collect(docFrom(`<div title="外層"><p title="內層">Body text here.</p></div>`));
	assert.deepEqual(titleSources(segs), ["外層", "內層"]);
});

test("display:contents 容器自身的 title 採得到（它被攤平、從不出現在採集迴圈裡）", () => {
	const segs = collect(docFrom(`<div data-d="contents" title="穿透容器提示"><p>Body text here.</p></div>`));
	assert.deepEqual(titleSources(segs), ["穿透容器提示"]);
});

test("巢狀 display:contents：每層容器的 title 各採一次、文件序不亂", () => {
	const segs = collect(docFrom(
		`<div data-d="contents" title="外層提示"><span data-d="contents" title="內層提示">Inline text here.</span></div>`,
	));
	assert.deepEqual(titleSources(segs), ["外層提示", "內層提示"]);
});

test("行內子樹裡的 display:contents 容器：採得到且只採一次（補走那條路不得重複產段）", () => {
	const segs = collect(docFrom(
		`<p>Head <span><em data-d="contents" title="行內穿透提示">mid</em></span> tail.</p>`,
	));
	assert.deepEqual(titleSources(segs), ["行內穿透提示"]);
});

// ---------------------------------------------------------------------------
// 宿主資格：不該採的那些
// ---------------------------------------------------------------------------

test("因標籤黑名單整棵跳過、又不是屬性宿主的元素：title 不採", () => {
	// 對照元素不可省：沒有它時「什麼都沒採到」也會讓斷言通過。
	const segs = collect(docFrom(`<script title="腳本提示">var x = 1;</script><p title="可見提示">Body.</p>`));
	assert.deepEqual(titleSources(segs), ["可見提示"]);
});

test("自身剪枝訊號擋下的元素：title 不採（hidden／translate=no／display:none）", () => {
	const segs = collect(docFrom(
		`<p hidden title="隱藏提示">A</p>`
		+ `<p translate="no" title="不譯提示">B</p>`
		+ `<p data-d="none" title="不顯示提示">C</p>`
		+ `<p title="可見提示">D</p>`,
	));
	assert.deepEqual(titleSources(segs), ["可見提示"]);
});

test("自身 lang 已是目標語：title 不採（OPAQUE 的 [8] 補檢）", () => {
	const segs = collect(docFrom(
		`<p>Call <code lang="zh-TW" title="已是繁中提示">fn()</code> now.</p>`
		+ `<p>Call <code title="待譯提示">fn2()</code> now.</p>`,
	));
	assert.deepEqual(titleSources(segs), ["待譯提示"]);
});

test("我方建的 wrapper 不採其 title（自家節點恆跳）", () => {
	const doc = docFrom(`<p>This paragraph is long enough to take the ordinary wrapper path.</p>`);
	const inserted = translateOnce(doc);
	assert.equal(inserted.length > 0, true, "前提：應已建 wrapper");
	doc.querySelector(".koine-translated").setAttribute("title", "wrapper 的提示");
	assert.deepEqual(titleSources(collect(doc)), []);
});

// ---------------------------------------------------------------------------
// 插回與防自吞
// ---------------------------------------------------------------------------

test("插回：title 換成譯文，原值存 data-koine-original-title、標記存譯文逐字副本", () => {
	const doc = docFrom(`<p id="p" title="補充說明">Paragraph body text.</p>`);
	translateOnce(doc);
	const p = doc.getElementById("p");
	assert.equal(p.getAttribute("title"), "譯‹補充說明›");
	assert.equal(p.getAttribute("data-koine-original-title"), "補充說明");
	assert.equal(p.getAttribute("data-koine-translated-title"), "譯‹補充說明›");
});

test("防自吞：譯文還在原位 → 二次採集不得再採同一個 title", () => {
	const doc = docFrom(`<p id="p" title="補充說明">Paragraph body text.</p>`);
	// 前提斷言不可省：整支功能不存在時「第二次採不到」也恆真（空真斷言）。
	assert.deepEqual(titleSources(translateOnce(doc)), ["補充說明"], "前提：首輪應採到這個 title");
	assert.deepEqual(titleSources(collect(doc)), [], "再採一次就是把自己的譯文當原文送翻");
});

test("內文未變、站台事後才掛上 title：仍應採得到（我方標記擋的是內文、不是屬性）", () => {
	// 內文一個字沒動 ⇒ 原地換字的防自吞標記仍命中 ⇒ 該元素恆走整棵跳過那條路。
	// 少了「帶我方標記者也算宿主」這一條，這種 title 永遠採不到，且不會自癒。
	const doc = docFrom(`<button id="b">送出</button>`);
	translateOnce(doc);
	const btn = doc.getElementById("b");
	assert.equal(btn.textContent, "譯‹送出›", "前提：首輪應已原地換字（標記在位）");
	assert.deepEqual(titleSources(collect(doc)), [], "前提：此時頁面上沒有任何 title");

	btn.setAttribute("title", "後來才掛上的提示");

	assert.deepEqual(titleSources(collect(doc)), ["後來才掛上的提示"]);
	translateOnce(doc);
	assert.equal(btn.getAttribute("title"), "譯‹後來才掛上的提示›");
	assert.equal(btn.textContent, "譯‹送出›", "內文不得被重譯（標記仍命中）");
});

test("帶我方標記的元素事後被藏起來：title 不採（自身訊號補檢照跑）", () => {
	const doc = docFrom(`<button id="b">送出</button><button id="c">取消</button>`);
	translateOnce(doc);
	const btn = doc.getElementById("b");
	btn.setAttribute("hidden", "");
	btn.setAttribute("title", "藏起來的提示");
	// 對照：同樣帶標記但沒被藏的按鈕，其 title 應照採。
	doc.getElementById("c").setAttribute("title", "看得到的提示");

	assert.deepEqual(titleSources(collect(doc)), ["看得到的提示"]);
});

test("站台自己換掉 title（SPA 換文案）：值對不上標記 → 當新內容重採", () => {
	const doc = docFrom(`<p id="p" title="補充說明">Paragraph body text.</p>`);
	translateOnce(doc);
	const p = doc.getElementById("p");
	p.setAttribute("title", "換過的說明");

	assert.deepEqual(titleSources(collect(doc)), ["換過的說明"]);
	translateOnce(doc);
	assert.equal(p.getAttribute("title"), "譯‹換過的說明›");
	assert.equal(p.getAttribute("data-koine-original-title"), "換過的說明", "原值備份應刷成站台改後的值");
});

test("drift：插回前 title 已被站台換掉 → 放棄覆寫、不留標記", () => {
	const doc = docFrom(`<p id="p" title="補充說明">Paragraph body text.</p>`);
	const segs = collect(doc);
	// 前提斷言不可省：沒產出 title 段時下面「沒被覆寫」也恆真。
	assert.deepEqual(titleSources(segs), ["補充說明"], "前提：應採到這個 title");
	for (const s of segs) {
		if (s.state === koine.SegmentState.PENDING) {
			s.draft = DRAFT(s);
			s.state = koine.SegmentState.DRAFTED;
		}
	}
	const p = doc.getElementById("p");
	p.setAttribute("title", "插回前被換掉的說明");
	koine.insertTranslations(segs);

	assert.equal(p.getAttribute("title"), "插回前被換掉的說明", "對不上快照就不該覆寫");
	assert.ok(!p.hasAttribute("data-koine-translated-title"), "放棄覆寫時不得留標記");
});

// ---------------------------------------------------------------------------
// 原文不再寫進 title
// ---------------------------------------------------------------------------

test("原地換字不在沒有 title 的元素上造出一個 title", () => {
	const doc = docFrom(`<button id="b">送出</button>`);
	translateOnce(doc);
	const btn = doc.getElementById("b");
	assert.equal(btn.textContent, "譯‹送出›", "前提：應已原地換字");
	assert.ok(!btn.hasAttribute("title"), "原文不再寫進 tooltip");
	assert.ok(!btn.hasAttribute("data-koine-title"), "所有權標記已無存在理由、不得再寫");
});

test("attributeApplies：title 不受 <input type> 那層收窄（全域屬性）", () => {
	const doc = docFrom(`<input type="checkbox" id="c" title="勾選以同意">`);
	const el = doc.getElementById("c");
	assert.equal(koine.attributeApplies(el, "title"), true);
	assert.equal(koine.attributeApplies(el, "value"), false, "對照：value 仍受型別收窄");
});
