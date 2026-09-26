// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：§3.5 / §3.6 頁面根身分豁免。
//
// 頁面根（`<html>` / `<body>`）身上的 `lang` 與 `translate="no"` 是整份文件的宣告，不是
// 「這一塊不採」的剪枝訊號：前者是下行語言種子、後者多半是框架把整站標成不翻。修前這件事只靠「採集根是
// `<body>`、`<html>` 在根之上所以永遠不被分類」這個巧合成立，於是兩個缺口同時存在——
// ① `<body lang="zh-TW">` 的頁面以預設根採集時整頁零段（生產路徑上就看得到）；
// ② 採集根往上移到 `<html>` 時，`<html lang="zh-TW">` 這種主流寫法同樣歸零。
//
// 判準是**身分**不是 tagName：手搭而未掛進文件的 `<body>` 元素不是頁面根，不豁免。
//
// 本檔不碰採集根閘（Document／DocumentFragment 仍一律 0 段，見 insert-mode.test.mjs）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { koine, stubGetStyle, FIXTURES } from "./helpers.mjs";

/** 建一份文件，`<html>` 與 `<body>` 的屬性各自可控（fixture 格式表達不了這兩層的屬性）。 */
function docFrom(bodyHtml, htmlAttrs = "", bodyAttrs = "") {
	const { document } = parseHTML(
		`<!doctype html><html${htmlAttrs}><body${bodyAttrs}>${bodyHtml}</body></html>`,
	);
	return document;
}

function collectFrom(root) {
	const ctx = koine.makeContext({ getStyle: stubGetStyle });
	return koine.collectSegments(root, ctx, { walkId: 1 });
}

/**
 * root 不變式比對用形狀：比 normalize 多帶 `insertMode` 與 `region`，因為豁免改動的是走訪
 * 路徑，而 golden 通道刻意丟掉 anchor——只比 source 會讓「插回模式跟著根變」這種分歧漏網。
 *
 * 排除掛在頁面根上的**屬性段**：`collect` 只採子代的 `title`、從不採根自身的，所以
 * `<body title>` 在 `<html>` 為根時成段（body 是子代）、在 `<body>` 為根時不成段（body 是
 * 根自身）。這是採集根閘的既有性質、與本次豁免無關，比對時排掉它才不會把既有差異記到
 * 豁免頭上。
 */
function shape(segs, doc) {
	return segs
		.filter((s) => !(s.kind === "attribute"
			&& (s.anchor.block === doc.documentElement || s.anchor.block === doc.body)))
		.map((s) => ({
			order: s.order,
			source: s.source,
			state: s.state,
			insertMode: s.anchor.insertMode,
			region: s.region,
		}));
}

const EN = "An English paragraph with enough words here.";
const ZH = "這是一段繁體中文的內容。";

// ---------------------------------------------------------------------------
// A1–A3：頁面根上的 lang／translate 不再剪枝
// ---------------------------------------------------------------------------

test("A1 `<body lang>` 為目標語時照常採集（修前整頁零段）", () => {
	const doc = docFrom(`<p>${EN}</p>`, "", ` lang="zh-TW"`);
	const segs = collectFrom(doc.body);
	assert.equal(segs.length, 1, "body 自身的 lang 宣告不得讓整棵不採");
	assert.equal(segs[0].source, EN);
	assert.equal(segs[0].state, koine.SegmentState.PENDING);
	// 豁免的另一半：頁面根的 lang 不只是「不剪枝」，它要真的成為下行語言種子。本檔其餘斷言
	// 比的都是段的有無與插回模式，不看語言欄——種子壞掉時它們不會有反應。
	assert.equal(segs[0].lang, "zh-tw", "body 的 lang 應下行成為段的有效語言");
});

test("A2 `<html lang>` 為目標語時，documentElement 為根與 body 為根同輸出", () => {
	const doc = docFrom(`<p>${EN}</p><p lang="zh-TW">${ZH}</p>`, ` lang="zh-TW"`);
	const viaBody = shape(collectFrom(doc.body), doc);
	const viaHTML = shape(collectFrom(doc.documentElement), doc);
	assert.deepEqual(viaHTML, viaBody);
	assert.equal(viaBody.length, 1, "英文段照採；標了目標語的 `<p>` 仍由元素級閘跳過");
	assert.equal(viaBody[0].source, EN);
});

test("A3 `<html translate=no>`／`<html class=notranslate>`：documentElement 為根與 body 為根同輸出", () => {
	for (const attrs of [` translate="no"`, ` class="notranslate"`]) {
		const doc = docFrom(`<p>${EN}</p>`, attrs);
		const viaBody = shape(collectFrom(doc.body), doc);
		const viaHTML = shape(collectFrom(doc.documentElement), doc);
		assert.deepEqual(viaHTML, viaBody, `html${attrs} 不得讓整份文件歸零`);
		assert.equal(viaBody.length, 1);
	}
});

