// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：§4.9 detectPageLangIsZh 頁面語言偵測測試（P2）。
// 驗 lang 屬性優先分支（zh-Hant/zh-TW/zh-HK/裸 zh → true；zh-CN/zh-Hans → false；
// 明確非 zh 語碼 → false）與缺 lang 屬性時的取樣文字 heuristic fallback；
// 並驗 main() 的消費端 R9 already-target gate 真的能被 pageLangIsZh 觸發（P2 修的是這條路徑）。
// 未帶 targetLang 的斷言＝目標語取預設值（DEFAULT_TARGET_LANG，繁中）下的行為；
// 目標語可變後的判定另見檔尾「目標語軸」段。

import { test } from "node:test";
import assert from "node:assert/strict";
import { koine } from "./helpers.mjs";

test("lang 屬性分支：zh-Hant/zh-TW/zh-HK/zh-MO/裸 zh → true", () => {
	assert.equal(koine.detectPageLangIsZh("zh-Hant"), true);
	assert.equal(koine.detectPageLangIsZh("zh-TW"), true);
	assert.equal(koine.detectPageLangIsZh("zh-HK"), true);
	// zh-MO（澳門）慣用繁體，與 isTraditionalChineseTarget 用同一組繁中變體集。
	// 這不是純粹的內部同步：它讓 <html lang="zh-MO"> 頁面上的純漢字段由 pending 轉為
	// skipped(already-target)，是可觀察的行為改變，故明寫成斷言。
	assert.equal(koine.detectPageLangIsZh("zh-MO"), true);
	assert.equal(koine.detectPageLangIsZh("zh"), true);
	assert.equal(koine.detectPageLangIsZh("ZH-HANT-TW"), true, "大小寫不敏感");
});

test("lang 屬性分支：zh-CN/zh-Hans → false（簡中頁仍需譯成目標 zh-Hant）", () => {
	assert.equal(koine.detectPageLangIsZh("zh-CN"), false);
	assert.equal(koine.detectPageLangIsZh("zh-Hans"), false);
	assert.equal(koine.detectPageLangIsZh("zh-Hans-CN"), false);
	assert.equal(koine.detectPageLangIsZh("zh-Hans-MO"), false, "script 子標籤優先於地區：簡體澳門仍需譯");
});

test("lang 屬性分支：明確非 zh 語碼 → false，不落到取樣 heuristic", () => {
	assert.equal(koine.detectPageLangIsZh("en", "中文取樣文字"), false, "有明確 lang 時不採樣");
	assert.equal(koine.detectPageLangIsZh("ja"), false);
});

test("取樣 heuristic：缺 lang 屬性、樣本純漢字無假名/諺文 → true", () => {
	assert.equal(koine.detectPageLangIsZh(null, "這是一段中文內容"), true);
	assert.equal(koine.detectPageLangIsZh(undefined, "這是一段中文內容"), true);
	assert.equal(koine.detectPageLangIsZh("", "這是一段中文內容"), true, "空字串視同缺屬性");
});

test("取樣 heuristic：樣本含假名或諺文 → false（日/韓漢字混排不誤判中文）", () => {
	assert.equal(koine.detectPageLangIsZh(null, "これは日本語のテキストです"), false);
	assert.equal(koine.detectPageLangIsZh(null, "한국어 텍스트입니다"), false);
});

test("取樣 heuristic：無漢字樣本 → false", () => {
	assert.equal(koine.detectPageLangIsZh(null, "This is English text"), false);
	assert.equal(koine.detectPageLangIsZh(null, ""), false);
});

test("消費端：makeContext 收到 pageLangIsZh:true 後，R9 already-target gate 真的擋下純漢字段（P2 修前恆 false 永不觸發）", () => {
	const ctx = koine.makeContext({ pageLangIsZh: true });
	assert.equal(ctx.pageLangIsZh, true);
	const result = koine.worthTranslating("已經是繁體中文的段落", { pageLangIsZh: ctx.pageLangIsZh });
	assert.equal(result.worth, false);
	assert.equal(result.reason, "already-target");
});

test("消費端：makeContext 缺省 pageLangIsZh 仍為 false（未偵測時行為不變）", () => {
	const ctx = koine.makeContext();
	assert.equal(ctx.pageLangIsZh, false);
});

// ── 目標語軸：整頁級 gate 必須看目標語，否則等同寫死「目標語是繁中」──────────────

test("目標語預設值＝DEFAULT_TARGET_LANG，且與 makeContext 同源", () => {
	assert.equal(koine.DEFAULT_TARGET_LANG, "zh-Hant");
	assert.equal(koine.makeContext().targetLang, koine.DEFAULT_TARGET_LANG);
	// 顯式傳預設值與省略參數必須等價——同源常數只在兩者不漂開時才有意義。
	for (const tag of ["zh-TW", "zh-CN", "zh", "zh-CHS", "ja", null]) {
		assert.equal(
			koine.detectPageLangIsZh(tag, "這是一段中文內容", koine.DEFAULT_TARGET_LANG),
			koine.detectPageLangIsZh(tag, "這是一段中文內容"),
			`顯式預設 vs 省略：${tag}`,
		);
	}
});

