// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：原地換字的防自吞標記 data-koine-translated 存譯文快照，
// classifyNode [1] 比對「標記值 vs 當下內容」——當下內容仍含標記值才跳過（站台追加子節點時
// 譯文仍在原位），只有整段被換掉、不再含這份副本才視為新內容重新採集。
// wrapper 軸（data-koine-id／koine-translated class）不受影響。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { koine, collect, assertSame } from "./helpers.mjs";

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

/** 採集 → 填假譯文 → 插回，回傳插回的元素清單。 */
function translateOnce(doc) {
	return koine.insertTranslations(draftPending(collect(doc)));
}

test("標記存的是譯文本身、不是空字串", () => {
	const doc = docFrom(`<button id="b">送出</button>`);
	translateOnce(doc);
	const btn = doc.getElementById("b");

	assert.equal(btn.textContent, "譯‹送出›");
	assert.equal(
		btn.getAttribute("data-koine-translated"), "譯‹送出›",
		"標記值應為剛寫入的譯文逐字副本（比對用；空字串比不出站台改字）",
	);
});

test("標記值＝當下內容：再次採集整棵跳過、不產生新段", () => {
	const doc = docFrom(`<button id="b">送出</button>`);
	translateOnce(doc);

	assert.equal(collect(doc).length, 0, "譯文還在原位，應被 classifyNode [1] 擋下");
});

test("站台把同一顆節點的文字換掉（SPA 重用節點）：標記還在但值對不上 → 重新採集新內容", () => {
	const doc = docFrom(`<button id="b">送出</button>`);
	translateOnce(doc);
	const btn = doc.getElementById("b");
	assert.ok(btn.hasAttribute("data-koine-translated"), "前提：換字後應已標記");

	// 模擬站台自身 JS 改字（登入/登出切文案）：節點沒被換掉、我方標記原封不動留著。
	btn.textContent = "登出";

	const resegs = collect(doc);
	assert.equal(resegs.length, 1, "內容已非我方譯文，應視為未譯、重新產生待譯段");
	assert.equal(resegs[0].state, koine.SegmentState.PENDING);
	assert.equal(resegs[0].source, "登出", "應以站台改後的新內容重新採集");
	assertSame(resegs[0].anchor.block, btn, "anchor.block 應仍為同一顆節點");
});

test("重新覆寫時 data-koine-original 與標記一起刷成新值（殘留值不留到下一輪）", () => {
	const doc = docFrom(`<button id="b">送出</button>`);
	translateOnce(doc);
	const btn = doc.getElementById("b");
	btn.textContent = "登出";

	translateOnce(doc);

	assert.equal(btn.textContent, "譯‹登出›", "應以新內容的譯文再次原地換字");
	assert.equal(btn.getAttribute("data-koine-original"), "登出", "原文快照應刷成站台改後的值");
	assert.equal(btn.getAttribute("data-koine-translated"), "譯‹登出›", "標記應刷成新譯文");
	assert.ok(!btn.hasAttribute("title"), "內文軸不寫 tooltip（元素本來沒有 title 就不該長出一個）");
	assert.equal(doc.querySelectorAll(".koine-translated").length, 0, "全程不應建 wrapper");
});

test("元素既有的 title 由屬性軸翻一次就停：內文重譯不得把譯文再翻一次", () => {
	const doc = docFrom(`<button id="b" title="站台提示">送出</button>`);
	translateOnce(doc);
	const btn = doc.getElementById("b");
	assert.equal(btn.getAttribute("title"), "譯‹站台提示›", "前提：title 應由屬性軸換成譯文");
	assert.equal(btn.getAttribute("data-koine-original-title"), "站台提示", "前提：原值應留一份");

	btn.textContent = "登出";
	translateOnce(doc);

	assert.equal(btn.getAttribute("title"), "譯‹站台提示›", "title 未被站台改過，不得重採重譯（自吞）");
	assert.equal(btn.getAttribute("data-koine-translated"), "譯‹登出›", "換字本身仍應完成");
});

test("wrapper 軸不比對內容：data-koine-id 節點即使被改字仍整棵跳過", () => {
	const doc = docFrom(`<p id="p">This paragraph is long enough to take the ordinary wrapper path.</p>`);
	const inserted = translateOnce(doc);
	assert.equal(inserted.length, 1);
	const wrapper = inserted[0];
	assert.ok(wrapper.hasAttribute("data-koine-id"), "前提：並列插回應建帶 data-koine-id 的 wrapper");

	wrapper.textContent = "被改過的譯文";

	const again = collect(doc);
	// 空迴圈會讓下面那條斷言恆真：原文段本身沒有標記、二次採集本來就該再產一段。
	assert.ok(again.length > 0, "前提：原文段無標記、二次採集應仍產段（否則下面的迴圈驗不到東西）");
	for (const s of again) {
		assertSame(s.anchor.block, doc.getElementById("p"), "wrapper 不得被採集（我方節點恆跳）");
	}
});

