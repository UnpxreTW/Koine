// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：§3.6 逐段語言 —— 每一段自己帶著採集期算好的有效 lang，送翻時當來源語。
//
// 本檔驗三件事：
// ① 整頁語言不再是「要不要送翻」的 gate——繁中頁上的漢字段照樣 pending（已達標與否改由
//    native 端依內容判定，JS 端表達不了）。
// ② 三種採集單位（段／屬性／碎片）都帶 lang，值＝最近帶 lang 的祖先（含 <html>）。
// ③ 送翻時的 from 逐段各異；`lang=""`（語言未知）明確不送，不拿祖先的值頂替。

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
	const ctx = koine.makeContext({ getStyle: stubGetStyle, ...ctxOpts });
	return koine.collectSegments(doc.body, ctx, { walkId: 1 });
}

const bySource = (segs, source) => segs.find((s) => s.source === source);

// ---------------------------------------------------------------------------
// ① 整頁語言不再擋下漢字段
// ---------------------------------------------------------------------------

test("繁中頁內嵌的簡中區塊送得出去，且就地換字", () => {
	// 這是整個改動的目標案例：修前 `<html lang="zh-TW">` 上的每一個漢字段都判 already-target，
	// 內嵌的簡中區塊一併被判掉 ⇒ 簡→繁就地換字這條路永遠走不到。
	const doc = docFrom(
		`<p>這是繁體段落。</p><div lang="zh-CN"><p>这是简体段落。</p></div>`,
		` lang="zh-TW"`,
	);
	const segs = collectWith(doc);
	const hans = bySource(segs, "这是简体段落。");
	assert.ok(hans, "簡中段應該被採到");
	assert.equal(hans.state, koine.SegmentState.PENDING, "不得再被整頁語言判掉");
	assert.equal(hans.lang, "zh-cn");
	assert.equal(hans.anchor.insertMode, "replace", "簡中來源配繁中目標＝就地換字");
});

test("繁中頁上的繁中段照樣 pending——已達標與否改由 native 端判", () => {
	const doc = docFrom(`<p>這是繁體段落。</p>`, ` lang="zh-TW"`);
	const [seg] = collectWith(doc);
	assert.equal(seg.state, koine.SegmentState.PENDING);
	assert.equal(seg.meta?.skipReason, undefined, "不應留下任何 skipReason");
	assert.equal(seg.anchor.insertMode, "after-segment", "繁中來源不走就地換字");
});

test("其餘八條判準不受影響：URL／純數字／email 照樣判掉", () => {
	// 對照組：拆掉整頁語言那一條之後，worthTranslating 的其他規則必須原封不動。
	assert.equal(koine.worthTranslating("https://example.com/a").reason, "url");
	assert.equal(koine.worthTranslating("2026").reason, "numeric");
	assert.equal(koine.worthTranslating("a@example.com").reason, "email");
	assert.equal(koine.worthTranslating("Q").reason, "min-length");
	assert.equal(koine.worthTranslating("已經是繁體中文的段落").worth, true);
});

// ---------------------------------------------------------------------------
// ② 三種採集單位都帶 lang
// ---------------------------------------------------------------------------

test("段的 lang＝最近帶 lang 的祖先，含 <html> 的頁面級回退", () => {
	const doc = docFrom(
		`<p>頁面語言段。</p><section lang="ja"><p>日本語の段落です。</p></section>`,
		` lang="zh-TW"`,
	);
	const segs = collectWith(doc);
	assert.equal(bySource(segs, "頁面語言段。").lang, "zh-tw", "無自身 lang → 取 <html>");
	assert.equal(bySource(segs, "日本語の段落です。").lang, "ja", "最近的祖先勝過頁面");
});

test("整條祖先鏈都沒有 lang → null；lang=\"\" → 空字串（語言未知、不繼承）", () => {
	const noLang = collectWith(docFrom(`<p>沒有任何語言標記。</p>`));
	assert.equal(noLang[0].lang, null);
	const unknown = collectWith(docFrom(`<div lang=""><p>語言未知的段落。</p></div>`, ` lang="zh-TW"`));
	assert.equal(unknown[0].lang, "", "空字串不得折成 null、也不得繼承 zh-tw");
});

