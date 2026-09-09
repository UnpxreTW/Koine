// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A：makeId 的 id 格式直接斷言。
// 段落 id 是 DOM 與橋接兩側對帳的鍵，格式（前綴 k、兩段 36 進位、連字號分隔）與
// 無號 32 位元轉型都沒有斷言：改成 10 進位整套測試照樣全綠。期望值取自現行實作實跑。

import { test } from "node:test";
import assert from "node:assert/strict";
import { koine } from "./helpers.mjs";

test("格式為 k + 36 進位的 walkId + 連字號 + 36 進位的 order", () => {
	assert.equal(koine.makeId(0, 0), "k0-0");
	assert.equal(koine.makeId(1, 0), "k1-0");
	assert.equal(koine.makeId(9, 9), "k9-9");
	// 10 進位與 36 進位分家的第一個位置：10 寫成 a、35 寫成 z、36 進位到 10。
	assert.equal(koine.makeId(10, 35), "ka-z");
	assert.equal(koine.makeId(36, 1295), "k10-zz");
	assert.equal(koine.makeId(12, 345), "kc-9l");
});

test("兩個引數各自先轉成無號 32 位元整數", () => {
	// 小數截去、負數與滿 32 位元的值繞回。
	assert.equal(koine.makeId(1.9, 2.5), "k1-2");
	assert.equal(koine.makeId(-1, 0), "k1z141z3-0");
	assert.equal(koine.makeId(2 ** 32, 0), "k0-0");
	assert.equal(koine.makeId(0, 2 ** 32 + 7), "k0-7");
});

test("id 可切回原本的兩個數字", () => {
	const id = koine.makeId(7, 41);
	assert.equal(id, "k7-15");
	const [walk, order] = id.slice(1).split("-");
	assert.equal(parseInt(walk, 36), 7);
	assert.equal(parseInt(order, 36), 41);
});
