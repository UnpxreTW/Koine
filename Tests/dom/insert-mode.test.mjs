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

/**
 * 跑一段程式並攔下 console.warn，回收集到的訊息。
 * 兩個用途：①故意餵壞值的測試不該每跑必噴 stderr（真的有非預期 warn 會被淹掉）；
 * ②「什麼情況該出聲、什麼情況不該」本身就是一條界線，值得斷言而不是只靠讀碼。
 */
function captureWarn(fn) {
	const original = console.warn;
	/** @type {any[][]} */
	const calls = [];
	console.warn = (...args) => { calls.push(args); };
	try {
		const r = fn();
		// 擋 async：非同步 fn 會在 promise settle 前就還原，只收得到第一個 await 之前的 warn
		// （常常就是空陣列），配上「不得出聲」類斷言
		// （assert.deepEqual(warns, [])）就是靜默假綠——而那正是這個 helper 最該擋住的誤用。
		if (r && typeof r.then === "function") throw new TypeError("captureWarn 只收同步 fn");
	} finally {
		console.warn = original;
	}
	return calls;
}

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
	assertSame(segs[0].anchor.block, doc.getElementById("p"), "anchor.block 應為該 p");
	assert.equal(segs[0].anchor.insertMode, "replace", "簡中來源→繁中目標應就地取代、不並排");
	assert.notEqual(segs[0].kind, "button", "語言對軸與段的種類軸互不冒充");
	assert.equal(segs[0].meta.replaceSnapshot, "这是简体中文段落。", "replace 段須帶防呆快照");
});

