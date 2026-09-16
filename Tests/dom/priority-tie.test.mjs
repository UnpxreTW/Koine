// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A：§10.2 priorityGate 排序鍵四段全等時的落底行為。
// compareSegs 逐段比完四段鍵都相等就回 0，交給 Array.prototype.sort 的穩定性收場——
// 派送序因此等於入列序。既有測試（observe.test.mjs）的段 order 一律互異、走不到這條落底。
// 不建 DOM：段以假物件給、距離由注入的 measure 回，dequeue 序即排序鍵的可觀測投影。

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

/** 造一個 pending 假段；block 預設用唯一空物件當 key，傳 block 則與他段共用同一顆。 */
function seg(id, region, order, block) {
	return {
		id, order, region, source: id,
		state: koine.SegmentState.PENDING,
		anchor: { block: block || {}, insertMode: "after-segment", refNode: null },
	};
}

/**
 * 以 maxInFlight=1 逐段放行，取得完整 dequeue 序。
 * segs[0] 必須是距離 0 的定樁段：它在 observer callback 內就佔住唯一的 in-flight 名額，
 * 其餘各段因此全數入列後才比較——沒有這顆樁，先進場的段會邊入列邊被派掉，量不到排序。
 * beforeRelease 在全部入列、尚未放行任何一段時呼叫，供案例插入手動 re-bucket。
 */
async function dispatchOrder(segs, dist, beforeRelease) {
	const entered = [];
	const releases = [];
	const onEnter = (s) => { entered.push(s.id); return new Promise((res) => releases.push(res)); };
	const stub = makeStubObserver();
	const handle = koine.observeSegments(segs, {
		onEnter, maxInFlight: 1, makeObserver: stub.factory, eagerBudget: 0,
		measure: (block) => dist.get(block) ?? 0,
	});
	stub.enter(segs.map((s) => s.anchor.block));
	await tick();
	if (beforeRelease) beforeRelease(handle);
	for (let i = 0; i < segs.length + 2; i++) {
		if (releases.length) releases.shift()();
		await tick();
	}
	return entered;
}

test("四段鍵全等：派送序＝入列序（穩定排序落底）", async () => {
	const pin = seg("pin", "main", 0);
	// 三段同 region、同距離、同 order ⇒ (band, rank, bucket, order) 四段全等。
	const a = seg("a", "main", 7);
	const b = seg("b", "main", 7);
	const c = seg("c", "main", 7);
	const dist = new Map([
		[pin.anchor.block, 0], [a.anchor.block, 500], [b.anchor.block, 500], [c.anchor.block, 500],
	]);
	const entered = await dispatchOrder([pin, a, b, c], dist);
	assert.deepEqual(entered, ["pin", "a", "b", "c"],
		"鍵分不出高下時不重排，先入列者先派送");
});

test("同 order 的真實產生源：兩次採集各自從 0 起編，混在一起觀察", async () => {
	const pin = seg("pin", "main", 0);
	// order 只在單次 collectSegments 內遞增，跨 walk 會重號（id 由 walkId 區分、order 不會）。
	const walk2 = seg("w2-3", "main", 3);
	const walk1 = seg("w1-3", "main", 3);
	const dist = new Map([
		[pin.anchor.block, 0], [walk2.anchor.block, 900], [walk1.anchor.block, 900],
	]);
	const entered = await dispatchOrder([pin, walk2, walk1], dist);
	assert.deepEqual(entered, ["pin", "w2-3", "w1-3"],
		"跨 walk 的同號段不比 id、不比 walkId，照入列序");
});

test("re-bucket 把距離拉平後鍵才全等：重排不打亂既有次序", async () => {
	const pin = seg("pin", "main", 0);
	const a = seg("a", "main", 2);
	const b = seg("b", "main", 2);
	// 入列時 b 較近、桶較小 ⇒ 鍵分得出高下，b 排在 a 前。
	const dist = new Map([
		[pin.anchor.block, 0], [a.anchor.block, 700], [b.anchor.block, 500],
	]);
	// 捲動後重新量測把兩段拉進同一桶，resort 全量 re-key 並標髒 ⇒ 下次 dequeue 重排一次、此時鍵才全等。
	const entered = await dispatchOrder([pin, a, b], dist, (handle) => {
		dist.set(b.anchor.block, 700);
		handle.resort();
	});
	assert.deepEqual(entered, ["pin", "b", "a"], "鍵變全等後，re-bucket 前的次序被穩定排序保住");
});

test("混列：鍵分得出的先照鍵排，分不出的那一組內維持入列序", async () => {
	const pin = seg("pin", "main", 0);
	const tieA = seg("tie-a", "main", 5);
	const tieB = seg("tie-b", "main", 5);
	const nearer = seg("nearer", "main", 8); // 距離較近 ⇒ 桶較小，鍵勝過 order
	const far = seg("far", "main", 1);       // 距離較遠 ⇒ 桶較大，鍵劣過 order
	const dist = new Map([
		[pin.anchor.block, 0],
		[tieA.anchor.block, 700], [tieB.anchor.block, 700],
		[nearer.anchor.block, 100], [far.anchor.block, 2000],
	]);
	const entered = await dispatchOrder([pin, tieA, tieB, nearer, far], dist);
	assert.deepEqual(entered, ["pin", "nearer", "tie-a", "tie-b", "far"],
		"全等那一組整段留在原位，只有它們之間靠入列序決勝");
});