// ---------------------------------------------------------------------------
// A4–A5：豁免的邊界
// ---------------------------------------------------------------------------

test("A4 豁免只及頁面根：`<article>` 上的同樣訊號照舊尊重", () => {
	for (const attrs of [` lang="zh-TW"`, ` translate="no"`, ` class="notranslate"`]) {
		const doc = docFrom(`<article id="r"${attrs}><p>${EN}</p></article>`);
		const segs = collectFrom(doc.querySelector("#r"));
		assert.equal(segs.length, 0, `article${attrs} 為根時應整棵不採`);
	}
	// 同樣的訊號在走訪途中（非根）也照舊擋下。
	const doc = docFrom(`<article${` lang="zh-TW"`}><p>${EN}</p></article>`);
	assert.equal(collectFrom(doc.body).length, 0);
});

test("A5 判準是身分不是 tagName：未掛進文件的 `<body lang>` 元素不豁免", () => {
	const doc = docFrom(`<p>${EN}</p>`);
	const orphan = doc.createElement("body");
	orphan.setAttribute("lang", "zh-TW");
	const p = doc.createElement("p");
	p.textContent = EN;
	orphan.appendChild(p);
	assert.ok(orphan !== doc.body, "前提：手搭的 body 不是這份文件的 body");
	// live DOM 節點的身分比對一律 assert.ok：assert.equal 在 strict 模式下會對兩個節點算結構
	// diff，linkedom 的節點互相指涉、紅燈會表現成整檔卡住（見 helpers.mjs 的 assertSame）。
	assert.ok(orphan.ownerDocument === doc, "前提：手搭的 body 仍屬這份文件");
	assert.equal(collectFrom(orphan).length, 0, "不是頁面根就不豁免、照舊整棵不採");
});

// ---------------------------------------------------------------------------
// A6：root 不變式（全 fixture × 四組頁面根包裹，含無屬性對照）
// ---------------------------------------------------------------------------

test("A6 root 不變式：全 fixture × 四組頁面根包裹（含無屬性對照），body 為根與 documentElement 為根同輸出", () => {
	const manifest = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8"));
	// 裸包裹那一組修前就成立，留著當對照。真正的錨是 `html lang` 與 `html translate=no`
	// 兩組：修前 documentElement 為根時整份零段、body 為根時照常採集，兩邊不等。
	// `body lang` 那組修前是**兩邊一起零段**、這條比不出來，由下一條（A6b）頂住。
	const wraps = [
		{ desc: "裸包裹", html: "", body: "" },
		{ desc: "html lang", html: ` lang="zh-TW"`, body: "" },
		{ desc: "body lang", html: "", body: ` lang="zh-TW"` },
		{ desc: "html translate=no", html: ` translate="no"`, body: "" },
	];
	let compared = 0;
	for (const c of manifest.cases) {
		const caseHtml = readFileSync(join(FIXTURES, "cases", `${c.name}.html`), "utf8");
		for (const w of wraps) {
			const doc = docFrom(caseHtml, w.html, w.body);
			const viaBody = shape(collectFrom(doc.body), doc);
			const viaHTML = shape(collectFrom(doc.documentElement), doc);
			assert.deepEqual(viaHTML, viaBody, `${c.name} / ${w.desc}`);
			compared++;
		}
	}
	assert.equal(compared, manifest.cases.length * wraps.length);
});

test("A6b 頁面根帶 lang／translate=no 時仍採得到段——不變式不是靠兩邊一起歸零成立的", () => {
	// 上一條比的是「兩個根同輸出」，兩邊一起變 0 段也會過。這條釘住輸出非空，兩種訊號各一輪。
	const manifest = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8"));
	const rounds = [
		{ desc: "頁面根帶目標語 lang", html: ` lang="zh-TW"`, body: ` lang="zh-TW"` },
		{ desc: "頁面根帶 translate=no", html: ` translate="no"`, body: ` translate="no"` },
	];
	for (const r of rounds) {
		// 兩根分開累加、各自斷言：加總後再比會讓「只有其中一根整份歸零」這種退化維持綠。
		let viaBody = 0;
		let viaHTML = 0;
		for (const c of manifest.cases) {
			const caseHtml = readFileSync(join(FIXTURES, "cases", `${c.name}.html`), "utf8");
			const doc = docFrom(caseHtml, r.html, r.body);
			viaBody += collectFrom(doc.body).length;
			viaHTML += collectFrom(doc.documentElement).length;
		}
		assert.ok(viaBody > 0, `${r.desc}、body 為根時全 fixture 應仍採到段，實得 ${viaBody}`);
		assert.ok(viaHTML > 0, `${r.desc}、documentElement 為根時全 fixture 應仍採到段，實得 ${viaHTML}`);
	}
});
