// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A：§10.2 priorityGate 排序鍵的直接斷言。
// 不建 DOM——段以假物件給、距離由注入的 measure 回，dequeue 序即排序鍵的可觀測投影。

import { test } from "node:test";
import assert from "node:assert/strict";
import { koine } from "./helpers.mjs";

/** 沖掉 microtask（onEnter 走 Promise 鏈，需跨一個 macrotask 讓其結算）。 */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** stub IntersectionObserver：分層記錄、可一次觸發全部進場。 */
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
	const enter = (els) => {
		for (const rec of records) {
			const hit = els.filter((el) => rec.observed.has(el));
			if (hit.length) rec.cb(hit.map((el) => ({ isIntersecting: true, target: el })), rec.obs);
		}
	};
	return { factory, enter };
}

/** 造一個 pending 假段；block 用唯一空物件當 key。 */
function seg(id, region, order) {
	return {
		id, order, region, source: id,
		state: koine.SegmentState.PENDING, anchor: { block: {}, insertMode: "after-segment", refNode: null },
	};
}

/**
 * 以 maxInFlight=1 逐段放行，取得完整 dequeue 序。
 * segs[0] 必須是距離 0 的定樁段：它在第一層 observer 的 callback 內就佔住唯一的 in-flight 名額，
 * 其餘各段因此全數入列後才比較。含 chrome 段的案例另依賴 main 層 observer 先建立，
 * 定樁段要先佔住名額，這個前提才成立。
 */
async function dispatchOrder(segs, dist) {
	const entered = [];
	const releases = [];
	const onEnter = (s) => { entered.push(s.id); return new Promise((res) => releases.push(res)); };
	const stub = makeStubObserver();
	koine.observeSegments(segs, {
		onEnter, maxInFlight: 1, makeObserver: stub.factory, eagerBudget: 0,
		measure: (block) => dist.get(block) ?? 0,
	});
	stub.enter(segs.map((s) => s.anchor.block));
	await tick();
	for (let i = 0; i < segs.length + 2; i++) {
		if (releases.length) releases.shift()();
		await tick();
	}
	return entered;
}

test("regionRank：同 band 同桶時 MAIN 先於 CHROME，order 較小的 chrome 也搶不到前面", async () => {
	const pin = seg("pin", "main", 0);
	const main = seg("main-1000", "main", 9);
	const chrome = seg("chrome-1000", "chrome", 1);
	const dist = new Map([
		[pin.anchor.block, 0], [main.anchor.block, 1000], [chrome.anchor.block, 1000],
	]);
	const entered = await dispatchOrder([pin, main, chrome], dist);
	assert.deepEqual(entered, ["pin", "main-1000", "chrome-1000"],
		"offscreen 段先比 region：MAIN 排在 CHROME 之前，order 不參與這一段比較");
});

test("distanceBucket：桶寬 300px，同桶內距離不分先後（由 order 決定）、跨桶才由距離決定", async () => {
	const pin = seg("pin", "main", 0);
	const near = seg("d300-order5", "main", 5);   // 桶 1
	const far = seg("d599-order2", "main", 2);    // 同為桶 1、order 較小
	const next = seg("d600-order0", "main", 0);   // 桶 2、order 最小
	const dist = new Map([
		[pin.anchor.block, 0], [near.anchor.block, 300],
		[far.anchor.block, 599], [next.anchor.block, 600],
	]);
	const entered = await dispatchOrder([pin, near, far, next], dist);
	assert.deepEqual(entered, ["pin", "d599-order2", "d300-order5", "d600-order0"],
		"300→599 同落桶 1、桶內看 order；600 跨進桶 2，order 最小也排在桶 1 之後");
});

test("order tie-break：排序鍵其餘三段相同時由 order 決定，與入列順序相反也照 order", async () => {
	const pin = seg("pin", "main", 0);
	const first = seg("order9", "main", 9);
	const second = seg("order3", "main", 3);
	const dist = new Map([
		[pin.anchor.block, 0], [first.anchor.block, 500], [second.anchor.block, 500],
	]);
	const entered = await dispatchOrder([pin, first, second], dist);
	assert.deepEqual(entered, ["pin", "order3", "order9"],
		"order 是最後一段鍵、蓋過入列先後（此處 order9 先入列）");
});
