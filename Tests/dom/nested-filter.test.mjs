// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：§6.2 extractText 的遞迴路徑要套用 §3 的過濾結果。
//
// 段的文字由 extractText 從 buffer 取出，buffer 裡的 inline 元素再由 appendNode 遞迴展開。
// 走訪層（collect）會整棵跳過 SKIP_SUBTREE 的子樹，但那條遞迴只看 tagName——於是同一份
// markup 會因為擺在哪個位置而行為不同：直接掛在 block 容器底下就被濾掉，包進一層 inline
// 就整棵被取進 source 送出去。本檔的每條測試都把同一段 markup 擺在這兩個位置上比對。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { collect } from "./helpers.mjs";

/** 造 doc（body 內塞 html 片段）。 */
function docOf(html) {
	const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
	return document;
}

/** 收段並回 source 陣列（文件序）。 */
function sourcesOf(html) {
	return collect(docOf(html)).map((s) => s.source);
}

/** 同一段 markup 的兩種擺法：①直接掛在 block 容器底下 ②多包一層 inline。 */
function bothPositions(inner) {
	return {
		flat: sourcesOf(`<p>alpha ${inner} beta</p>`),
		nested: sourcesOf(`<p><em>alpha ${inner} beta</em></p>`),
	};
}

/** 每一項都是「內容作者或使用者明示不該送出去」的東西（§3.1 / §3.5 / §3.7）。 */
const SKIPPED_MARKUP = [
	["aria-hidden", '<span aria-hidden="true">LEAKED</span>'],
	["hidden 屬性", "<span hidden>LEAKED</span>"],
	["display:none", '<span data-d="none">LEAKED</span>'],
	["視覺隱藏 class（sr-only）", '<span class="sr-only">LEAKED</span>'],
	["translate=no", '<span translate="no">LEAKED</span>'],
	["script 原始碼", "<script>var LEAKED = 1;</script>"],
	["textarea 使用者輸入", "<textarea>LEAKED</textarea>"],
	["自家插回的舊譯文", '<span class="koine-translated">LEAKED</span>'],
	["自家標記節點", "<span data-koine-id=\"k1-0\">LEAKED</span>"],
];

for (const [name, inner] of SKIPPED_MARKUP) {
	test(`位置不改變過濾結果：${name}`, () => {
		const { flat, nested } = bothPositions(inner);
		assert.deepEqual(flat, ["alpha beta"], "直接掛在 block 容器底下時本來就被走訪層濾掉");
		assert.deepEqual(nested, ["alpha beta"], "包進一層 inline 之後同樣要被濾掉");
	});
}

test("protectedSpan 位移跟著過濾走：被濾掉的文字不計入 offset", () => {
	// code 是 OPAQUE_INLINE、其 textContent 原子併入段落並記下 [start, end)。
	// 若被過濾的內容仍混進文字，這組位移就會往後推、指到錯的字。
	// （fixture 刻意不留會被空白正規化折疊的間隔，好讓位移可以直接拿 source 驗。）
	const segs = collect(docOf('<p><em>alpha <span hidden>LEAKED</span><code>fn()</code> beta</em></p>'));
	assert.equal(segs.length, 1);
	const { source, meta } = segs[0];
	assert.equal(source, "alpha fn() beta");
	assert.deepEqual(meta.protectedSpans, [{ start: 6, end: 10, kind: "code" }]);
	assert.equal(source.slice(6, 10), "fn()");
});

test("被濾掉的只有該子樹：同一層的其他 inline 照常取進 source", () => {
	assert.deepEqual(
		sourcesOf('<p><em>keep one <span aria-hidden="true">LEAKED</span> <b>keep two</b> keep three</em></p>'),
		["keep one keep two keep three"],
	);
});

test("巢狀多層 inline 底下的過濾子樹一樣不取", () => {
	assert.deepEqual(
		sourcesOf('<p><em>outer <b>inner <span hidden>LEAKED</span> tail</b> end</em></p>'),
		["outer inner tail end"],
	);
});

test("ruby 注音仍只取 base（原本就由 tag 特判處理、不受過濾改動影響）", () => {
	assert.deepEqual(
		sourcesOf("<p><em>before <ruby>漢<rt>kan</rt></ruby> after</em></p>"),
		["before 漢 after"],
	);
});

// ---------------------------------------------------------------------------
// OPAQUE（`<code>` / `<time>`）：不可分割不等於不必過濾
// ---------------------------------------------------------------------------

/** 每一項都是「掛在 `<span>` 上就擋得住」的過濾訊號，掛在 OPAQUE 標籤上同樣要擋。 */
const OPAQUE_SELF_SIGNALS = [
	["aria-hidden", 'aria-hidden="true"'],
	["hidden 屬性", "hidden"],
	["translate=no", 'translate="no"'],
	["視覺隱藏 class（sr-only）", 'class="sr-only"'],
	["display:none", 'data-d="none"'],
];

