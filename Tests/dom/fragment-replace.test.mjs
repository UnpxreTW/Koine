// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：§9.2 碎片軸 —— 簡中來源 → 繁中目標的段若帶 inline 子代，
// 改逐 text node 各成一段（insertMode = "replace-text"）、逐顆換字，元素節點一個都不碰。
//
// 本檔驗三件事：①什麼會被拆成碎片、什麼不會（過濾與整段軸同一套）；②寫入面只動
// nodeValue、前後空白與元素結構原樣保留；③drift 與防自吞標記的紀律與整段軸一致。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { koine, stubGetStyle, assertSame } from "./helpers.mjs";

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

const sourcesOf = (segs) => segs.map((s) => s.source);

// ---------------------------------------------------------------------------
// 採集：什麼會被拆成碎片
// ---------------------------------------------------------------------------

test("帶 inline 子代的簡中段拆成逐 text node 的碎片段", () => {
	const doc = docFrom(`<div lang="zh-CN"><p id="p">简体<strong id="s">加粗</strong>段落。</p></div>`);
	const segs = collectWith(doc);

	assert.deepEqual(sourcesOf(segs), ["简体", "加粗", "段落。"], "三顆 text node 應各成一段");
	for (const seg of segs) {
		assert.equal(seg.anchor.insertMode, "replace-text");
		assert.equal(seg.kind, "fragment");
		assertSame(seg.anchor.block, doc.getElementById("p"), "碎片的 block 一律是所屬 block 容器");
		assert.equal(seg.anchor.textNode.nodeType, 3, "anchor 須指到 text node 本身");
	}
	assert.deepEqual(segs.map((s) => s.order), [0, 1, 2], "order 沿文件序連號");
	assert.equal(new Set(segs.map((s) => s.id)).size, 3, "三段的 id 不得相同");
});

test("碎片的防呆快照存逐字原值、不是 normalize 過的 source", () => {
	const doc = docFrom(`<div lang="zh-CN"><p id="p">  简体  <em>强调</em>段落。</p></div>`);
	const segs = collectWith(doc);
	assert.equal(segs[0].source, "简体", "source 是 normalize 過的");
	assert.equal(segs[0].meta.replaceSnapshot, "  简体  ", "快照須逐字、含兩端空白");
});

test("只有純文字子代的簡中段照舊整段原地換字、不碎片化", () => {
	const doc = docFrom(`<div lang="zh-CN"><p id="p">这是简体中文段落。</p></div>`);
	const segs = collectWith(doc);
	assert.equal(segs.length, 1);
	assert.equal(segs[0].anchor.insertMode, "replace", "沒有元素子代就沒有碎片化的理由");
	assert.equal(segs[0].kind, undefined);
});

test("一般翻譯軸不碎片化：目標語非繁中的簡中段仍整段並列", () => {
	// 碎片送翻會失上下文、是語序品質的淨退步；簡→繁不重排語序才換得到這個好處。
	const doc = docFrom(`<div lang="zh-CN"><p id="p">简体<em>强调</em>段落。</p></div>`);
	const segs = collectWith(doc, { targetLang: "en" });
	assert.equal(segs.length, 1, "不得拆成碎片");
	assert.equal(segs[0].anchor.insertMode, "after-segment");
});

test("英文頁的 inline 段不碎片化（語言對軸不成立）", () => {
	const doc = docFrom(`<div lang="en"><p id="p">Read <em>the manual</em> first.</p></div>`);
	const segs = collectWith(doc);
	assert.equal(segs.length, 1);
	assert.equal(segs[0].anchor.insertMode, "after-segment");
});

// ---------------------------------------------------------------------------
// 採集過濾：與整段軸同一套
// ---------------------------------------------------------------------------

test("OPAQUE（<code>／<time>）整棵不產碎片，其文字也不進任何碎片", () => {
	const doc = docFrom(`<div lang="zh-CN"><p id="p">调用 <code id="c">useState()</code> 之后。</p></div>`);
	const segs = collectWith(doc);
	assert.deepEqual(sourcesOf(segs), ["调用", "之后。"], "不可翻的原子不該有自己的段");
	for (const seg of segs) {
		assert.ok(!seg.meta.protectedSpans, "碎片段上不該有位移保護（原子直接不進碎片）");
	}

	koine.insertTranslations(draftPending(segs));
	assert.equal(doc.getElementById("c").textContent, "useState()", "原子的文字不得被換");
});