test("簡中目標：繁中頁不算已達標（修前恆判已達標而整頁一段都不翻）", () => {
	assert.equal(koine.detectPageLangIsZh("zh-TW", "", "zh-Hans"), false);
	assert.equal(koine.detectPageLangIsZh("zh-Hant", "", "zh-Hans"), false);
	assert.equal(koine.detectPageLangIsZh("zh-HK", "", "zh-CN"), false);
	// 裸 zh 頁對簡中目標同樣不豁免：未指明書寫系統不足以斷定已是簡體。
	assert.equal(koine.detectPageLangIsZh("zh", "", "zh-Hans"), false);
});

test("簡中目標：簡中頁才算已達標", () => {
	assert.equal(koine.detectPageLangIsZh("zh-CN", "", "zh-Hans"), true);
	assert.equal(koine.detectPageLangIsZh("zh-Hans", "", "zh-CN"), true);
	assert.equal(koine.detectPageLangIsZh("zh-SG", "", "zh-Hans"), true);
});

test("非中文目標：任何中文頁都不算已達標（R9 gate 只認漢字、表達不了非中文目標）", () => {
	for (const tag of ["zh-TW", "zh-Hant", "zh-CN", "zh"]) {
		assert.equal(koine.detectPageLangIsZh(tag, "", "ja"), false, `ja 目標：${tag}`);
		assert.equal(koine.detectPageLangIsZh(tag, "", "en"), false, `en 目標：${tag}`);
	}
	// 缺 lang 走取樣分支時同樣關閉，別讓 heuristic 繞過目標語判定。
	assert.equal(koine.detectPageLangIsZh(null, "這是一段中文內容", "ja"), false);
});

test("認不出書寫系統的目標語 → 一律不算已達標（不把豁免放大成萬用桶）", () => {
	assert.equal(koine.detectPageLangIsZh("zh-TW", "", "zh-CHS"), false);
	assert.equal(koine.detectPageLangIsZh("zh-CN", "", "zh-Latn"), false);
	assert.equal(koine.detectPageLangIsZh(null, "這是一段中文內容", "zh-XX"), false);
});

test("取樣 heuristic 也吃目標語：內容偵測只到「未指明書寫系統」的強度", () => {
	// 漢字樣本分不出簡繁，故等同裸 zh：繁中目標沿用既有放行、簡中目標不豁免。
	assert.equal(koine.detectPageLangIsZh(null, "這是一段中文內容", "zh-Hant"), true);
	assert.equal(koine.detectPageLangIsZh(null, "這是一段中文內容", "zh"), true);
	assert.equal(koine.detectPageLangIsZh(null, "这是一段中文内容", "zh-Hans"), false);
});

test("取樣 heuristic 的已知上界：繁中目標下，無 lang 的簡體頁仍整頁豁免（既有行為、明示釘住）", () => {
	// 兩側代價不對稱：簡中目標多送一次翻譯（安全），繁中目標則整頁不譯。這是釘住現況、
	// 不是疏漏——要收掉它得引入簡繁字形偵測，屬另一條軸。
	assert.equal(koine.detectPageLangIsZh(null, "这是一段简体中文内容", "zh-Hant"), true);
});

test("裸 zh 當目標語：走 hant∪zh 那條分支（與 isAlreadyTargetLang 的目標語清單對稱）", () => {
	assert.equal(koine.detectPageLangIsZh("zh-Hant", "", "zh"), true);
	assert.equal(koine.detectPageLangIsZh("zh-TW", "", "zh"), true);
	assert.equal(koine.detectPageLangIsZh("zh", "", "zh"), true);
	assert.equal(koine.detectPageLangIsZh("zh-CN", "", "zh"), false);
	assert.equal(koine.detectPageLangIsZh("zh-CHS", "", "zh"), false);
});

test("falsy targetLang 回退預設值：與 makeContext 的 `||` 回退對齊、不各自漂開", () => {
	for (const falsy of ["", null, undefined]) {
		assert.equal(
			koine.detectPageLangIsZh("zh-TW", "", falsy),
			koine.detectPageLangIsZh("zh-TW", "", koine.DEFAULT_TARGET_LANG),
			`falsy targetLang: ${JSON.stringify(falsy)}`,
		);
		assert.equal(koine.makeContext({ targetLang: falsy }).targetLang, koine.DEFAULT_TARGET_LANG);
	}
});

test("消費端：繁中頁配簡中目標時 R9 gate 不再擋下純漢字段", () => {
	const pageLangIsZh = koine.detectPageLangIsZh("zh-TW", "", "zh-Hans");
	const ctx = koine.makeContext({ targetLang: "zh-Hans", pageLangIsZh });
	assert.equal(ctx.pageLangIsZh, false);
	const result = koine.worthTranslating("這一段要譯成簡體", { pageLangIsZh: ctx.pageLangIsZh });
	assert.equal(result.worth, true, "整頁級豁免關閉後，段落回到正常送譯路徑");
});