for (const [name, attr] of OPAQUE_SELF_SIGNALS) {
	test(`OPAQUE 標籤自身的過濾訊號要擋：${name}`, () => {
		// 這組訊號原本檢查不到——OPAQUE 的歸類排在屬性／style 檢查之前就 return 了，
		// 於是同一個屬性掛在 <span> 上擋得住、掛在 <code> 上擋不住。
		assert.deepEqual(sourcesOf(`<p>alpha <code ${attr}>LEAKED</code> beta</p>`), ["alpha beta"], "<code> 應整棵跳");
		assert.deepEqual(sourcesOf(`<p>alpha <time ${attr}>LEAKED</time> beta</p>`), ["alpha beta"], "<time> 應整棵跳");
	});
}

test("對照：沒有過濾訊號的 OPAQUE 照常併入並記 protectedSpan（不是整條軸被關掉）", () => {
	const segs = collect(docOf("<p>alpha <code>fn()</code> beta</p>"));
	assert.equal(segs.length, 1);
	assert.equal(segs[0].source, "alpha fn() beta");
	assert.deepEqual(segs[0].meta.protectedSpans, [{ start: 6, end: 10, kind: "code" }]);
});

test("OPAQUE 子樹內被過濾的內容不得併進 source（兩個擺法都是）", () => {
	// OPAQUE 分支原本一行 `el.textContent` 取完整棵子樹，不看子代的 disp。
	const { flat, nested } = bothPositions('<code>fn(<span aria-hidden="true">LEAKED</span>)</code>');
	assert.deepEqual(flat, ["alpha fn() beta"]);
	assert.deepEqual(nested, ["alpha fn() beta"]);
});

test("OPAQUE 子樹過濾後 protectedSpan 仍指到正確的字", () => {
	const segs = collect(docOf('<p>alpha <code>fn(<span hidden>LEAKED</span>)</code> beta</p>'));
	assert.equal(segs.length, 1);
	const { source, meta } = segs[0];
	assert.equal(source, "alpha fn() beta");
	assert.deepEqual(meta.protectedSpans, [{ start: 6, end: 10, kind: "code" }]);
	assert.equal(source.slice(6, 10), "fn()", "span 要切得出原本那段不可翻的字");
});

test("已達目標語的子節點不算「不該外送」：文字仍要留在 OPAQUE 裡", () => {
	// `lang` 已是目標語的元素整棵跳，意思是「不必另外翻」——它的文字仍在頁面上看得見。
	// 若把這條 skip 與「不該外送」混為一談，`<code>` 就會缺字送出、protectedSpan 也蓋不住原字。
	const segs = collect(docOf('<p>alpha <code>fn(<var lang="zh-Hant">名稱</var>)</code> beta</p>'));
	assert.equal(segs.length, 1);
	const { source, meta } = segs[0];
	assert.equal(source, "alpha fn(名稱) beta");
	assert.deepEqual(meta.protectedSpans, [{ start: 6, end: 12, kind: "code" }]);
	assert.equal(source.slice(6, 12), "fn(名稱)");
});

test("同一顆節點兼有兩種訊號時仍以「不該外送」為準", () => {
	// `lang` 已達目標語、同時掛 `aria-hidden` ⇒ 隱藏才是那條 skip 的理由，照挖。
	assert.deepEqual(
		sourcesOf('<p>alpha <code>fn(<var lang="zh-Hant" aria-hidden="true">LEAKED</var>)</code> beta</p>'),
		["alpha fn() beta"],
	);
});

test("OPAQUE 內容全空時不併字、也不留零長 span", () => {
	// 零長 span 會讓下游「這段不可翻」的區間退化成一個沒有寬度的點，屬無意義的資料。
	// ⚠ 守衛只認「一個字元都不剩」；過濾後只剩空白的情形不在此列（既有行為，另議）。
	const segs = collect(docOf('<p>alpha <code><span hidden>LEAKED</span></code> beta</p>'));
	assert.equal(segs.length, 1);
	assert.equal(segs[0].source, "alpha beta");
	// 一條 span 都沒有時整個 meta 不建（既有行為），故這裡問的是「查不到任何 span」。
	assert.equal(segs[0].meta?.protectedSpans, undefined);
});

test("OPAQUE 子樹的過濾只挖掉該子樹：同層其他文字照常併入", () => {
	assert.deepEqual(
		sourcesOf('<p>alpha <code>keep(<span class="sr-only">LEAKED</span>)tail</code> beta</p>'),
		["alpha keep()tail beta"],
	);
});