test("語言對軸：元素自身 lang 勝過祖先 lang（自身 zh-Hans 在 lang=en 祖先底下仍命中）", () => {
	const doc = docFrom(`<div lang="en"><p id="p" lang="zh-Hans">简体段落。</p></div>`);
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

test("依內容偵測語言尚未實作：整條祖先鏈都沒有 lang 時保守走並列", () => {
	// 語言判定目前只讀 lang 屬性（自身 → 祖先 → 頁面）。查不到就回 null、不從文字去猜。
	// 這條是那個界線的釘子：哪天加了內容偵測、本測試會紅，屆時應連同這段說明一起改，
	// 而不是默默放寬——就地取代是破壞性的，放寬前要先確定偵測夠準。
	const doc = docFrom(`<p id="p">这是没有任何语言标记的简体段落。</p>`);
	assert.equal(collectWith(doc)[0].anchor.insertMode, "after-segment");
});

// ---------------------------------------------------------------------------
// 破壞性防護：replace 會讓原文從頁面消失，觸發條件必須窄
// ---------------------------------------------------------------------------

test("簡中頁上未標 lang 的英文段不得就地取代（頁面級回退會把整頁都套進語言對）", () => {
	// `<html lang="zh-CN">` 對頁內每一個未標 lang 的段都成立——包含英文留言區、英文導覽。
	// 「簡繁字面幾乎相同、並排只是重複」這個理由對它們完全不成立，而 replace 會讓英文原文
	// 從頁面上消失（只剩 data 屬性）。故語言對軸另要求段自身的文字真的是漢字。
	const doc = docFrom(`<p id="p">Subscribe to our newsletter for weekly updates.</p>`, ` lang="zh-CN"`);
	const segs = collectWith(doc);
	assert.equal(segs[0].anchor.insertMode, "after-segment", "英文段必須走並列、不得就地取代");

	draftPending(segs);
	koine.insertTranslations(segs);
	assert.equal(
		doc.getElementById("p").textContent, "Subscribe to our newsletter for weekly updates.",
		"英文原文必須原封不動留在頁面上",
	);
});

test("簡中頁上的日文／韓文段同樣不得就地取代（漢字閘另排除假名與諺文）", () => {
	const doc = docFrom(
		`<p id="ja">日本語のコメント欄です。</p><p id="ko">한국어 댓글입니다.</p>`,
		` lang="zh-CN"`,
	);
	const byId = Object.fromEntries(collectWith(doc).map((x) => [x.anchor.block.id, x]));
	assert.equal(byId.ja.anchor.insertMode, "after-segment", "含假名的段不得就地取代");
	assert.equal(byId.ko.anchor.insertMode, "after-segment", "含諺文的段不得就地取代");
});

test("②軸不得撿走①軸刻意退回的長按鈕（長度閘是按鈕排版的約束、不是語言的約束）", () => {
	const long = "这是一段超过二十个字的很长很长很长的按钮文字内容喔喔喔";
	const doc = docFrom(`<button id="b">${long}</button>`, ` lang="zh-CN"`);
	const segs = collectWith(doc);
	assert.notEqual(segs[0].kind, "button", "超過長度閘不應命中 button-class 窄判準");
	assert.equal(segs[0].anchor.insertMode, "after-segment", "②軸不得繞過①軸的長度閘");
});

test("replace 不覆寫元素既有的 title（站台自己的提示不可被抹掉、且無還原路徑）", () => {
	const doc = docFrom(`<div lang="zh-CN"><p id="p" title="站台原有提示">简体段落内容。</p></div>`);
	const segs = draftPending(collectWith(doc));
	koine.insertTranslations(segs);
	const p = doc.getElementById("p");
	assert.equal(p.getAttribute("title"), "站台原有提示", "既有 title 必須保留");
	assert.equal(p.getAttribute("data-koine-original"), "简体段落内容。", "原文仍存 data 屬性");
	assert.equal(p.textContent, segs[0].draft, "換字本身照做");
});

test("過長的原文不寫進 title（整段 tooltip 會被輔助技術當可及描述唸出）", () => {
	const long = "这是一段很长的简体中文段落内容用来测试标题属性的长度上限行为是否正确。";
	assert.ok(long.length > koine.REPLACE_TITLE_MAX_CHARS, "前提：測試字串需超過上限");
	const doc = docFrom(`<div lang="zh-CN"><p id="p">${long}</p></div>`);
	const segs = draftPending(collectWith(doc));
	koine.insertTranslations(segs);
	const p = doc.getElementById("p");
	assert.ok(!p.hasAttribute("title"), "超過上限不寫 title");
	assert.equal(p.getAttribute("data-koine-original"), long, "原文仍完整存在 data 屬性");
	assert.equal(p.textContent, segs[0].draft);
});

test("短原文仍寫 title（按鈕軸的既有行為不因新規則改變）", () => {
	const doc = docFrom(`<div lang="zh-CN"><p id="p">简体短句。</p></div>`);
	const segs = draftPending(collectWith(doc));
	koine.insertTranslations(segs);
	assert.equal(doc.getElementById("p").getAttribute("title"), "简体短句。");
});

test('lang="" ＝語言未知、不繼承祖先（HTML 規範）：簡中頁內的空 lang 區塊不得就地取代', () => {
	// `lang=""` 在 HTML 規範裡是「語言未知」，明確**不**繼承祖先。若把「沒有 lang 屬性」與
	// 「lang 為空字串」折成同一態，`<div lang="">` 就會靜默吃到 `<html lang="zh-CN">`——
	// 而這一側是破壞性的（誤判成簡中即就地取代、原文從頁面消失）。漢字安全閘擋不住這個
	// 情境：內容本來就是漢字。
	const doc = docFrom(`<div lang=""><p id="p">这是简体中文段落内容。</p></div>`, ` lang="zh-CN"`);
	const segs = collectWith(doc);
	assert.equal(segs[0].anchor.insertMode, "after-segment", 'lang="" 應阻斷繼承、不得就地取代');

	draftPending(segs);
	koine.insertTranslations(segs);
	assert.equal(doc.getElementById("p").textContent, "这是简体中文段落内容。", "原文必須留在頁面上");

	// 對照：祖先真的是 zh-CN（無空 lang 阻斷）→ 照常就地取代，證明上面不是整條軸壞掉。
	const ctrl = docFrom(`<div lang="zh-CN"><p id="p">这是简体中文段落内容。</p></div>`);
	assert.equal(collectWith(ctrl)[0].anchor.insertMode, "replace");
});

test('lang="" 在兩條語言查詢路徑上答案一致（下行增量 vs closest 防禦路徑；shadow 邊界的既有落差不在此測）', () => {
	// 採集路徑讀 NodeLabel.lang（下行增量）、防禦路徑走 effectiveLangOf(closest)。兩者分歧
	// 時，未進 labels 的節點（動態重採、離線片段）會走到與採集期相反的判定。
	const doc = docFrom(`<div lang=""><p id="p">这是简体中文段落内容。</p></div>`, ` lang="zh-CN"`);
	const p = doc.getElementById("p");
	assert.equal(koine.effectiveLangOf(p), "", 'closest 路徑應回 ""（語言未知）、不是 null 也不是 zh-cn');
	assert.equal(koine.ownLangOf(doc.querySelector("div")), "", 'ownLangOf 對 lang="" 應回 ""');
	assert.equal(koine.ownLangOf(p), null, "無 lang 屬性應回 null（＝繼承）");
	assert.equal(koine.isSimplifiedChinese(""), false, '"" 不是簡中語碼');
});

test("縮排排版的按鈕仍寫 title：長度閘比的是 normalize 後的 source、不是原始 textContent", () => {
	// 多行排版是真實 HTML 的主流寫法。窄判準卡的是 source.length（normalize 後），若 title
	// 閘改比 snapshot.length（含縮排）就會兩邊比錯，同一顆按鈕寫一行有 title、寫三行沒有。
	const doc = docFrom(`<button id="b">\n          确认提交\n        </button>`);
	const segs = collectWith(doc);
	assert.equal(segs[0].source, "确认提交");
	assert.ok(segs[0].meta.replaceSnapshot.length > koine.REPLACE_TITLE_MAX_CHARS, "前提：原始快照含縮排、超過上限");

	draftPending(segs);
	koine.insertTranslations(segs);
	const b = doc.getElementById("b");
	assert.equal(b.getAttribute("title"), "确认提交", "title 應為 normalize 後的原文、不帶縮排");
	assert.equal(
		b.getAttribute("data-koine-original"), segs[0].meta.replaceSnapshot,
		"data-koine-original 仍存逐字快照（還原用、連空白一起留）",
	);
});

test("非字串譯文不得寫進 DOM：replace 分支寫壞後除非節點被換掉否則不自癒（比 after-segment 嚴重得多）", () => {
	// 非字串 text 會被 `block.textContent = text` 寫成 "[object Object]"，同時 data-koine-translated
	// 被設上 → classifyNode [1] 之後每次採集都整棵跳過，除非該節點被換掉或標記被清否則不自癒，
	// 而原文只剩在
	// data-koine-original（還原路徑尚未實作）。同一個壞值走 after-segment 只是多一個垃圾
	// wrapper、原文完好——所以守衛對 replace 分支才是要緊的那個。
	const doc = docFrom(`<button id="b">确认提交</button><p id="q">Plain paragraph here.</p>`);
	const bad = {
		id: "k9-0", order: 0, region: "main", source: "确认提交", state: koine.SegmentState.DRAFTED,
		draft: { text: "確認提交" }, // 非字串（手搭／未來 refine 寫入端寫壞）
		anchor: { block: doc.getElementById("b"), insertMode: "replace" },
		meta: { replaceSnapshot: "确认提交" },
	};
	const alsoBad = {
		id: "k9-1", order: 1, region: "main", source: "Plain paragraph here.",
		state: koine.SegmentState.DRAFTED, draft: 42,
		anchor: { block: doc.getElementById("q"), insertMode: "after-segment" },
	};
	const warns = captureWarn(() => {
		assert.equal(koine.insertTranslations([bad, alsoBad]).length, 0, "兩個壞值都不得插回");
	});
	assert.equal(warns.length, 2, "兩個型別錯都該出聲（靜默跳過會讓現場呈現成「翻了但沒出現」）");

	const b = doc.getElementById("b");
	assert.equal(b.textContent, "确认提交", "原文必須留著、不得變成 [object Object]");
	assert.ok(!b.hasAttribute("data-koine-translated"), "沒寫成功就不得標記已譯（否則永不重採）");
	assert.equal(doc.querySelectorAll(".koine-translated").length, 0, "after-segment 側也不得插垃圾 wrapper");
});

test("壞掉的 refined 不得蓋掉好的 draft：refined ?? draft 是 refined 勝，那格才是未來的寫入點", () => {
	// `seg.refined` 目前全 repo 無寫入端，是留給 post-edit 層／外部的預留欄——也就是最可能
	// 被寫壞的那一格。取值是 `refined ?? draft`（refined 勝），所以一個壞掉的 refined 會讓
	// 原本正常的 draft 靜默消失。
	const doc = docFrom(`<button id="b">确认提交</button>`);
	const seg = {
		id: "k9-2", order: 0, region: "main", source: "确认提交", state: koine.SegmentState.DRAFTED,
		draft: "確認提交", refined: { text: "確認提交" }, // draft 正常、refined 壞掉
		anchor: { block: doc.getElementById("b"), insertMode: "replace" },
		meta: { replaceSnapshot: "确认提交" },
	};
	const warns = captureWarn(() => {
		assert.equal(koine.insertTranslations([seg]).length, 0, "壞掉的 refined 不得寫進 DOM");
	});
	assert.equal(warns.length, 1, "型別錯該出聲");
	const b = doc.getElementById("b");
	assert.equal(b.textContent, "确认提交", "原文必須留著（不得寫成 [object Object]）");
	assert.ok(!b.hasAttribute("data-koine-translated"), "沒寫成功就不得標記已譯");
});

test("採集 root 限 Element：Document／DocumentFragment 一律 0 段（刻意不支援、非疏漏）", () => {
	// 這條釘的是**範圍限制本身**。逐 commit 實測過：採集 root 閘加入前這兩種容器採得到段，
	// 而且**頂層是 block 元素時整條管線是通的**（段在該 block 上成形、anchor.block 是 Element、
	// 譯文真的插得回去）。收窄的理由不是「完全不能用」，是**同一支 API 兩種結果**：容器頂層
	// 直接掛裸文字或 inline 時，段在容器上成形、anchor.block 就是容器本身（非 Element），
	// insertTranslations 的 block.after 不存在而靜默跳過（段已送翻、譯文丟失無警訊），
	// 或 observeSegments 的 observe(block) 在真 IntersectionObserver 下丟 TypeError 並中止整條
	// 管線——落哪一個取決於該容器 block 上的段是否全部被 eager 預算涵蓋而免於觀察，也就是隨段的
	// 文件序落點而變。
	// <template>.content 與 range.cloneContents() 頂層帶裸文字正是常態形狀。
	//
	// 要真正支援容器 root，得先解掉兩個既有風險（兩者在 root 閘之前就存在）：①頁面級剪枝
	// 豁免掛在 <body> 上，choke point 往上移到 <html> 會讓 <html lang="zh-TW"> 這類主流寫法
	// 整份文件歸零；②容器頂層裸文字／inline 的非 Element anchor。屬另案。
	//
	// 哪天真的支援了，本測試會紅——那時該連同這段說明一起改寫，而不是默默放寬。
	const doc = docFrom(`<p>Hello there friend.</p>`);
	const ctx = koine.makeContext({ getStyle: stubGetStyle, pageLangIsZh: false });
	assert.equal(koine.collectSegments(doc, ctx, { walkId: 1 }).length, 0, "Document 為 root 回 0 段");

	const frag = doc.createDocumentFragment();
	const p = doc.createElement("p");
	p.textContent = "Fragment paragraph here.";
	frag.appendChild(p);
	assert.equal(koine.collectSegments(frag, ctx, { walkId: 1 }).length, 0, "DocumentFragment 為 root 回 0 段");

	// 對照組刻意只差 root 型別、其餘全同（各配對內同一份 doc／同一顆節點），這樣 0 段的唯一
	// 解釋就是 root 型別。documentElement 那條特別重要：少了它，「0 段其實出在 <html> 這層被
	// 判 SKIP」這個競爭解釋還活著。
	assert.equal(
		koine.collectSegments(doc.documentElement, ctx, { walkId: 1 }).length, 1,
		"同一份 doc 改以 documentElement（Element）為 root → 1 段（<html> 那層沒被判 SKIP）",
	);
	assert.equal(
		koine.collectSegments(doc.body, ctx, { walkId: 1 }).length, 1,
		"同一份 doc 改以 body（Element）為 root → 1 段",
	);
	assert.equal(
		koine.collectSegments(p, ctx, { walkId: 1 }).length, 1,
		"同一顆 p（Element）為 root → 1 段",
	);
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
	assertSame(inserted[0], p, "replace 應回傳原元素本身、非新建 wrapper");
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
	for (const t of ["zh", "zh-Hant", "zh-TW", "zh-hant-hk", "zh-HK", "zh-MO"]) {
		assert.equal(koine.isTraditionalChineseTarget(t), true, `${t} 應判為繁中目標`);
	}
	for (const t of ["zh-CN", "zh-Hans", "en", "ja", "", undefined]) {
		assert.equal(koine.isTraditionalChineseTarget(t), false, `${t} 不應判為繁中目標`);
	}
});

// 本函式改走 classifyZhVariant 之前是獨立的字串前綴表，與整頁／段級的變體判定有實測分歧。
// 期望值一律寫成字面常數、不從 classifyZhVariant 推導——推導式期望值會跟著分類器一起漂：
// 分類器自己被改壞（例如 ZH_HANT_REGIONS 掉了 `mo`）時，期望值與實際值同步變動、照樣全綠。
// 字面常數才釘得住這組定義本身。
test("isTraditionalChineseTarget 與變體分類器同一組定義：畸形與非正規標籤不再兩頭錯", () => {
	// 前綴表判 false、實為繁體：底線形是 Apple locale identifier 的形狀，extlang 形合 BCP-47。
	for (const t of ["zh_TW", "zh_HK", "zh_MO", "zh-cmn-Hant-TW"]) {
		assert.equal(koine.isTraditionalChineseTarget(t), true, `${t} 是繁體、應判為繁中目標`);
	}
	// 前綴表判 true、實為「只是前綴恰好撞上」：多一個字母就不再是同一個子標籤。
	for (const t of ["zh-TWx", "zh-hantx", "zh-hkx", "zh-mox"]) {
		assert.equal(koine.isTraditionalChineseTarget(t), false, `${t} 認不出書寫系統、不應判為繁中目標`);
	}
	// script 子標籤勝過地區，且位置無關——`zh-hk-hans` 明寫 Hans，地區提示不得翻案。
	assert.equal(koine.isTraditionalChineseTarget("zh-hk-hans"), false, "明寫 Hans 應判簡體、不吃地區提示");
	// 認不出書寫系統的中文標籤與非中文標籤一律不算：兩者都不能開啟破壞性的就地取代。
	for (const t of ["zh-Latn", "zh-Hani", "zh-CHS", "zh-SG", "yue-HK", "ja-JP"]) {
		assert.equal(koine.isTraditionalChineseTarget(t), false, `${t} 不應判為繁中目標`);
	}
	// 大小寫與前後空白照舊吃得下（沿用分類器的正規化）。
	assert.equal(koine.isTraditionalChineseTarget("  ZH-Tw  "), true, "大小寫與空白應正規化後判定");
});

test("目標語變體判定傳導到語言對軸：zh_TW／zh-cmn-Hant-TW 觸發 replace、zh-TWx 退回並列", () => {
	// 純函式那層只證判定值；這條證它真的傳導到 insertMode 的語言對軸——目標語一旦可設定，
	// 前綴表的兩個方向各自對應一種使用者可見的失效：`zh_TW` 下簡→繁這條軸永不觸發、
	// `zh-TWx` 下反而開著（而該標籤根本認不出書寫系統）。
	const doc = () => docFrom(`<p id="p" lang="zh-CN">这是简体中文段落。</p>`);
	assert.equal(
		collectWith(doc(), { targetLang: "zh_TW" })[0].anchor.insertMode, "replace",
		"底線形繁中目標應照常觸發就地取代"
	);
	assert.equal(
		collectWith(doc(), { targetLang: "zh-cmn-Hant-TW" })[0].anchor.insertMode, "replace",
		"extlang 形繁中目標應照常觸發就地取代"
	);
	assert.equal(
		collectWith(doc(), { targetLang: "zh-TWx" })[0].anchor.insertMode, "after-segment",
		"認不出書寫系統的目標語不得開啟破壞性的就地取代"
	);
});

test("effectiveLangOf：自身優先於祖先、查無回 null", () => {
	const doc = docFrom(`<div lang="zh-CN"><p id="self" lang="EN "> x </p><p id="inherit">y</p></div>`);
	assert.equal(koine.effectiveLangOf(doc.getElementById("self")), "en", "自身 lang 應勝出、且已小寫 trim");
	assert.equal(koine.effectiveLangOf(doc.getElementById("inherit")), "zh-cn", "無自身 lang 應取最近祖先");

	const bare = docFrom(`<p id="p">z</p>`);
	assert.equal(koine.effectiveLangOf(bare.getElementById("p")), null, "整條祖先鏈無 lang 應回 null");
});

test("isSimplifiedChinese：簡中語碼變體全命中、其餘不命中", () => {
	for (const lang of ["zh-cn", "zh-hans", "zh-hans-cn"]) {
		assert.equal(koine.isSimplifiedChinese(lang), true, `${lang} 應命中`);
	}
	for (const lang of ["zh-tw", "zh-hant", "zh", "en", "ja", null, undefined, ""]) {
		assert.equal(koine.isSimplifiedChinese(lang), false, `${lang} 不應命中`);
	}
});

test("ownLangOf：只讀自身屬性、已小寫 trim、無屬性回 null", () => {
	const doc = docFrom(`<div lang="ZH-CN "><p id="p">x</p></div>`);
	assert.equal(koine.ownLangOf(doc.querySelector("div")), "zh-cn");
	assert.equal(koine.ownLangOf(doc.getElementById("p")), null, "自身無 lang 不吃祖先");
});

test("有效終態不得出聲：未譯（null／undefined）與譯文＝原文（空字串）都靜默跳過", () => {
	// `text == null` 與 `""` 是有效終態（§9.1），跳過是對的、不該吵。這條同時釘住一個很容易
	// 犯的簡化：把 `text == null` 當成被下面的 `typeof` 涵蓋而刪掉——刪了之後每個未譯段都會
	// 噴一則 warn。
	const doc = docFrom(`<p id="a">Alpha paragraph here.</p><p id="b">Beta paragraph here.</p><p id="c">Gamma paragraph here.</p>`);
	const mk = (id, draft) => ({
		id: `k8-${id}`, order: 0, region: "main", source: "x", state: koine.SegmentState.DRAFTED,
		draft, anchor: { block: doc.getElementById(id), insertMode: "after-segment" },
	});
	const segs = [mk("a", null), mk("b", undefined), mk("c", "")];
	const warns = captureWarn(() => {
		assert.equal(koine.insertTranslations(segs).length, 0, "三者都不插回");
	});
	assert.deepEqual(warns, [], "有效終態一則 warn 都不該有");
	assert.equal(doc.querySelectorAll(".koine-translated").length, 0, "不得插 wrapper");
});
