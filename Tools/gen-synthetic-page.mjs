// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 合成頁產生器（benchmark 主基準用）。
//
// 為什麼是合成頁而不是抓真站：真站快照有授權與可重現兩個問題——授權要隨頁面走、
// 站台改版後量測就對不回去。合成頁由種子決定、同種子逐 byte 相同，量測基準因此
// 可以進版控、跨機重跑得到同一份輸入。
//
// 刻意排除的結構：`translate="no"`（白名單門檻仍在討論）與 `lang="zh-CN"` / `zh-Hans`
// 內容（簡中來源是否翻譯仍未定）。這兩軸一旦定案，段數就會變動；把它們放進基準頁
// 等於讓一個還會變的答案決定基準值。其餘規則皆已定案，可放心入頁。
//
// 用法：
//   node Tools/gen-synthetic-page.mjs                 印到 stdout
//   node Tools/gen-synthetic-page.mjs --sections 40   加大頁面
//   node Tools/gen-synthetic-page.mjs --out page.html 寫檔

import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import process from "node:process";

/** mulberry32：32-bit 種子 PRNG，同種子同序列。 */
function makeRandom(seed) {
	let a = seed >>> 0;
	return function random() {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// 自造詞彙：避免任何既有文本的授權問題，同時讓句子長到足以通過 §4 的 min-length 與
// numeric-only 過濾（純數字內容另由表格欄位刻意製造）。
const WORDS = [
	"aden", "brivel", "corund", "dalter", "emrose", "fandal", "golim", "hestra",
	"invar", "jorlic", "kandel", "lumeth", "morvic", "nestal", "orbith", "pellar",
	"quorin", "ristal", "sorven", "tamber", "ulvane", "vestro", "welkin", "xandor",
	"yarrow", "zephin", "calder", "dornic", "everly", "fintal", "garnet", "hollow",
];

const TITLE_WORDS = ["Ledger", "Harbor", "Signal", "Meridian", "Quarry", "Lantern", "Verdict", "Cascade"];

function pick(rng, list) {
	return list[Math.floor(rng() * list.length)];
}
function words(rng, n) {
	const out = [];
	for (let i = 0; i < n; i++) out.push(pick(rng, WORDS));
	return out.join(" ");
}
function sentence(rng, n) {
	const s = words(rng, n);
	return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}
function paragraphText(rng, sentences) {
	const out = [];
	for (let i = 0; i < sentences; i++) out.push(sentence(rng, 6 + Math.floor(rng() * 8)));
	return out.join(" ");
}
function intBetween(rng, lo, hi) {
	return lo + Math.floor(rng() * (hi - lo + 1));
}

/** 段落內鋪一層 inline 標記，逼採集層真的走 buffer flush 而不是一路 textContent。 */
function inlineParagraph(rng) {
	const lead = sentence(rng, intBetween(rng, 5, 9));
	const mid = words(rng, 3);
	const tail = sentence(rng, intBetween(rng, 4, 8));
	const roll = rng();
	if (roll < 0.3) return `<p>${lead} <a href="/${pick(rng, WORDS)}">${mid}</a> ${tail}</p>`;
	if (roll < 0.55) return `<p>${lead} <em>${mid}</em> ${tail}</p>`;
	if (roll < 0.75) return `<p>${lead} <strong>${mid}</strong> and <code>${pick(rng, WORDS)}_id</code> ${tail}</p>`;
	if (roll < 0.88) return `<p>${lead}<br>${tail}</p>`;
	return `<p>${lead} ${tail}</p>`;
}

// 三個邊界結構每頁固定出現一次（不看機率），否則整組計數對這幾條規則沒有鑑別力：
// 頁面裡若沒有任何極短段，min-length 門檻怎麼調計數都不會動；沒有超過 20 字的按鈕，
// button-class 的字數上限同理；display:contents 容器沒有相鄰的裸 inline，攤平與否
// 也切不出差別。這幾條規則自己不會製造樣本，得由基準頁主動提供。
function boundaryCases(rng) {
	return [
		`<div>${sentence(rng, 5)} <span data-d="contents">${sentence(rng, 4)} <p>${sentence(rng, 6)}</p> ${sentence(rng, 4)}</span> ${sentence(rng, 4)}</div>`,
		"<p>ok</p>",
		"<button>A deliberately long button label past the in-place limit</button>",
	].join("");
}

function section(rng, index) {
	const parts = [];
	parts.push(`<h2>${pick(rng, TITLE_WORDS)} ${index}</h2>`);
	if (index === 1) parts.push(boundaryCases(rng));

	const paras = intBetween(rng, 2, 4);
	for (let i = 0; i < paras; i++) parts.push(inlineParagraph(rng));

	if (rng() < 0.25) {
		const items = [];
		for (let i = 0; i < intBetween(rng, 3, 5); i++) items.push(`<li>${sentence(rng, intBetween(rng, 4, 7))}</li>`);
		parts.push(`<ul>${items.join("")}</ul>`);
	}

	if (rng() < 0.2) {
		// 表格含純數字欄：走 §4 numeric-only 分支、產 skipped 段而非略過不建。
		const rows = [];
		for (let r = 0; r < 3; r++) {
			rows.push(
				`<tr><td>${words(rng, 3)}</td><td>${intBetween(rng, 100, 9999)}</td><td>${words(rng, 2)} unit</td></tr>`,
			);
		}
		parts.push(`<table><tbody>${rows.join("")}</tbody></table>`);
	}

	if (rng() < 0.15) {
		// display:contents 透明穿透（PR #30）。刻意採 b05 的形狀——容器外要有相鄰的裸 inline
		// 文字，攤平與不攤平才會切出不同段數；把容器單獨放在 block 兄弟之間是分不出來的。
		parts.push(
			`<div>${sentence(rng, 5)} <span data-d="contents">${sentence(rng, 4)} <p>${sentence(rng, intBetween(rng, 5, 9))}</p> ${sentence(rng, 4)}</span> ${sentence(rng, 4)}</div>`,
		);
	}

	if (rng() < 0.15) parts.push(`<button>${words(rng, 2)}</button>`);

	if (rng() < 0.12) parts.push(`<div data-d="none">${paragraphText(rng, 2)}</div>`);

	if (rng() < 0.12) parts.push(`<script>var ${pick(rng, WORDS)} = ${intBetween(rng, 1, 500)};</script>`);

	if (rng() < 0.12) {
		parts.push(`<figure><figcaption>${sentence(rng, intBetween(rng, 4, 8))}</figcaption></figure>`);
	}

	return `<section>${parts.join("")}</section>`;
}

/**
 * 產生一份合成頁的 body 內容（不含 <html>/<body> 外殼，交給呼叫端包）。
 * @param {{ seed?: number, sections?: number }} [opts]
 * @returns {string}
 */
export function generateSyntheticPage(opts = {}) {
	const seed = opts.seed ?? 1;
	const sectionCount = opts.sections ?? 24;
	const rng = makeRandom(seed);

	const navLinks = [];
	for (let i = 0; i < 8; i++) navLinks.push(`<li><a href="/${pick(rng, WORDS)}">${words(rng, 2)}</a></li>`);

	const asideLinks = [];
	for (let i = 0; i < 6; i++) asideLinks.push(`<li><a href="/${pick(rng, WORDS)}">${words(rng, 3)}</a></li>`);

	const sections = [];
	for (let i = 1; i <= sectionCount; i++) sections.push(section(rng, i));

	return [
		"<header>",
		`<h1>${pick(rng, TITLE_WORDS)} ${pick(rng, TITLE_WORDS)}</h1>`,
		`<nav><ul>${navLinks.join("")}</ul></nav>`,
		"</header>",
		"<main>",
		sections.join(""),
		"</main>",
		// 無 landmark 祖先的一段：頁面若整片都包在 main/nav/aside 底下，區域分類的 cascade
		// 永遠停在第一步，三訊號評分那條路根本不會執行，region 計數也就對它沒有鑑別力。
		// 這裡刻意給兩塊——一塊連結密度高、class 命中 CHROME 詞表；一塊是長段純文字。
		`<div class="promo-widget"><p>${words(rng, 3)}</p><ul>${asideLinks.join("")}</ul></div>`,
		`<div><p>${paragraphText(rng, 3)}</p></div>`,
		`<aside><h2>Related</h2><ul>${asideLinks.join("")}</ul></aside>`,
		`<footer><p>${sentence(rng, 6)}</p><p>${intBetween(rng, 1900, 2100)}</p></footer>`,
	].join("");
}

function parseArgs(argv) {
	const out = { seed: 1, sections: 24, out: null };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--seed") out.seed = Number(argv[++i]);
		else if (a === "--sections") out.sections = Number(argv[++i]);
		else if (a === "--out") out.out = argv[++i];
	}
	return out;
}

// 直接執行時當 CLI；被 import 時只匯出函式。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const args = parseArgs(process.argv.slice(2));
	const body = generateSyntheticPage({ seed: args.seed, sections: args.sections });
	const html = `<!doctype html><html><body>${body}</body></html>\n`;
	if (args.out) writeFileSync(args.out, html);
	else process.stdout.write(html);
}
