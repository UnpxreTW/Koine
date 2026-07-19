// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：P4 button-class 元素原地換字特徵化測試。
// button-class 窄判準（BUTTON／LABEL／role=button + ≤20 字 + 無 block 子）命中時直接原地換字，
// 原文存 title + data-koine-original，並以 data-koine-translated 防自吞；標記消失（重渲染）
// 即視為未譯、重新採集會產生新段——不加 wrapper。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { koine, collect } from "./helpers.mjs";

function docFrom(bodyHtml) {
	const { document } = parseHTML(`<!doctype html><html><body>${bodyHtml}</body></html>`);
	return document;
}

const DRAFT = (s) => `譯‹${s.source}›`;

/** 把 pending 段塞假 draft + 轉 drafted（模擬填譯；render 只消費 drafted）。 */
function draftPending(segs) {
	for (const s of segs) {
		if (s.state === koine.SegmentState.PENDING) {
			s.draft = DRAFT(s);
			s.state = koine.SegmentState.DRAFTED;
		}
	}
	return segs;
}

test("button-class 判準命中：BUTTON ≤20 字無 block 子 → segment.kind = button", () => {
	const doc = docFrom(`<button id="b">送出</button>`);
	const segs = collect(doc);
	assert.equal(segs.length, 1);
	assert.equal(segs[0].kind, "button");
	assert.equal(segs[0].anchor.block, doc.getElementById("b"));
});

test("LABEL、role=button（非天生 block 標籤 span）同樣命中窄判準", () => {
	const doc = docFrom(`
		<label id="l">同意條款</label>
		<span id="r" role="button">下一步</span>
	`);
	const segs = collect(doc);
	const byId = Object.fromEntries(segs.map((s) => [s.anchor.block.id, s]));
	assert.equal(byId.l.kind, "button", "LABEL 應命中 button-class");
	assert.equal(byId.r.kind, "button", "role=button 的 span 應命中 button-class（非天生 block 標籤）");
});

test("超過 20 字的 BUTTON 不命中窄判準（退回一般 block / wrapper 流程）", () => {
	const doc = docFrom(`<button id="b">這是一段超過二十個字的很長很長很長的按鈕文字內容喔喔喔</button>`);
	const segs = collect(doc);
	assert.equal(segs.length, 1);
	assert.notEqual(segs[0].kind, "button");
});

test("含 block 子的 BUTTON 不命中窄判準（有 block 子退回一般 block）", () => {
	const doc = docFrom(`<button id="b">前綴<div id="inner">內部區塊</div></button>`);
	const segs = collect(doc);
	const outer = segs.find((s) => s.anchor.block === doc.getElementById("b"));
	assert.ok(outer, "應仍有 button 前綴段");
	assert.notEqual(outer.kind, "button", "含 block 子代不應命中 button-class 窄判準");
});

test("含任何元素子代（icon svg／ruby／aria-hidden／sr-only）的 BUTTON 不命中窄判準：一律退回 wrapper 流程、原元素不被動", () => {
	// 原地換字用 textContent 整個覆寫、會連帶砍掉所有元素子節點。元素子代常藏著對 source／長度
	// 判準不可見的內容——icon（svg）整個是 SKIP_SUBTREE、ruby 的 rt 注音被 extractText 濾掉、
	// aria-hidden／sr-only 子代文字也是 SKIP_SUBTREE——一旦覆寫就回不來，防呆快照機制也救不了，
	// 因為這不是「插回前內容變動」而是「一開始就不該命中窄判準」。保守起步：只要有任何元素子
	// 節點（不論是否已知類型）就不命中 button-class，退回一般 block／wrapper 流程；wrapper 只加
	// sibling、不動原元素，天生安全。
	const cases = [
		{ id: "svg", html: `<button id="svg"><svg aria-hidden="true"><path d="M0 0"></path></svg> Submit</button>` },
		{ id: "ruby", html: `<button id="ruby"><ruby>字<rt>ㄗˋ</rt></ruby></button>` },
		{ id: "ah", html: `<button id="ah">Menu<span aria-hidden="true"> →</span></button>` },
		{ id: "sr", html: `<button id="sr">Save<span class="sr-only"> changes</span></button>` },
	];
	const doc = docFrom(cases.map((c) => c.html).join("\n"));
	const segs = collect(doc);

	for (const c of cases) {
		const el = doc.getElementById(c.id);
		const seg = segs.find((s) => s.anchor.block === el);
		assert.ok(seg, `${c.id}: 應仍產生一般段（走 wrapper 流程）`);
		assert.notEqual(seg.kind, "button", `${c.id}: 含元素子代不應命中 button-class 窄判準`);
	}

	draftPending(segs);
	koine.insertTranslations(segs);

	assert.ok(doc.getElementById("svg").querySelector("svg"), "wrapper 流程不應動到原元素、icon 應原封不動保留");
	for (const c of cases) {
		const el = doc.getElementById(c.id);
		const seg = segs.find((s) => s.anchor.block === el);
		assert.equal(
			doc.querySelector(`[data-koine-id="${seg.id}"]`).tagName, "DIV",
			`${c.id}: 應改走一般 wrapper 插回`,
		);
	}
});