test("屬性段帶宿主元素的 lang", () => {
	const doc = docFrom(`<div lang="zh-CN"><img alt="一只睡着的猫"></div>`, ` lang="zh-TW"`);
	const seg = bySource(collectWith(doc), "一只睡着的猫");
	assert.ok(seg, "屬性段應該被採到");
	assert.equal(seg.kind, "attribute");
	assert.equal(seg.lang, "zh-cn");
});

test("屬性宿主自己標的 lang 勝過祖先——宿主多半是走訪不下探的元素", () => {
	// `<img>`／`<input>` 是剪枝標籤、`<code>` 是不可分割的行內原子，走訪層對這兩類只記繼承值
	// （原本沒有讀者）。照採那個值會讓宿主自己標的 lang 整批被丟掉。
	const doc = docFrom(
		`<img lang="en" alt="Download the report">`
		+ `<input lang="ja" placeholder="キーワード">`
		+ `<p><code lang="en" title="shell prompt">$</code></p>`,
		` lang="zh-Hant"`,
	);
	const segs = collectWith(doc);
	assert.equal(bySource(segs, "Download the report").lang, "en");
	assert.equal(bySource(segs, "キーワード").lang, "ja");
	assert.equal(bySource(segs, "shell prompt").lang, "en");
});

test("碎片段共用整段軸算好的 lang", () => {
	const doc = docFrom(`<div lang="zh-CN"><p>简体<strong>加粗</strong>段落。</p></div>`, ` lang="zh-TW"`);
	const frags = collectWith(doc).filter((s) => s.kind === "fragment");
	assert.ok(frags.length >= 2, `應拆出多顆碎片，實得 ${frags.length}`);
	for (const frag of frags) assert.equal(frag.lang, "zh-cn");
});

// ---------------------------------------------------------------------------
// ③ 送翻時的 from
// ---------------------------------------------------------------------------

/** 捕捉送出的 bridge 請求；回 `{ text: "" }`（＝譯文＝原文，不觸發插回）。 */
function captureSend(sent) {
	return async (req) => {
		sent.push(req);
		return { id: req.id, text: "" };
	};
}

test("from 逐段各異：同一頁的兩段送出兩個不同的來源語", async () => {
	const doc = docFrom(
		`<p>這是繁體段落。</p><div lang="zh-CN"><p>这是简体段落。</p></div>`,
		` lang="zh-TW"`,
	);
	const segs = collectWith(doc).filter((s) => s.state === koine.SegmentState.PENDING);
	const sent = [];
	const send = captureSend(sent);
	for (const seg of segs) await koine.translateSegment(seg, send, { to: "zh-Hant" });
	assert.deepEqual(
		sent.map((r) => r.from),
		["zh-tw", "zh-cn"],
		"修前兩段共用同一個頁面級 from",
	);
});

test("lang=\"\"（語言未知）與整條鏈都沒標 lang 一視同仁：都用回退值", async () => {
	// 回退值是取樣所得、由內容導出，拿它補在這裡不違反 `lang=""` 的「別繼承祖先」語義；
	// 不補則線上契約會把缺席的 from 補成英文，一段中文就會被拿去走英文→中文。
	const doc = docFrom(`<div lang=""><p>語言未知的段落。</p></div>`, ` lang="zh-TW"`);
	const [seg] = collectWith(doc);
	assert.equal(seg.lang, "", "段上仍原樣記錄「語言未知」、不折成 zh-tw");
	const sent = [];
	await koine.translateSegment(seg, captureSend(sent), { from: "zh-Hant", to: "zh-Hant" });
	assert.equal(sent[0].from, "zh-Hant");
});

