// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：bridge 串接 translateSegment 測試。
// native messaging 進不了 linkedom，故注入 fake send（回 {id,text} / {id,error} / throw），
// 驗狀態機 pending→drafting→drafted/failed、送出 payload 形狀、成功即插回。

import { test } from "node:test";
import assert from "node:assert/strict";
import { koine, loadFixture, collect } from "./helpers.mjs";

test("成功：pending→drafting→drafted、塞 draft、送 payload 形狀、成功即插回", async () => {
	const doc = loadFixture("01-basic-paragraphs");
	const seg = collect(doc)[0];
	const sent = [];
	const send = (req) => { sent.push(req); return Promise.resolve({ id: req.id, text: `譯:${req.source}` }); };
	await koine.translateSegment(seg, send, { from: "en", to: "zh-Hant" });
	assert.equal(seg.state, koine.SegmentState.DRAFTED);
	assert.equal(seg.draft, `譯:${seg.source}`);
	assert.deepEqual(sent, [{ id: seg.id, source: seg.source, from: "en", to: "zh-Hant" }]);
	const wrapper = doc.querySelector(`[data-koine-id="${seg.id}"]`);
	assert.ok(wrapper, "成功應插回 wrapper");
	assert.equal(wrapper.textContent, `譯:${seg.source}`, "wrapper 帶譯文");
});

test("drafting 中間態：送出後 / 回覆前 = drafting", async () => {
	const doc = loadFixture("01-basic-paragraphs");
	const seg = collect(doc)[0];
	let resolve;
	const send = () => new Promise((r) => { resolve = r; });
	const p = koine.translateSegment(seg, send);
	assert.equal(seg.state, koine.SegmentState.DRAFTING, "送出後、回覆前應為 drafting");
	resolve({ id: seg.id, text: "x" });
	await p;
	assert.equal(seg.state, koine.SegmentState.DRAFTED);
});

test("失敗（回 error）：→failed、記 failReason、不插回", async () => {
	const doc = loadFixture("01-basic-paragraphs");
	const seg = collect(doc)[0];
	const send = () => Promise.resolve({ id: seg.id, error: "unable" });
	await koine.translateSegment(seg, send);
	assert.equal(seg.state, koine.SegmentState.FAILED);
	assert.equal(seg.meta.failReason, "unable");
	assert.equal(doc.querySelector(`[data-koine-id="${seg.id}"]`), null, "失敗不得插回");
});

test("失敗（send throw / reject）：→failed、reason 帶錯誤", async () => {
	const doc = loadFixture("01-basic-paragraphs");
	const seg = collect(doc)[0];
	const send = () => Promise.reject(new Error("boom"));
	await koine.translateSegment(seg, send);
	assert.equal(seg.state, koine.SegmentState.FAILED);
	assert.match(seg.meta.failReason, /boom/);
});

test("失敗（回覆無 text）：→failed no-text", async () => {
	const doc = loadFixture("01-basic-paragraphs");
	const seg = collect(doc)[0];
	const send = () => Promise.resolve({ id: seg.id });
	await koine.translateSegment(seg, send);
	assert.equal(seg.state, koine.SegmentState.FAILED);
	assert.equal(seg.meta.failReason, "no-text");
});

test("只譯 pending：非 pending 段不送 bridge、狀態不變 — 07-worth-numeric-skip", async () => {
	const doc = loadFixture("07-worth-numeric-skip");
	const skipped = collect(doc).find((s) => s.state === koine.SegmentState.SKIPPED);
	assert.ok(skipped, "fixture 應含 skipped 段");
	let called = false;
	const send = () => { called = true; return Promise.resolve({ text: "x" }); };
	await koine.translateSegment(skipped, send);
	assert.equal(called, false, "skipped 段不得送 bridge");
	assert.equal(skipped.state, koine.SegmentState.SKIPPED, "狀態不變");
});

test("§9.1 空譯文（res.text=\"\"）：DRAFTED 但不插回（譯文=原文不顯示、非失敗）", async () => {
	const doc = loadFixture("01-basic-paragraphs");
	const seg = collect(doc)[0];
	const send = () => Promise.resolve({ id: seg.id, text: "" });
	await koine.translateSegment(seg, send);
	assert.equal(seg.state, koine.SegmentState.DRAFTED, "空譯文仍 drafted（非 failed）");
	assert.equal(seg.draft, "");
	assert.equal(doc.querySelector(`[data-koine-id="${seg.id}"]`), null, "空譯文不插 wrapper（§9.1）");
});

test("buildBridgeMessage：組出 native 訊息形狀 { type:'translate', id, source, from, to }", () => {
	const msg = koine.buildBridgeMessage({ id: "k1-0", source: "Hi", from: "en", to: "zh-Hant" });
	assert.deepEqual(msg, { type: "translate", id: "k1-0", source: "Hi", from: "en", to: "zh-Hant" });
});