test("SKIP_SUBTREE 子樹（hidden／aria-hidden／translate=no）不產碎片", () => {
	const doc = docFrom(
		`<div lang="zh-CN"><p id="p">可见文字<span id="h" hidden>隐藏文字</span>` +
		`<span id="a" aria-hidden="true">辅助隐藏</span><span id="n" translate="no">不译</span>结尾。</p></div>`,
	);
	const segs = collectWith(doc);
	assert.deepEqual(sourcesOf(segs), ["可见文字", "结尾。"], "被剪枝的子樹不得成為碎片");

	koine.insertTranslations(draftPending(segs));
	assert.equal(doc.getElementById("h").textContent, "隐藏文字");
	assert.equal(doc.getElementById("a").textContent, "辅助隐藏");
	assert.equal(doc.getElementById("n").textContent, "不译");
});

test("ruby 注音（<rt>／<rp>）不產碎片，base 照樣拆", () => {
	const doc = docFrom(
		`<div lang="zh-CN"><p id="p">这个<ruby>汉<rt id="t">hàn</rt></ruby>字很难。</p></div>`,
	);
	const segs = collectWith(doc);
	assert.deepEqual(sourcesOf(segs), ["这个", "汉", "字很难。"]);

	koine.insertTranslations(draftPending(segs));
	assert.equal(doc.getElementById("t").textContent, "hàn", "注音不得被換");
});

test("純空白 text node 不產段（連 skipped 都不建）", () => {
	const doc = docFrom(`<div lang="zh-CN"><p id="p">简体 <em>强调</em> 段落。</p></div>`);
	// inline 之間的兩顆空白落在 <em> 的前後同一顆 text node 裡，另造一顆真正只有空白的節點：
	const p = doc.getElementById("p");
	p.insertBefore(doc.createTextNode("   "), p.firstChild);
	const segs = collectWith(doc);
	assert.deepEqual(sourcesOf(segs), ["简体", "强调", "段落。"], "純空白節點不該出現在段清單裡");
});

test("極短碎片不被段落的極短門檻判掉（unit = fragment）", () => {
	// 段落門檻的前提是「一整段話至少要有兩個字母」，對拆出來的單字碎片不成立。
	const doc = docFrom(`<div lang="zh-CN"><p id="p">A<em>好</em>B</p></div>`);
	const segs = collectWith(doc);
	assert.deepEqual(sourcesOf(segs), ["A", "好", "B"]);
	for (const seg of segs) {
		assert.equal(seg.state, koine.SegmentState.PENDING, `${seg.source} 不該被判掉`);
	}
});

test("整段判準先過才細分：整段命中 URL／已達標時不產任何碎片", () => {
	const doc = docFrom(`<div lang="zh-CN"><p id="p">https://<em>example</em>.com/path</p></div>`);
	const segs = collectWith(doc);
	assert.equal(segs.length, 1, "整段被判掉就不該再拆");
	assert.equal(segs[0].state, koine.SegmentState.SKIPPED);
	assert.equal(segs[0].meta.skipReason, "url");
});

// ---------------------------------------------------------------------------
// 插回：只動 nodeValue
// ---------------------------------------------------------------------------

test("逐顆換字：元素節點與其身分原封不動、不建 wrapper", () => {
	const doc = docFrom(`<div lang="zh-CN"><p id="p">简体<strong id="s">加粗</strong>段落。</p></div>`);
	const segs = draftPending(collectWith(doc));
	const strong = doc.getElementById("s");
	const inserted = koine.insertTranslations(segs);

	assertSame(doc.getElementById("s"), strong, "原文的 <strong> 應是同一顆節點、不是重建的");
	assert.equal(strong.textContent, "譯‹加粗›", "inline 內的文字應各自換掉");
	assert.equal(doc.getElementById("p").textContent, "譯‹简体›譯‹加粗›譯‹段落。›");
	assert.equal(doc.querySelectorAll(".koine-translated").length, 0, "碎片軸不建 wrapper");
	assert.equal(inserted.length, 1, "同一顆 block 統一套用一次");
	assertSame(inserted[0], doc.getElementById("p"), "回傳的是碎片所屬的 block");
});