test("沒有回退值可用時才真的不送 from", async () => {
	const doc = docFrom(`<div lang=""><p>語言未知的段落。</p></div>`, ` lang="zh-TW"`);
	const [seg] = collectWith(doc);
	const sent = [];
	await koine.translateSegment(seg, captureSend(sent), { to: "zh-Hant" });
	assert.equal(sent[0].from, undefined);
});

test("整條祖先鏈都沒有 lang 的段落到呼叫端給的回退值", async () => {
	const doc = docFrom(`<p>沒有任何語言標記。</p>`);
	const [seg] = collectWith(doc);
	const sent = [];
	await koine.translateSegment(seg, captureSend(sent), { from: "en", to: "zh-Hant" });
	assert.equal(sent[0].from, "en");
});

test("碎片的 lang 逐顆各算：block 內夾著別的語言不會被套上 block 的答案", () => {
	const doc = docFrom(
		`<div lang="zh-CN"><p>简体<span lang="en">plain text</span>段落。</p></div>`,
		` lang="zh-TW"`,
	);
	const frags = collectWith(doc).filter((s) => s.kind === "fragment");
	const en = frags.find((s) => s.source === "plain text");
	assert.ok(en, `應採到英文碎片，實得 ${JSON.stringify(frags.map((s) => s.source))}`);
	assert.equal(en.lang, "en", "拿 block 級的 zh-cn 去套等於宣稱這截英文是簡體");
	assert.equal(frags.find((s) => s.source === "简体").lang, "zh-cn");
});

// ---------------------------------------------------------------------------
// ④ 整份文件都沒有 lang 時的取樣回退
// ---------------------------------------------------------------------------

test("取樣回退：像中文的頁面回目標語本身", () => {
	assert.equal(koine.sampledPageLang("這是一段中文內容", "zh-Hant"), "zh-Hant");
	assert.equal(koine.sampledPageLang("这是一段中文内容", "zh-Hans"), "zh-Hans");
});

test("取樣回退：不像中文就不猜——寧可不送 from，也不送一個猜來的語碼", () => {
	assert.equal(koine.sampledPageLang("This is English text", "zh-Hant"), undefined);
	assert.equal(koine.sampledPageLang("これは日本語のテキストです", "zh-Hant"), undefined, "假名");
	assert.equal(koine.sampledPageLang("한국어 텍스트입니다", "zh-Hant"), undefined, "諺文");
	assert.equal(koine.sampledPageLang("", "zh-Hant"), undefined);
});

test("取樣回退看漢字占比、不是「有沒有漢字」", () => {
	// 一條語言切換連結就能讓純英文站命中，而這個值會套到全頁每一個沒有標記的段上——
	// 站上的短英文文案會在偵測信心不足時被判成已達標而整批不翻。
	assert.equal(koine.sampledPageLang("Home About Contact Sign in 中文", "zh-Hant"), undefined);
	assert.equal(koine.sampledPageLang("English | 中文", "zh-Hant"), undefined);
	// 中文頁夾雜英文術語仍遠在門檻之上。
	assert.equal(
		koine.sampledPageLang("這份文件說明如何在專案裡使用 WebKit 與 Safari 擴充功能。", "zh-Hant"),
		"zh-Hant",
	);
});

test("回退值取自那些沒有標記的段、不是整份 textContent——追蹤碼稀釋不掉中文頁", () => {
	// `<body>` 開頭一段追蹤碼就能把 500 字視窗灌滿非漢字。段的原文已經過採集期剪枝
	// （SCRIPT／STYLE 在 SKIP_SUBTREE_TAGS 內），拿它取樣就不會被稀釋。
	const noise = `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}${"gtag('config','G-XXXXXXXX');".repeat(10)}`;
	const doc = docFrom(`<script>${noise}</script><p>這是一段完整的中文內容，用來確認取樣判定。</p>`);
	const segs = collectWith(doc);
	assert.equal(koine.fallbackSourceLang(segs, "zh-Hant"), "zh-Hant");
	// 對照組：同一份雜訊真的足以讓整份文字判不出來（否則本條可能恆真）。
	assert.equal(koine.sampledPageLang(`${noise}這是一段完整的中文內容，用來確認取樣判定。`.slice(0, 500), "zh-Hant"), undefined);
});

