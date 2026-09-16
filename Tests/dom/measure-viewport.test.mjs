// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：預設段距量測（不注入 opts.measure 時走的那一條）。讀 block 的
// getBoundingClientRect 與 innerHeight，換算成排程排序鍵裡的距離。
// 既有 observe.test.mjs 只有兩條注入 measure；其餘走預設量測，但裸物件無該方法走守衛
// 回 0、linkedom 元素的 rect 全零走相交分支回 0——兩條都不進視窗上方／下方分支，那
// 兩支距離分支從未執行、零斷言。距離不外露，只能由派發順序反推，本檔全部經
// observeSegments 的派發序斷言。

import { test } from "node:test";
import assert from "node:assert/strict";
import { koine } from "./helpers.mjs";

/** 沖掉 microtask（onEnter 走 Promise 鏈，需跨一個 macrotask 讓其結算）。 */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** stub IntersectionObserver：記住被觀察的元素，可手動觸發進場。 */
function makeStubObserver() {
	const records = [];
	const factory = (cb, options) => {
		const rec = { cb, options, observed: new Set(), obs: null };
		rec.obs = {
			observe: (el) => rec.observed.add(el),
			unobserve: (el) => rec.observed.delete(el),
			disconnect: () => rec.observed.clear(),
		};
		records.push(rec);
		return rec.obs;
	};
	const enter = (...els) => {
		for (const rec of records) {
			const hit = els.filter((el) => rec.observed.has(el));
			if (hit.length) rec.cb(hit.map((el) => ({ isIntersecting: true, target: el })), rec.obs);
		}
	};
	return { factory, enter };
}

/**
 * 造一個 pending 假段。block 是帶 getBoundingClientRect 的裸物件——預設量測只讀這顆方法，
 * 不需要真 DOM。`rect` 為 null ＝ 這顆 block 沒有該方法（守衛路徑）。
 */
function segAt(order, rect) {
	const block = rect === null ? {} : { getBoundingClientRect: () => rect };
	return {
		id: `m-${order}`, order, region: "main", source: `s${order}`,
		state: koine.SegmentState.PENDING,
		anchor: { block, insertMode: "after-segment", refNode: null },
	};
}

/** 視窗高度換成 `value` 跑一次；`value` 為 undefined ＝ 讓 innerHeight 不是數字。 */
async function dispatchOrder(segs, value) {
	const had = Object.prototype.hasOwnProperty.call(globalThis, "innerHeight");
	const before = globalThis.innerHeight;
	if (value === undefined) delete globalThis.innerHeight;
	else globalThis.innerHeight = value;
	try {
		const stub = makeStubObserver();
		const entered = [];
		koine.observeSegments(segs, {
			onEnter: (s) => { entered.push(s.id); },
			makeObserver: stub.factory,
			eagerBudget: 0,   // 關掉載入即發，全部走 IO → 同一批入列 → 派發序＝排序鍵序
			maxInFlight: 1,   // 併發 1：派發序看得出來
		});
		stub.enter(...segs.map((s) => s.anchor.block));
		await tick();
		return entered;
	} finally {
		if (had) globalThis.innerHeight = before;
		else delete globalThis.innerHeight;
	}
}

test("與視窗相交的段壓過所有不相交的段（文件序讓位）", async () => {
	// 段 0 在視窗上方 600px 外、段 1 與視窗相交：文件序在前的段 0 仍應後派。
	const segs = [
		segAt(0, { top: -1000, bottom: -600 }),
		segAt(1, { top: 100, bottom: 200 }),
	];
	assert.deepEqual(await dispatchOrder(segs, 800), ["m-1", "m-0"]);
});

test("視窗上方的距離以 rect.bottom 計：離得越遠越後派", async () => {
	const near = { top: -300, bottom: -100 };   // 距離 100
	const far = { top: -900, bottom: -700 };    // 距離 700
	assert.deepEqual(
		await dispatchOrder([segAt(0, near), segAt(1, far)], 800), ["m-0", "m-1"],
	);
	// 對調兩顆的 rect，派發序跟著對調——順序來自距離、不是文件序。
	assert.deepEqual(
		await dispatchOrder([segAt(0, far), segAt(1, near)], 800), ["m-1", "m-0"],
	);
});

test("視窗下方的距離扣掉視窗高度：不扣就會排到上方那顆的後面", async () => {
	// 視窗高 800。段 0 在下方 100px 外（900 − 800），段 1 在上方 400px 外。
	const segs = [
		segAt(0, { top: 900, bottom: 1000 }),
		segAt(1, { top: -600, bottom: -400 }),
	];
	assert.deepEqual(await dispatchOrder(segs, 800), ["m-0", "m-1"]);
});

test("block 沒有 getBoundingClientRect：距離當 0，與相交段同級", async () => {
	// 距離 0 ⇒ 落在「與視窗相交」那一級，壓過視窗外的段。
	const segs = [
		segAt(0, { top: 2000, bottom: 2100 }),
		segAt(1, null),
	];
	assert.deepEqual(await dispatchOrder(segs, 800), ["m-1", "m-0"]);
});

test("innerHeight 不是數字時視窗高度當 0：視窗下緣退到頁面頂端", async () => {
	// 視窗高 0 之下，只有橫跨頁面頂端的段 1 算相交；段 0 落在「下方 100px 外」。
	const segs = [
		segAt(0, { top: 100, bottom: 200 }),
		segAt(1, { top: -50, bottom: 50 }),
	];
	assert.deepEqual(await dispatchOrder(segs, undefined), ["m-1", "m-0"]);
});