test("前後空白原樣保留：inline 之間的間隔不被吃掉", () => {
	const doc = docFrom(`<div lang="zh-CN"><p id="p">看 <em id="e">这里</em> 就好</p></div>`);
	const segs = draftPending(collectWith(doc));
	assert.deepEqual(sourcesOf(segs), ["看", "这里", "就好"], "source 兩端已 trim");

	koine.insertTranslations(segs);
	assert.equal(
		doc.getElementById("p").textContent, "譯‹看› 譯‹这里› 譯‹就好›",
		"原本的兩個間隔空白應留在原位",
	);
});

test("原文備份只存第一次寫入前的完整原文、不存半譯的中間態", () => {
	const doc = docFrom(`<div lang="zh-CN"><p id="p">简体<em>强调</em>段落。</p></div>`);
	koine.insertTranslations(draftPending(collectWith(doc)));
	assert.equal(
		doc.getElementById("p").getAttribute("data-koine-original"), "简体强调段落。",
		"備份須是整顆 block 的原文",
	);
});

test("防自吞標記＝寫完後的整顆 textContent", () => {
	const doc = docFrom(`<div lang="zh-CN"><p id="p">简体<em>强调</em>段落。</p></div>`);
	koine.insertTranslations(draftPending(collectWith(doc)));
	const p = doc.getElementById("p");
	assert.equal(p.getAttribute("data-koine-translated"), p.textContent);
});

// ---------------------------------------------------------------------------
// drift 與防自吞
// ---------------------------------------------------------------------------

test("drift：一顆 text node 被站台改掉 → 整顆 block 一個字都不寫、不留標記", () => {
	// 逐顆各寫各的會留下「一顆 drift、其餘照寫」的中間態：最後那道標記（值＝整顆 textContent）
	// 照樣被寫上 ⇒ 站台剛換上去的新內容被鎖成已譯、且不會自癒。整批放棄才與整段軸同紀律。
	const doc = docFrom(`<div lang="zh-CN"><p id="p">简体<em id="e">强调</em>段落。</p></div>`);
	const segs = draftPending(collectWith(doc));
	doc.getElementById("e").firstChild.nodeValue = "页面自己改了";

	const inserted = koine.insertTranslations(segs);
	assert.equal(inserted.length, 0);
	assert.equal(doc.getElementById("p").textContent, "简体页面自己改了段落。", "未 drift 的碎片也不該被寫");
	const p = doc.getElementById("p");
	assert.ok(!p.hasAttribute("data-koine-translated"), "不得留防自吞標記");
	assert.ok(!p.hasAttribute("data-koine-original"), "不得留原文備份");
});

test("drift 之後下一輪照樣採得到：新內容不被標記鎖成已譯", () => {
	const doc = docFrom(`<div lang="zh-CN"><p id="p">简体<em id="e">强调</em>段落。</p></div>`);
	const segs = draftPending(collectWith(doc));
	doc.getElementById("e").firstChild.nodeValue = "页面自己改了";
	koine.insertTranslations(segs);

	assert.deepEqual(
		sourcesOf(collectWith(doc)), ["简体", "页面自己改了", "段落。"],
		"整段內容應在下一輪重新採得",
	);
});

test("drift：text node 已被拆出 DOM → 整批不覆寫（字面相等也不算數）", () => {
	// 拆下來的節點仍留著原值 ⇒ 快照照樣對得上，但譯文永遠不會顯示在頁面上。
	const doc = docFrom(`<div lang="zh-CN"><p id="p">简体<em id="e">强调</em>段落。</p></div>`);
	const segs = draftPending(collectWith(doc));
	const em = doc.getElementById("e");
	const detached = em.firstChild;
	em.removeChild(detached);

	const inserted = koine.insertTranslations(segs);
	assert.equal(detached.nodeValue, "强调", "已拆下的節點不該被寫入");
	assert.equal(inserted.length, 0, "同一顆 block 的其餘碎片一併放棄");
	assert.equal(doc.getElementById("p").textContent, "简体段落。");
});