test("回退值不算判掉的段——一排頁首連結稀釋不掉中文頁", () => {
	// URL／路徑／信箱依定義就是非漢字，對占比的分母是單向貢獻；而 from 本來也只有 pending
	// 的段讀得到。
	const doc = docFrom([
		`<p>https://example.com/a/very/long/path/to/some/article</p>`,
		`<p>https://example.com/another/long/path/to/a/second/article</p>`,
		`<p>Sources/Extension/Resources/content.js</p>`,
		`<p>someone.with.a.long.name@example.com</p>`,
		`<p>這是一段完整的中文內容，用來確認取樣判定。</p>`,
	].join(""));
	const segs = collectWith(doc);
	const skipped = segs.filter((seg) => seg.state === koine.SegmentState.SKIPPED).length;
	assert.ok(skipped >= 4, `前四段應被判掉，實得 ${skipped}`);
	assert.equal(koine.fallbackSourceLang(segs, "zh-Hant"), "zh-Hant");
	// 對照組：連判掉的段一起算就會被稀釋到門檻以下。
	const all = segs.filter((seg) => !seg.lang).map((seg) => seg.source).join(" ").slice(0, 500);
	assert.equal(koine.sampledPageLang(all, "zh-Hant"), undefined);
});

test("每一段都有 lang 時不取樣、不回退", () => {
	const segs = collectWith(docFrom(`<p>這是繁體段落。</p>`, ` lang="zh-TW"`));
	assert.equal(koine.fallbackSourceLang(segs, "zh-Hant"), undefined);
});

// ---------------------------------------------------------------------------
// ⑤ 現況特徵化：元素級的「自身 lang 已達標」閘不在本次範圍內
// ---------------------------------------------------------------------------

test("繁中 lang 標在容器元素上時，內嵌的簡中區塊連段都不產（現況）", () => {
	// 採集 root ＝ <body>，`<html>` 根本不進走訪，故 `<html lang="zh-TW">` 那一形通得過；
	// 標在任何容器元素上則命中 classifyNode 的元素級 already-target 閘、整棵跳過。
	// 本次只移除整頁級 gate，元素級那道不在範圍內——這條釘住現況，改動它時會被這裡擋一下。
	// ⚠ 只斷言條數、不對段物件本身用 deepEqual：段帶著 live DOM 節點，結構 diff 會讓整個
	//   測試檔卡住上百秒（見 helpers.mjs 的 assertSame 註解）。
	const onContainer = collectWith(
		docFrom(`<section lang="zh-TW"><div lang="zh-CN"><p>这是简体段落。</p></div></section>`),
	).filter((seg) => seg.source === "这是简体段落。").length;
	assert.equal(onContainer, 0, "容器上標 lang 的形");
});

test("makeContext 的 falsy 目標語回退到預設值", () => {
	// 改成 `??` 會讓 `targetLang: ""` 靜默留成空字串，`isTraditionalChineseTarget("")` 為 false
	// ⇒ 就地換字整條軸關掉，而其餘測試照樣全綠。原本釘這條的檔案本次已刪，斷言搬到這裡。
	assert.equal(koine.DEFAULT_TARGET_LANG, "zh-Hant");
	for (const falsy of ["", null, undefined]) {
		assert.equal(koine.makeContext({ targetLang: falsy }).targetLang, koine.DEFAULT_TARGET_LANG);
	}
});

test("取樣回退：目標語非中文時一律不猜", () => {
	// 取樣認得出的只有書寫系統，表達不了「這頁已經是日文」。
	assert.equal(koine.sampledPageLang("これは日本語です", "ja"), undefined);
	assert.equal(koine.sampledPageLang("這是一段中文內容", "en"), undefined);
});