test("replace 渲染：原地換字＋原文存 title/data-koine-original＋data-koine-translated 標記、不加 wrapper", () => {
	const doc = docFrom(`<button id="b">送出</button>`);
	const segs = draftPending(collect(doc));
	const inserted = koine.insertTranslations(segs);
	const btn = doc.getElementById("b");

	assert.equal(inserted.length, 1);
	assert.equal(inserted[0], btn, "button-class 應回傳原元素本身，非新建 wrapper");
	assert.equal(btn.textContent, segs[0].draft, "textContent 應換成譯文");
	assert.equal(btn.getAttribute("title"), "送出", "title 應存原文（KO-6）");
	assert.equal(btn.getAttribute("data-koine-original"), "送出", "data-koine-original 應存原文（KO-7）");
	assert.ok(btn.hasAttribute("data-koine-translated"), "缺 data-koine-translated 防自吞標記（KO-7）");
	assert.equal(btn.nextSibling, null, "button-class 不應插入 wrapper sibling（KO-7 不加 wrapper）");
	assert.equal(doc.querySelectorAll(".koine-translated").length, 0, "不應出現 wrapper class 元素");
});

test("防呆：插回前元素即時文字已與採集當下 source 不同（頁面自身 JS 改字）→ 放棄覆寫、保留當下真實文字", () => {
	const doc = docFrom(`<button id="b">登入</button>`);
	const segs = draftPending(collect(doc)); // 譯文對應舊文字「登入」（KO-6/7 換字前的採集快照）
	const btn = doc.getElementById("b");

	// 模擬採集之後、插回之前，頁面自身邏輯已把按鈕文字改成別的內容（如登入態切換）。
	btn.textContent = "登出";

	const inserted = koine.insertTranslations(segs);

	assert.equal(inserted.length, 0, "文字已 drift、不應覆寫（避免拿舊譯文蓋掉當下真實狀態）");
	assert.equal(btn.textContent, "登出", "應保留頁面當下的真實文字，不被舊譯文覆寫");
	assert.ok(!btn.hasAttribute("data-koine-translated"), "未覆寫就不應標記已譯");
	assert.ok(!btn.hasAttribute("title"), "未覆寫就不應寫入 title/data-koine-original");
});