test("缺快照的碎片一律不覆寫（防禦路徑），同一顆 block 的其餘碎片一併放棄", () => {
	const doc = docFrom(`<div lang="zh-CN"><p id="p">简体<em>强调</em>段落。</p></div>`);
	const segs = draftPending(collectWith(doc));
	delete segs[0].meta.replaceSnapshot;

	koine.insertTranslations(segs);
	assert.equal(doc.getElementById("p").textContent, "简体强调段落。", "無快照不可信、放棄覆寫");
});

test("兩顆 block 各自結算：一顆 drift 不牽連另一顆", () => {
	const doc = docFrom(
		`<div lang="zh-CN"><p id="a">甲文<em id="ae">强调</em>结尾。</p>` +
		`<p id="b">乙文<em>强调</em>结尾。</p></div>`,
	);
	const segs = draftPending(collectWith(doc));
	doc.getElementById("ae").firstChild.nodeValue = "改了";

	koine.insertTranslations(segs);
	assert.equal(doc.getElementById("a").textContent, "甲文改了结尾。", "drift 的那顆整批放棄");
	assert.equal(doc.getElementById("b").textContent, "譯‹乙文›譯‹强调›譯‹结尾。›", "另一顆照寫");
});

test("自吞防護：換過字的碎片段再次採集整棵跳過、不產生新段", () => {
	const doc = docFrom(`<div lang="zh-CN"><p id="p">简体<em>强调</em>段落。</p></div>`);
	koine.insertTranslations(draftPending(collectWith(doc)));
	assert.equal(collectWith(doc).length, 0, "已標記的 block 應被 classifyNode 自家標記擋下");
});

test("站台事後換掉內容 → 標記與現值對不上、當新內容重採", () => {
	const doc = docFrom(`<div lang="zh-CN"><p id="p">简体<em id="e">强调</em>段落。</p></div>`);
	koine.insertTranslations(draftPending(collectWith(doc)));
	const p = doc.getElementById("p");
	p.firstChild.nodeValue = "换了新的简体内容";
	p.removeChild(doc.getElementById("e"));
	p.lastChild.nodeValue = "另一段。";

	const again = collectWith(doc);
	assert.deepEqual(sourcesOf(again), ["换了新的简体内容另一段。"], "新內容應被當未譯重採");
	assert.equal(again[0].anchor.insertMode, "replace", "只剩純文字子代 ⇒ 回到整段原地換字");
});

test("碎片軸換過字的 block 退回並列插回時，會清掉停在上一輪的兩個標記", () => {
	const doc = docFrom(`<div lang="zh-CN"><p id="p">简体<em id="e">强调</em>段落。</p></div>`);
	koine.insertTranslations(draftPending(collectWith(doc)));
	const p = doc.getElementById("p");
	// 站台把段換成英文：語言對軸不再成立 ⇒ 下一輪走並列插回。
	p.textContent = "A brand new English paragraph here.";

	const again = draftPending(collectWith(doc));
	assert.equal(again[0].anchor.insertMode, "after-segment");
	koine.insertTranslations(again);
	assert.ok(!p.hasAttribute("data-koine-translated"), "上一輪的防自吞標記須清掉");
	assert.ok(!p.hasAttribute("data-koine-original"), "上一輪的原文備份須清掉");
});

// ---------------------------------------------------------------------------
// 生產接線：逐段呼叫（translateSegment → insertTranslations([seg])）
//
// 上面的批次形斷言把同顆 block 的碎片一次送進 insertTranslations，而生產路徑是一段一段送、
// 一段一段插回（observeSegments 的 onEnter 掛的就是 translateSegment）。「以 block 為單位
// 全有或全無」必須在這條路上也成立——結算得跨呼叫，否則每次呼叫只看得到一顆碎片，等同逐顆
// 各寫各的：一顆失敗、其餘照寫，最後那道防自吞標記仍會被寫上，半譯狀態被鎖住且不會自癒。
// ---------------------------------------------------------------------------