test("站台在譯完的元素上追加 badge 子節點：譯文仍在原位 → 二次採集不得重採（自吞防線）", () => {
	const doc = docFrom(`<button id="b">送出</button>`);
	translateOnce(doc);
	const btn = doc.getElementById("b");
	assert.equal(btn.textContent, "譯‹送出›", "前提：首輪應已原地換字");

	// 站台自己掛計數 badge：我方譯文一個字都沒被動到，只是後面多了一顆子節點。
	const badge = doc.createElement("span");
	badge.textContent = "3";
	btn.appendChild(badge);

	assert.equal(
		collect(doc).length, 0,
		"譯文仍在原位、只是被追加內容，全等比對會把它當新內容重採 ⇒ source 就是我方自己的譯文（自吞）",
	);
});

test("站台追加純文字節點：同樣不得重採、頁面不得出現譯文的譯文", () => {
	const doc = docFrom(`<button id="b">送出</button>`);
	translateOnce(doc);
	const btn = doc.getElementById("b");

	btn.appendChild(doc.createTextNode(" (3)"));

	assert.equal(collect(doc).length, 0, "追加純文字仍屬「譯文還在原位」、應整棵跳過");

	translateOnce(doc);
	assert.equal(btn.textContent, "譯‹送出› (3)", "不得把自己的譯文再翻一次寫回頁面");
});

test("站台事後自己設 title：屬性軸當成新內容翻，內文軸不插手", () => {
	const doc = docFrom(`<button id="b">送出</button>`);
	translateOnce(doc);
	const btn = doc.getElementById("b");
	assert.ok(!btn.hasAttribute("title"), "前提：元素原本無 title，內文軸不得憑空造一個");

	// 站台改字時一併設自己的 tooltip。
	btn.textContent = "登出";
	btn.setAttribute("title", "站台新提示");

	translateOnce(doc);

	assert.equal(btn.getAttribute("title"), "譯‹站台新提示›", "新出現的 tooltip 是可見文字、應被翻譯");
	assert.equal(btn.getAttribute("data-koine-original-title"), "站台新提示", "原值應留一份");
	assert.equal(btn.textContent, "譯‹登出›", "換字本身仍應完成");
});

test("站台改字後退回並列插回：原地換字軸的殘留標記應清掉", () => {
	const doc = docFrom(`<button id="b">送出</button>`);
	translateOnce(doc);
	const btn = doc.getElementById("b");
	assert.equal(btn.getAttribute("data-koine-translated"), "譯‹送出›", "前提：首輪應走原地換字並留標記");

	// 站台把同一顆按鈕的文案換成長字串：新原文超過按鈕軸長度閘 ⇒ 這一輪改走並列插回。
	const long = "Sign out of every device in this workspace";
	assert.ok(long.length > koine.BUTTON_CLASS_MAX_CHARS, "前提：新原文須超過長度閘才會退回並列插回");
	btn.textContent = long;

	const inserted = translateOnce(doc);
	assert.equal(inserted.length, 1);
	assert.ok(inserted[0].hasAttribute("data-koine-id"), "前提：本輪應退回並列插回、不是原地換字");

	assert.ok(!btn.hasAttribute("data-koine-translated"), "防自吞標記停在上一輪的譯文、應清掉");
	assert.ok(!btn.hasAttribute("data-koine-original"), "原文快照停在上一輪的內容、應清掉");
});

test("退回並列插回時元素帶著 title：內文軸的清除不得碰到屬性軸的成果", () => {
	const doc = docFrom(`<button id="b">送出</button>`);
	translateOnce(doc);
	const btn = doc.getElementById("b");

	// 站台改字時一併換上自己的 tooltip，且新文案長到會退回並列插回。
	btn.textContent = "Sign out of every device in this workspace";
	btn.setAttribute("title", "站台新提示");

	translateOnce(doc);

	assert.equal(btn.getAttribute("title"), "譯‹站台新提示›", "title 歸屬性軸，退回並列插回不得撤掉它");
	assert.equal(btn.getAttribute("data-koine-translated-title"), "譯‹站台新提示›", "屬性軸標記應在位");
	assert.ok(!btn.hasAttribute("data-koine-translated"), "內文軸的防自吞標記仍應清掉");
});