test("防呆：插回前被插入不帶文字的元素子代（如 icon）→ textContent 字串不變但結構已變，仍放棄覆寫", () => {
	// 只比對 textContent 字串不夠：插入一個沒有文字的元素（icon svg 的 path/circle 皆無文字）不會讓
	// textContent 出現差異，但緊接著的 textContent 覆寫仍會把它整個砍掉。插回前必須重新核一次「即時
	// 結構是否仍只有純文字子代」，結構已變同樣視為 drift、放棄覆寫，讓新插入的 icon 保住。
	const doc = docFrom(`<button id="b">Submit</button>`);
	const segs = draftPending(collect(doc));
	const btn = doc.getElementById("b");

	// 模擬採集之後、插回之前，頁面自身邏輯插入了一個不含文字的 icon 子代。
	const icon = doc.createElement("svg");
	icon.setAttribute("aria-hidden", "true");
	btn.insertBefore(icon, btn.firstChild);
	assert.equal(btn.textContent, "Submit", "插入 icon 不應改變 textContent 字串本身");

	const inserted = koine.insertTranslations(segs);

	assert.equal(inserted.length, 0, "結構已變（多了元素子代），不應覆寫");
	assert.ok(btn.querySelector("svg"), "新插入的 icon 應保留、不被 textContent 覆寫砍掉");
	assert.equal(btn.textContent, "Submit", "文字內容應維持不變（未被覆寫、也未被砍掉任何東西）");
	assert.ok(!btn.hasAttribute("data-koine-translated"), "未覆寫就不應標記已譯");
});

test("防呆快照機制：純文字 button 的 buttonSnapshot 即等於 source（無元素子代、無過濾差異）", () => {
	// 命中 button-class 的元素現在保證只有純文字子代（hasOnlyTextChildren 閘），所以 buttonSnapshot
	// （未過濾的原始 textContent）與 seg.source（normalizeSource 後的送翻文字）在靜態情況下必然
	// 一致；兩者出現落差只會來自「插回前內容真的變了」（drift），不會來自結構性過濾差異——這正是
	// 防呆快照機制存在的唯一理由（見前一個「頁面自身 JS 改字」drift 測試）。
	const doc = docFrom(`<button id="b">送出</button>`);
	const segs = collect(doc);
	assert.equal(segs[0].kind, "button");
	assert.equal(segs[0].meta.buttonSnapshot, segs[0].source, "純文字 button 的快照應等於 source");
});

test("自吞防護：已標記的 button 再次採集整棵跳過、不產生新段", () => {
	const doc = docFrom(`<button id="b">送出</button>`);
	const segs = draftPending(collect(doc));
	koine.insertTranslations(segs);

	const again = collect(doc);
	assert.equal(again.length, 0, "已標記 button 應被 classifyNode [1] 自家標記擋下、不再產段");
});

test("KO-7 重渲染標記消失即自動重譯：節點被整個換掉（無標記）→ 視為未譯、重新採集產生新 pending 段", () => {
	const doc = docFrom(`<button id="b">送出</button>`);
	const segs = draftPending(collect(doc));
	koine.insertTranslations(segs);
	const oldBtn = doc.getElementById("b");
	assert.ok(oldBtn.hasAttribute("data-koine-translated"), "換字後應已標記");

	// 模擬框架重渲染：整個節點被換成不含任何 koine 標記的新節點（原文重新出現，如 React/Vue 依自身
	// state 重繪、我方 DOM 側寫入的屬性不會被保留）。
	const fresh = doc.createElement("button");
	fresh.id = "b";
	fresh.textContent = "送出";
	oldBtn.parentNode.replaceChild(fresh, oldBtn);

	const resegs = collect(doc);
	assert.equal(resegs.length, 1, "新節點無標記，應被視為未譯、重新產生待譯段");
	assert.equal(resegs[0].state, koine.SegmentState.PENDING);
	assert.equal(resegs[0].kind, "button", "新節點仍符合 button-class 窄判準");
	assert.equal(resegs[0].source, "送出", "應以新節點的原文重新採集（非殘留譯文）");
	assert.equal(resegs[0].anchor.block, fresh);
});

test("KO-7 標記被直接清除（同節點）同樣視為未譯：classifyNode 純看屬性、不看節點身分", () => {
	const doc = docFrom(`<button id="b">送出</button>`);
	const segs = draftPending(collect(doc));
	koine.insertTranslations(segs);
	const btn = doc.getElementById("b");
	assert.ok(btn.hasAttribute("data-koine-translated"));

	btn.removeAttribute("data-koine-translated");

	const resegs = collect(doc);
	assert.equal(resegs.length, 1, "標記消失後應重新產生一個待譯段（純屬性檢查、非節點身分快取）");
	assert.equal(resegs[0].state, koine.SegmentState.PENDING);
	assert.equal(resegs[0].anchor.block, btn);
});
