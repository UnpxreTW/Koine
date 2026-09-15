// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：observeSegments 的選項覆寫層直接斷言。
// 進場觀察分 main / chrome 兩層 observer，各自帶不同的 rootMargin；呼叫端可用單層的
// rootMargin 一次覆寫兩層（相容舊的單層呼叫），也可用 mainRootMargin / chromeRootMargin
// 分層覆寫。既有 observe.test.mjs 只驗兩層的預設值（1200px / 400px），三個覆寫參數與
// 併發閘門的零值語義皆無斷言。本檔以 stub observer 觀察建構參數、以假 onEnter 觀察派發，
// 期望值取自現行實作實跑。

import { test } from "node:test";
import assert from "node:assert/strict";
import { koine } from "./helpers.mjs";

/** 沖掉 microtask（onEnter 走 Promise 鏈，需跨一個 macrotask 讓其結算）。 */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** stub IntersectionObserver：只記每層的建構參數與被觀察的 block。 */
function makeStubObserver() {
	const state = { observers: [] };
	const factory = (cb, options) => {
		const rec = { cb, options, observed: new Set(), obs: null };
		rec.obs = {
			observe: (el) => { rec.observed.add(el); },
			unobserve: (el) => { rec.observed.delete(el); },
			disconnect: () => { rec.observed.clear(); },
		};
		state.observers.push(rec);
		return rec.obs;
	};
	return { factory, state };
}

/** 造 n 個 pending 假段（block 用唯一空物件當 key，不需真 DOM）。 */
function fakeSegs(n, region, startOrder = 0) {
	return Array.from({ length: n }, (_, i) => ({
		id: `${region}-${i.toString(36)}`, order: startOrder + i, region, source: `s${i}`,
		state: koine.SegmentState.PENDING, anchor: { block: {}, insertMode: "after-segment", refNode: null },
	}));
}

/** 建兩層（main + chrome 各兩段）、關掉 eager，回傳兩層的 rootMargin。 */
function marginsFor(extraOpts) {
	const stub = makeStubObserver();
	const segments = [...fakeSegs(2, "main"), ...fakeSegs(2, "chrome", 10)];
	koine.observeSegments(segments, { onEnter: () => {}, makeObserver: stub.factory, eagerBudget: 0, ...extraOpts });
	assert.equal(stub.state.observers.length, 2, "前提：main 與 chrome 各建一層 observer");
	return stub.state.observers.map((rec) => rec.options.rootMargin);
}

test("單層 rootMargin 一次覆寫兩層（相容舊的單層呼叫）", () => {
	// 兩層各自的預設是 1200px / 400px；給了單層值之後兩層同值。
	assert.deepEqual(marginsFor({}), ["1200px", "400px"]);
	assert.deepEqual(marginsFor({ rootMargin: "800px" }), ["800px", "800px"]);
	assert.deepEqual(marginsFor({ rootMargin: "0px" }), ["0px", "0px"]);
});

test("單層 rootMargin 勝過分層的 mainRootMargin 與 chromeRootMargin", () => {
	// 三個都給時，兩層都取單層值——分層值一個都不生效。
	assert.deepEqual(
		marginsFor({ rootMargin: "800px", mainRootMargin: "99px", chromeRootMargin: "77px" }),
		["800px", "800px"],
	);
});

test("分層覆寫各自生效，未給的那層留預設", () => {
	assert.deepEqual(marginsFor({ mainRootMargin: "99px" }), ["99px", "400px"]);
	assert.deepEqual(marginsFor({ chromeRootMargin: "77px" }), ["1200px", "77px"]);
	assert.deepEqual(marginsFor({ mainRootMargin: "99px", chromeRootMargin: "77px" }), ["99px", "77px"]);
});

test("空字串的 rootMargin 不算覆寫，落回分層與預設", () => {
	// 覆寫以 falsy 判定，"" 因此穿透；"0px" 則是有效覆寫（見第一條）。
	assert.deepEqual(marginsFor({ rootMargin: "" }), ["1200px", "400px"]);
	assert.deepEqual(marginsFor({ rootMargin: "", mainRootMargin: "99px" }), ["99px", "400px"]);
});

test("併發閘門明給 0 就閘死，不落回預設 6", async () => {
	// 三段 main 走 eager、載入即發；閘門容量決定派得出去幾段。
	const dispatched = (maxInFlight) => {
		const seen = [];
		const stub = makeStubObserver();
		const opts = { onEnter: (seg) => { seen.push(seg.id); }, makeObserver: stub.factory };
		if (maxInFlight !== undefined) opts.maxInFlight = maxInFlight;
		koine.observeSegments(fakeSegs(3, "main"), opts);
		return seen;
	};
	const closed = dispatched(0);
	const byDefault = dispatched(undefined);
	const one = dispatched(1);
	await tick();
	await tick();
	assert.deepEqual(closed, [], "0 是有效容量、不是未給");
	assert.deepEqual(byDefault, ["main-0", "main-1", "main-2"], "未給走預設 6、三段一次派完");
	assert.deepEqual(one, ["main-0", "main-1", "main-2"], "容量 1 逐段結算後補位、三段仍全派出");
});