/** 依 id → 回覆內容的對照表建一個 fake send（值為 null ⇒ 回 { error }）。 */
function sendFrom(replies) {
	return async (req) => {
		const reply = replies[req.id];
		if (reply === null) return { id: req.id, error: "boom" };
		return { id: req.id, text: reply === undefined ? DRAFT({ source: req.source }) : reply };
	};
}

test("逐段送翻：一顆碎片譯失敗 → 整顆 block 一個字都不寫、不留標記", async () => {
	const doc = docFrom(`<div lang="zh-CN"><p id="p">简体<em>强调</em>段落。</p></div>`);
	const segs = collectWith(doc);
	assert.equal(segs.length, 3, "前提：本段拆成三顆碎片");
	const send = sendFrom({ [segs[1].id]: null });

	for (const seg of segs) await koine.translateSegment(seg, send);

	const p = doc.getElementById("p");
	assert.equal(p.textContent, "简体强调段落。", "已譯成的兩顆也不得寫進去");
	assert.ok(!p.hasAttribute("data-koine-translated"), "不得留防自吞標記");
	assert.ok(!p.hasAttribute("data-koine-original"), "不得留原文備份");
	assert.deepEqual(sourcesOf(collectWith(doc)), ["简体", "强调", "段落。"], "下一輪應整段重採");
});

test("逐段送翻：兄弟未到齊前不寫，最後一顆到齊才整批寫入", async () => {
	const doc = docFrom(`<div lang="zh-CN"><p id="p">简体<em>强调</em>段落。</p></div>`);
	const segs = collectWith(doc);
	const send = sendFrom({});
	const p = doc.getElementById("p");

	await koine.translateSegment(segs[0], send);
	assert.equal(p.textContent, "简体强调段落。", "第一顆回來時整顆 block 還不該動");
	assert.ok(!p.hasAttribute("data-koine-translated"));
	await koine.translateSegment(segs[1], send);
	assert.equal(p.textContent, "简体强调段落。", "第二顆回來時仍不該動");

	await koine.translateSegment(segs[2], send);
	assert.equal(p.textContent, "譯‹简体›譯‹强调›譯‹段落。›", "最後一顆到齊才整批寫入");
	assert.equal(p.getAttribute("data-koine-translated"), p.textContent);
	assert.equal(p.getAttribute("data-koine-original"), "简体强调段落。");
	assert.equal(p.querySelector("em").textContent, "譯‹强调›", "元素結構原樣保留");
});

test("逐段送翻：譯文＝原文（空字串）的碎片照樣算到齊，其餘照寫", async () => {
	// 簡繁同形在碎片軸是常態（拆出來的「看」「吧」兩顆都不會變），不算到齊的話整顆 block 永遠寫不出來。
	const doc = docFrom(`<div lang="zh-CN"><p id="p">简体<em>强调</em>段落。</p></div>`);
	const segs = collectWith(doc);
	const send = sendFrom({ [segs[1].id]: "" });

	for (const seg of segs) await koine.translateSegment(seg, send);

	const p = doc.getElementById("p");
	assert.equal(p.textContent, "譯‹简体›强调譯‹段落。›", "空字串那顆保持原值、其餘照寫");
	assert.equal(p.getAttribute("data-koine-translated"), p.textContent);
});

test("逐段送翻：譯文＝原文的碎片在到達前被站台改掉 → 整批放棄，下一輪重採", async () => {
	// 不寫字不等於免驗：空字串碎片不進 writes，而 writes 是到達時那道 drift 檢查掃的唯一清單。
	// 漏驗的話整顆 block 照樣被判全員有效而寫入譯文與防自吞標記，站台剛換上的新內容被鎖成已譯。
	const doc = docFrom(`<div lang="zh-CN"><p id="p">简体<em>强调</em>段落。</p></div>`);
	const segs = collectWith(doc);
	const send = sendFrom({ [segs[1].id]: "" }); // 中間那顆簡繁同形、譯文＝原文
	const p = doc.getElementById("p");

	await koine.translateSegment(segs[0], send);
	p.querySelector("em").firstChild.nodeValue = "页面自己改了"; // 空字串那顆在到達前就被換掉
	await koine.translateSegment(segs[1], send);
	await koine.translateSegment(segs[2], send);

	assert.equal(p.textContent, "简体页面自己改了段落。", "任一顆失效＝整批不寫");
	assert.ok(!p.hasAttribute("data-koine-translated"), "不得留防自吞標記");
	assert.ok(!p.hasAttribute("data-koine-original"), "不得留原文備份");
	assert.deepEqual(sourcesOf(collectWith(doc)), ["简体", "页面自己改了", "段落。"], "下一輪應整段重採");
});

