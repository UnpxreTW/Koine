// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：§4.9 detectPageLangIsZh 頁面語言偵測測試（P2）。
// 驗 lang 屬性優先分支（zh-Hant/zh-TW/zh-HK/裸 zh → true；zh-CN/zh-Hans → false；
// 明確非 zh 語碼 → false）與缺 lang 屬性時的取樣文字 heuristic fallback；
// 並驗 main() 的消費端 R9 already-target gate 真的能被 pageLangIsZh 觸發（P2 修的是這條路徑）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { koine } from "./helpers.mjs";

test("lang 屬性分支：zh-Hant/zh-TW/zh-HK/裸 zh → true", () => {
	assert.equal(koine.detectPageLangIsZh("zh-Hant"), true);
	assert.equal(koine.detectPageLangIsZh("zh-TW"), true);
	assert.equal(koine.detectPageLangIsZh("zh-HK"), true);
	assert.equal(koine.detectPageLangIsZh("zh"), true);
	assert.equal(koine.detectPageLangIsZh("ZH-HANT-TW"), true, "大小寫不敏感");
});

test("lang 屬性分支：zh-CN/zh-Hans → false（簡中頁仍需譯成目標 zh-Hant）", () => {
	assert.equal(koine.detectPageLangIsZh("zh-CN"), false);
	assert.equal(koine.detectPageLangIsZh("zh-Hans"), false);
	assert.equal(koine.detectPageLangIsZh("zh-Hans-CN"), false);
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
