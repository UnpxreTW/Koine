// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（純函式、不建 DOM）：§4.8 worthTranslating 的跳過理由表與 isFilenameOnly。
// 共十種 reason，既有覆蓋只到 numeric（golden 07-worth-numeric-skip）與 already-target
// （lang-detect.test.mjs），其餘八種與規則先後順序無人看守——任何一條退化只會讓段落多送
// 或少送翻譯，現有測試照樣全綠。
// already-target 沿用 lang-detect 既有斷言、本檔不重複，故此處釘的是另外九種。
// 期望值一律取自現行實作的實測輸出（characterization），含「url 規則遮蔽多數 filename」
// 這種非直覺的現況；本檔只記錄行為，不主張它應該如此。

import { test } from "node:test";
import assert from "node:assert/strict";
import { koine } from "./helpers.mjs";

const ZWSP = "\u200b";
const SOFT_HYPHEN = "\u00ad";

/** 每列＝[輸入, 期望 reason]。 */
const SKIP_CASES = [
	["", "whitespace"],
	["   ", "whitespace"],
	["\u00a0\u2003", "whitespace"],
	["🎉", "emoji"],
	["🇹🇼", "emoji"],
	["🎉 🎊", "emoji"],
	["—", "punct"],
	["…?!", "punct"],
	["(—)", "punct"],
	["404", "numeric"],
	["1,234.56", "numeric"],
	["+1-800", "numeric"],
	["2026/09/08", "numeric"],
	["user@example.com", "email"],
	["MAIL@Example.CO.UK", "email"],
	["https://example.com/a", "url"],
	["ftp://a.b/c", "url"],
	["www.example.com", "url"],
	["example.com", "url"],
	["/usr/local/bin", "path"],
	["./a/b", "path"],
	["~/notes", "path"],
	["C:\\Temp\\a", "path"],
	["my_notes.txt", "filename"],
	["報告.pdf", "filename"],
	["a", "min-length"],
	["I", "min-length"],
	["1 a", "min-length"],
	["の", "min-length"],
	["한", "min-length"],
];

test("§4.8 worthTranslating：每條跳過規則各自的 reason（絕對期望值）", () => {
	for (const [input, reason] of SKIP_CASES) {
		assert.deepEqual(
			koine.worthTranslating(input),
			{ worth: false, reason },
			`輸入 ${JSON.stringify(input)} 應以 ${reason} 跳過`
		);
	}
});

test("§4.8 worthTranslating：仍要送翻的正向樣本（規則不得誤傷）", () => {
	const worthCases = [
		"Hi",
		"A B",
		"OK 🎉", // 有字母就不算純表情
		"字", // 含漢字就不套 min-length（單字仍要譯）
		"3 files",
		"a.b", // 副檔名不在白名單、也不成 URL
		`He${ZWSP}l${SOFT_HYPHEN}lo`,
	];
	for (const input of worthCases) {
		assert.deepEqual(koine.worthTranslating(input), { worth: true }, `輸入 ${JSON.stringify(input)} 應送翻`);
	}
});

test("§4.8 規則先後：先命中的那條決定 reason（實測現況、非應然）", () => {
	// url 在 filename 之前，且 url 規則認得「裸字 + 點 + 兩個以上字母」——
	// 於是多數檔名記成 url，filename 只在 url 規則拒收的 token（底線、漢字）上看得到。
	assert.equal(koine.worthTranslating("README.md").reason, "url");
	assert.equal(koine.worthTranslating("notes.unknownext").reason, "url", "白名單外的副檔名照樣被 url 規則吃下");
	assert.equal(koine.worthTranslating("報告.txt").reason, "filename");
	// punct 要求整串無英數，帶數字的符號串因此落到 numeric。
	assert.equal(koine.worthTranslating("12%").reason, "numeric");
});

test("§4.8 R0：判斷前先 trim 並去掉零寬空白與 soft-hyphen", () => {
	assert.deepEqual(koine.worthTranslating("  Hi  "), { worth: true }, "前後空白不影響判定");
	assert.deepEqual(
		koine.worthTranslating(ZWSP),
		{ worth: false, reason: "whitespace" },
		"只剩零寬空白＝視同空白（零寬空白本身不屬 White_Space）"
	);
	assert.deepEqual(
		koine.worthTranslating(`e${SOFT_HYPHEN}`),
		{ worth: false, reason: "min-length" },
		"soft-hyphen 不算字母、去掉後只剩一個字母"
	);
});

test("§4.8 isFilenameOnly：單 token + 白名單副檔名", () => {
	assert.equal(koine.isFilenameOnly("報告.pdf"), true);
	assert.equal(koine.isFilenameOnly("README.md"), true, "本函式認得它；只是 url 規則先命中，見上一條");
	assert.equal(koine.isFilenameOnly("notes.unknownext"), false, "白名單外的副檔名不算檔名");
	assert.equal(koine.isFilenameOnly("a.b"), false);
	assert.equal(koine.isFilenameOnly("報告 .pdf"), false, "帶空白＝不只一個 token");
	assert.equal(koine.isFilenameOnly(".gitignore"), false, "點在開頭不算副檔名");
	assert.equal(koine.isFilenameOnly("notes."), false, "點在結尾不算副檔名");
});

test("§4.8 isFilenameOnly：開頭點與副檔名大小寫兩支邊界", () => {
	// 上一個 test 的 ".gitignore" 與 "notes." 兩條屬等價變異——前者的 "gitignore" 不在白名單、
	// 後者截出空字串，兩條路徑都落回 KNOWN_EXT.has(...)=false，無法區分守門分支是否存在。
	// 本 test 補兩個會區分的輸入：
	// ① 開頭點＋白名單副檔名（dot===0）：守門式為 `dot <= 0`，改成 `dot < 0` 時 ".md" 會被
	//    當成副檔名 md 而回 true，故此條釘住 dot===0 這一支。
	assert.equal(koine.isFilenameOnly(".md"), false, "開頭點即使後綴是白名單副檔名也不算檔名");
	assert.equal(koine.isFilenameOnly(".js"), false);
	// ② 副檔名大小寫折疊：白名單只存小寫，實作先 toLowerCase 再查；去掉折疊時大寫副檔名會落空。
	assert.equal(koine.isFilenameOnly("IMG.PNG"), true, "副檔名比對前折成小寫");
	assert.equal(koine.isFilenameOnly("report.PDF"), true);
});