test("逐段送翻：譯文＝原文的碎片到達後被站台改掉 → 套用前重驗擋下，整批放棄", async () => {
	// 第二個檢查點同理：空字串碎片到達時驗過了，兄弟到齊前站台仍可能換掉它。
	const doc = docFrom(`<div lang="zh-CN"><p id="p">简体<em>强调</em>段落。</p></div>`);
	const segs = collectWith(doc);
	const send = sendFrom({ [segs[1].id]: "" });
	const p = doc.getElementById("p");

	await koine.translateSegment(segs[0], send);
	await koine.translateSegment(segs[1], send);
	p.querySelector("em").firstChild.nodeValue = "页面自己改了"; // 驗過之後、最後一顆到齊之前
	await koine.translateSegment(segs[2], send);

	assert.equal(p.textContent, "简体页面自己改了段落。", "任一顆失效＝整批不寫");
	assert.ok(!p.hasAttribute("data-koine-translated"), "不得留防自吞標記");
	assert.ok(!p.hasAttribute("data-koine-original"), "不得留原文備份");
	assert.deepEqual(sourcesOf(collectWith(doc)), ["简体", "页面自己改了", "段落。"], "下一輪應整段重採");
});

test("逐段送翻：等待期間站台改掉已驗過的碎片 → 套用前重驗擋下，整批放棄", async () => {
	// 逐顆到達時各驗一次、寫入卻等到最後一顆才做，中間這段時間站台仍可能改字。
	const doc = docFrom(`<div lang="zh-CN"><p id="p">简体<em>强调</em>段落。</p></div>`);
	const segs = collectWith(doc);
	const send = sendFrom({});
	const p = doc.getElementById("p");

	await koine.translateSegment(segs[0], send);
	await koine.translateSegment(segs[1], send);
	p.firstChild.nodeValue = "页面自己改了"; // 已驗過的第一顆，在套用前被換掉
	await koine.translateSegment(segs[2], send);

	assert.equal(p.textContent, "页面自己改了强调段落。", "任一顆失效＝整批不寫");
	assert.ok(!p.hasAttribute("data-koine-translated"), "不得留防自吞標記");
	assert.ok(!p.hasAttribute("data-koine-original"), "不得留原文備份");
});

test("逐段送翻：兩顆 block 交錯送翻，各自到齊各自結算", async () => {
	const doc = docFrom(
		`<div lang="zh-CN"><p id="a">甲文<em>强调</em>结尾。</p>` +
		`<p id="b">乙文<em>强调</em>结尾。</p></div>`,
	);
	const segs = collectWith(doc);
	const a = doc.getElementById("a");
	const b = doc.getElementById("b");
	const bSegs = segs.filter((s) => s.anchor.block === b);
	const send = sendFrom({ [bSegs[2].id]: null });

	// 交錯：兩顆 block 的碎片輪流回來（文件序就是交錯的來源，這裡照 order 送）。
	for (const seg of segs) await koine.translateSegment(seg, send);

	assert.equal(a.textContent, "譯‹甲文›譯‹强调›譯‹结尾。›", "自己到齊的 block 照寫");
	assert.equal(a.getAttribute("data-koine-translated"), a.textContent);
	assert.equal(b.textContent, "乙文强调结尾。", "有一顆譯失敗的 block 整批放棄");
	assert.ok(!b.hasAttribute("data-koine-translated"));
});

test("逐段送翻：整批寫入後重複插回同一批碎片不會寫第二次", async () => {
	const doc = docFrom(`<div lang="zh-CN"><p id="p">简体<em>强调</em>段落。</p></div>`);
	const segs = collectWith(doc);
	const send = sendFrom({});
	for (const seg of segs) await koine.translateSegment(seg, send);
	const p = doc.getElementById("p");
	const translated = p.textContent;

	koine.insertTranslations(segs); // 呼叫端重送（防禦路徑）

	assert.equal(p.textContent, translated, "譯文不得被再寫一輪");
	assert.equal(p.getAttribute("data-koine-original"), "简体强调段落。", "原文備份仍是最初的原文");
});

test("逐段送翻：判掉的碎片（標點）被站台改掉 → 整批放棄，新內容不被標記鎖住", async () => {
	// 判掉的碎片不進 total、也沒有快照，逐碎片的兩道檢查都掃不到它；而防自吞標記的值是整顆
	// textContent ⇒ 漏比 block 級文字就會把站台剛換上的新內容包進標記，整棵永遠跳過且不自癒。
	const doc = docFrom(`<div lang="zh-CN"><p id="p">在线人数 <b id="b">—</b> 人</p></div>`);
	const segs = collectWith(doc);
	assert.equal(segs.filter((s) => s.state === koine.SegmentState.SKIPPED).length, 1, "前提：標點那顆被判掉");
	const send = sendFrom({});
	const p = doc.getElementById("p");

	await koine.translateSegment(segs[0], send);
	doc.getElementById("b").firstChild.nodeValue = "加载完成"; // 站台把佔位符換成真內容
	await koine.translateSegment(segs[2], send);

	assert.equal(p.textContent, "在线人数 加载完成 人", "任一處文字對不上＝整批不寫");
	assert.ok(!p.hasAttribute("data-koine-translated"), "不得留防自吞標記");
	assert.ok(!p.hasAttribute("data-koine-original"), "不得留原文備份");
	assert.deepEqual(sourcesOf(collectWith(doc)), ["在线人数", "加载完成", "人"], "下一輪應連新內容一起重採");
});

test("逐段送翻：剪枝子樹（hidden）內的文字被站台改掉 → 整批放棄", async () => {
	// 第二類掃不到的文字：fragmentTextNodes 不走訪剪枝子樹，但它的文字仍算進 textContent。
	const doc = docFrom(`<div lang="zh-CN"><p id="p">在线<span id="h" hidden>状态</span>人数<em>更新</em>中</p></div>`);
	const segs = collectWith(doc);
	assert.equal(segs.length, 4, "前提：hidden 子樹不產碎片");
	const send = sendFrom({});
	const p = doc.getElementById("p");

	for (const seg of segs.slice(0, 3)) await koine.translateSegment(seg, send);
	doc.getElementById("h").firstChild.nodeValue = "离线"; // 剪枝子樹內的文字被換掉
	await koine.translateSegment(segs[3], send);

	assert.equal(p.textContent, "在线离线人数更新中", "整批不寫");
	assert.ok(!p.hasAttribute("data-koine-translated"), "不得留防自吞標記");
	assert.ok(!p.hasAttribute("data-koine-original"), "不得留原文備份");
	assert.deepEqual(sourcesOf(collectWith(doc)), ["在线", "人数", "更新", "中"], "下一輪應整段重採");
});

test("同一顆碎片重複插回不算兩次到達：兄弟未到齊前仍一個字都不寫", () => {
	// 到達數計的是相異碎片、不是插回次數。計成次數的話，呼叫端手動重送同一顆就能湊足到齊數，
	// 兄弟還沒回來就整批寫入 ⇒ 只寫得出半顆 block、防自吞標記卻照樣寫上，整棵從此跳過。
	const doc = docFrom(`<div lang="zh-CN"><p id="p">简体<em>强调</em>段落。</p></div>`);
	const segs = draftPending(collectWith(doc));
	assert.equal(segs.length, 3, "前提：本段拆成三顆碎片");
	const p = doc.getElementById("p");

	koine.insertTranslations([segs[0]]);
	koine.insertTranslations([segs[0]]);
	koine.insertTranslations([segs[0]]); // 同一顆插回三次

	assert.equal(p.textContent, "简体强调段落。", "兄弟未到齊、不得寫入");
	assert.ok(!p.hasAttribute("data-koine-translated"), "不得留防自吞標記");

	koine.insertTranslations([segs[1]]);
	koine.insertTranslations([segs[2]]);
	assert.equal(p.textContent, "譯‹简体›譯‹强调›譯‹段落。›", "三顆相異碎片到齊才整批寫入");
});
