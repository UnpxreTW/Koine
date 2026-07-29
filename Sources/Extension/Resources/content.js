// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 雅言 Koine — M1 DOM 採集層（content script，注入每個頁面）。
//
// 設計來源：SPEC-collect-layer（採集核心＝兩遍 walk + inline buffer flush、
// 採集產物＝Segment IR、block/inline 判斷＝computed display + FORCE_BLOCK 白名單）。
//
// 通用腳本（universal script）：
//   - Safari 載入為 classic content script（無 import/export 語法）。
//   - node --test 以 ESM 副作用載入，純函式經 globalThis.__koine__ 取用。
//   - 自動執行的 main() 用 typeof document/browser 守門，node 載入時不觸發。
//   - getComputedStyle 一律走 ctx.getStyle 注入，跑道 A（linkedom）可餵 stub。

"use strict";

// ============================================================================
// §2.3 / §3.1 / §3.2 三張集合（照抄 Read Frog 原始值、不偷加）
// ============================================================================

/** §2.3 FORCE_BLOCK_TAGS — 白名單一律當 block（Read Frog 原始 25 個）。 */
const FORCE_BLOCK_TAGS = new Set([
	"BODY", "H1", "H2", "H3", "H4", "H5", "H6", "BR",
	"FORM", "SELECT", "BUTTON", "LABEL", "UL", "OL", "LI",
	"BLOCKQUOTE", "PRE", "ARTICLE", "SECTION", "FIGURE", "FIGCAPTION",
	"HEADER", "FOOTER", "MAIN", "NAV",
]);

/** §3.1 SKIP_SUBTREE_TAGS — 整棵跳過、不採集不翻。 */
const SKIP_SUBTREE_TAGS = new Set([
	"SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE",
	"TEXTAREA", "INPUT", "OPTION", "OPTGROUP",
	"SVG", "CANVAS", "AUDIO", "VIDEO", "IMG", "SOURCE", "TRACK",
	"IFRAME", "OBJECT", "EMBED",
	"HEAD", "TITLE", "META", "LINK", "BASE",
	"HR", "RT", "RP",
]);

/** §3.2 OPAQUE_INLINE_TAGS — 不展開、textContent 併入父段（不可分割原子）。 */
const OPAQUE_INLINE_TAGS = new Set(["CODE", "TIME"]);

/**
 * §3.5 BULK_TRANSLATE_NO_TAGS — translate="no" 在**整站級**容器視為框架誤標、降級不尊重。
 * 只收 BODY：`MAIN` / `ARTICLE` / `SECTION` 上的標記一律尊重——站台意圖優先於救誤標，
 * 代價（整站誤標若標在 MAIN／ARTICLE 上會整段不翻）已知並接受。
 * BODY 之所以必須留著：它是 collectSegments 的預設 root，`walkAndLabel` 會分類 root 自身，
 * root 落 SKIP_SUBTREE 就整棵不採（見 collectSegments 尾端的 root 閘）——`<body translate="no">`
 * 的頁面會一段都採不到。
 */
const BULK_TRANSLATE_NO_TAGS = new Set(["BODY"]);

/** §3.4 role 強制黑名單。 */
const SKIP_ROLES = new Set([
	"presentation", "none", "math", "progressbar", "slider",
	"spinbutton", "scrollbar", "separator",
]);

// 三態節點處置（§0.1）。
/** @typedef {'SKIP_SUBTREE'|'OPAQUE_INLINE'|'WALK'} NodeDisposition */

const NODE_ELEMENT = 1;
const NODE_TEXT = 3;
const NODE_PI = 7;
const NODE_COMMENT = 8;
// 無自身盒、無屬性的容器節點：以子樹為 root 呼叫採集時的合法容器（Document／DocumentFragment）。
const NODE_DOCUMENT = 9;
const NODE_FRAGMENT = 11;

/** 是否為無自身盒的容器節點（Document / DocumentFragment）：不產段、不擋子代、直接走進去。 */
function isContainerNode(node) {
	return !!node && (node.nodeType === NODE_DOCUMENT || node.nodeType === NODE_FRAGMENT);
}

// ============================================================================
// §P4 button-class 窄判準（KO-5）：BUTTON／LABEL／role=button，
// 另需在採集期核「≤20 字」與「無 block 子」（見 collectSegments 的 isButtonClassCandidate）。
// ============================================================================

/** button-class 段的譯文換字上限字數（超過退回一般 block／wrapper 流程）。 */
const BUTTON_CLASS_MAX_CHARS = 20;

/**
 * §9.2 replace 段把原文寫進 `title` 的長度上限。`title` 是「短標籤的 tooltip」慣例：整段文章
 * 塞進去會變成巨大 tooltip，且 `title` 會被輔助技術當成該元素的可及描述唸出。沿用 button-class
 * 的「短互動文字」門檻、不另立第二套長度標準——超過就只留 `data-koine-original`（純資料、
 * 不影響 hover 與可及名稱）。
 */
const REPLACE_TITLE_MAX_CHARS = BUTTON_CLASS_MAX_CHARS;

/** @param {Element} el */
function hasButtonRole(el) {
	const role = typeof el.getAttribute === "function" ? el.getAttribute("role") : null;
	return !!role && role.toLowerCase().trim() === "button";
}

/** 元素自身是否符合 button-class 標籤／role 判準（不含長度與 block 子檢查）。 @param {Element} el */
function isButtonClassElement(el) {
	if (!el || el.nodeType !== NODE_ELEMENT) return false;
	return el.tagName === "BUTTON" || el.tagName === "LABEL" || hasButtonRole(el);
}

/**
 * 是否只有純文字子代（無任何元素子節點，含 SKIP_SUBTREE 如 svg/img、OPAQUE_INLINE 如 code/time、
 * 一般 inline 元素如 span/strong）。原地換字用 `el.textContent = 譯文` 整個覆寫、會連帶砍掉所有
 * 元素子節點——icon（svg/img）等非文字資源一旦被砍就回不來，且這類節點常是 SKIP_SUBTREE，完全不會
 * 反映在 source／長度判準裡（採集時就已被過濾、對判準不可見）。保守起步：只要有任何元素子節點就不
 * 命中 button-class，退回一般 block／wrapper 流程（wrapper 只加 sibling、不動原元素、天生安全）。
 * @param {Element} el
 */
function hasOnlyTextChildren(el) {
	if (!el || typeof el.childNodes === "undefined") return false;
	for (const child of el.childNodes) {
		if (child.nodeType !== NODE_TEXT) return false;
	}
	return true;
}

// ============================================================================
// §2.1 block/inline 判斷收斂核心
// ============================================================================

/**
 * §2.4 `display:contents`：元素本身不產生任何盒，子節點就地當父的子節點參與版面。
 * 採集層對應處置＝透明穿透（走訪時展開子節點重判，見 walkAndLabel / collectSegments），
 * 不把整個容器當成一個不可分割的 inline 原子。
 * @param {string} display
 * @returns {boolean}
 */
function isTransparentDisplay(display) {
	return display === "contents";
}

/**
 * 所有 display 最終歸三條：startsWith('inline') ∨ === 'contents' ∨ startsWith('ruby')，否則 block。
 * contents 回 true 的意思是「不是 block 盒」（它根本沒有盒）——真正的處置是透明穿透，
 * 由走訪層在此判斷之前先攤平掉，不會有 contents 元素以 inline 身分留在段落 buffer 裡。
 * @param {string} display
 * @returns {boolean}
 */
function isInlineDisplay(display) {
	if (!display) return false;
	if (display.startsWith("inline")) return true; // inline / inline-block / inline-flex|grid|table
	if (isTransparentDisplay(display)) return true; // §2.4 無盒 → 絕不可當 block（實際走透明穿透）
	if (display.startsWith("ruby")) return true;    // 實際只 cover <ruby> 容器
	return false;
}

/** @param {Element} el */
function hasText(el) {
	return el.textContent != null && el.textContent.trim().length > 0;
}

// ============================================================================
// §4 worthTranslating 內容過濾（inline 合併後 source 送翻前的純函式 gate）
// ============================================================================

const RE_WHITESPACE_ONLY = /^\p{White_Space}*$/u;
const RE_EMOJI_SHELL = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}️‍]/u;
const RE_EMOJI_BODY = /^[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}️‍\p{White_Space}\p{P}\p{S}]*$/u;
const RE_PUNCT_ONLY = /^[\p{P}\p{S}\p{White_Space}]+$/u;
const RE_HAS_ALNUM = /[\p{L}\p{N}]/u;
// §4.2 numeric-only（補 \p{No}\p{Nl} 進字符類與守門）。
const RE_NUMERIC = /^[\p{Nd}\p{No}\p{Nl}\p{Sc}.,%+\-–—−:/()\p{White_Space}]+$/u;
const RE_HAS_NUM = /[\p{Nd}\p{No}\p{Nl}]/u;
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
// §4.3 URL（每 branch 各自 \S+；bare-domain branch 末段 TLD 守門＝≥2 ASCII 字母，擋 v1.2.3 / U.S.A / e.g）。
const RE_URL = /^(?:(?:https?:\/\/|ftp:\/\/|www\.)\S+|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/?#]\S*)?)$/iu;
const RE_PATH = /^(?:\/|\.{1,2}\/|~\/|[a-z]:\\)\S*$/iu;
const RE_HAS_LETTER = /\p{L}/u;
const RE_HAS_HAN = /\p{Script=Han}/u;
const RE_HAS_KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const RE_HAS_HANGUL = /\p{Script=Hangul}/u;

/** §4.8 filename 白名單副檔名。 */
const KNOWN_EXT = new Set([
	"js", "ts", "jsx", "tsx", "mjs", "cjs", "json", "html", "htm", "css",
	"md", "txt", "csv", "xml", "yml", "yaml", "toml",
	"png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "pdf",
	"zip", "tar", "gz", "rar", "7z",
	"mp3", "mp4", "mov", "wav", "avi", "mkv",
	"swift", "py", "rb", "go", "rs", "c", "h", "cpp", "java", "sh",
]);

/**
 * @typedef {object} WorthResult
 * @property {boolean} worth
 * @property {string=} reason
 */

/**
 * @param {string} raw
 * @param {{ pageLangIsZh?: boolean }} [opts]
 * @returns {WorthResult}
 */
function worthTranslating(raw, opts = {}) {
	// R0 NFC + trim（僅供判斷、不改 source）；顯式去 ZWSP / soft-hyphen。
	const t = raw.normalize("NFC").replace(/[​­]/gu, "").trim();

	if (t === "" || RE_WHITESPACE_ONLY.test(t)) return { worth: false, reason: "whitespace" };
	if (!RE_HAS_LETTER.test(t) && RE_EMOJI_SHELL.test(t) && RE_EMOJI_BODY.test(t)) {
		return { worth: false, reason: "emoji" };
	}
	if (RE_PUNCT_ONLY.test(t) && !RE_HAS_ALNUM.test(t)) return { worth: false, reason: "punct" };
	if (RE_NUMERIC.test(t) && RE_HAS_NUM.test(t) && !RE_HAS_LETTER.test(t)) {
		return { worth: false, reason: "numeric" };
	}
	if (RE_EMAIL.test(t)) return { worth: false, reason: "email" };
	if (RE_URL.test(t)) return { worth: false, reason: "url" };
	if (RE_PATH.test(t)) return { worth: false, reason: "path" };
	if (isFilenameOnly(t)) return { worth: false, reason: "filename" };

	// R9 already-target：整頁語言 gate（非逐段 Han-ratio）；kana / hangul 強制送翻。
	if (opts.pageLangIsZh && RE_HAS_HAN.test(t) && !RE_HAS_KANA.test(t) && !RE_HAS_HANGUL.test(t)) {
		return { worth: false, reason: "already-target" };
	}

	// R11 min-length：非漢字段，任何 \p{L} 字母數 < 2 才跳（非僅拉丁）。
	if (!RE_HAS_HAN.test(t)) {
		let letters = 0;
		for (const c of t) if (RE_HAS_LETTER.test(c)) letters++;
		if (letters < 2) return { worth: false, reason: "min-length" };
	}

	return { worth: true };
}

/** §4.8 單 token + 已知副檔名。 */
function isFilenameOnly(t) {
	if (/\s/u.test(t)) return false;
	const dot = t.lastIndexOf(".");
	if (dot <= 0 || dot === t.length - 1) return false;
	return KNOWN_EXT.has(t.slice(dot + 1).toLowerCase());
}

/**
 * §4.9 pageLangIsZh 偵測（P2）：main() 一次呼叫、餵給 makeContext，供 R9 already-target gate 用。
 * 純函式：優先讀 documentElement 的 lang（zh-Hant/zh-TW/zh-HK/裸 zh → true；zh-CN/zh-Hans → false，
 * 簡中頁仍需譯成目標 zh-Hant；明確非 zh 語碼 → false）；缺 lang 屬性才退回取樣文字 heuristic
 * （純漢字、無假名/諺文 → 視為中文頁，同 R9 逐段判斷邏輯）。
 * @param {string | null | undefined} htmlLang document.documentElement 的 lang 屬性
 * @param {string} [sample] 缺 lang 屬性時的取樣文字（如 document.body.textContent 片段；呼叫端截斷）
 * @returns {boolean}
 */
function detectPageLangIsZh(htmlLang, sample = "") {
	const lang = htmlLang?.toLowerCase().trim();
	if (lang) {
		if (lang === "zh-cn" || lang.startsWith("zh-hans")) return false;
		return lang === "zh" || lang.startsWith("zh-hant") || lang.startsWith("zh-tw")
			|| lang.startsWith("zh-hk") || lang.startsWith("zh-mo"); // 繁中變體集與 isTraditionalChineseTarget 同步
	}
	return RE_HAS_HAN.test(sample) && !RE_HAS_KANA.test(sample) && !RE_HAS_HANGUL.test(sample);
}

// ============================================================================
// ctx：採集情境（getStyle 注入、targetLang、站台覆寫、display 快取）
// ============================================================================

/**
 * @typedef {object} StyleInfo
 * @property {string} display
 * @property {string} visibility
 * @property {string} contentVisibility
 */

/**
 * @typedef {object} CollectContext
 * @property {string} targetLang
 * @property {boolean} pageLangIsZh
 * @property {(el: Element) => StyleInfo} getStyle
 * @property {WeakMap<Element, StyleInfo>} _styleCache
 */

/**
 * 瀏覽器預設 getStyle：getComputedStyle 一次、WeakMap 快取（§8）。
 * @param {Element} el
 * @param {WeakMap<Element, StyleInfo>} cache
 * @returns {StyleInfo}
 */
function browserGetStyle(el, cache) {
	let s = cache.get(el);
	if (s) return s;
	const cs = getComputedStyle(el);
	s = {
		display: cs.display,
		visibility: cs.visibility,
		contentVisibility: cs.getPropertyValue("content-visibility"),
	};
	cache.set(el, s);
	return s;
}

/**
 * @param {Partial<CollectContext>} [opts]
 * @returns {CollectContext}
 */
function makeContext(opts = {}) {
	const cache = opts._styleCache || new WeakMap();
	return {
		targetLang: opts.targetLang || "zh-Hant",
		pageLangIsZh: opts.pageLangIsZh ?? false,
		getStyle: opts.getStyle || ((el) => browserGetStyle(el, cache)),
		_styleCache: cache,
	};
}

// ============================================================================
// §5 classifyNode 判斷順序（短路最佳化、每元素一次 getStyle）
// ============================================================================

/**
 * @param {Node} node
 * @param {CollectContext} ctx
 * @returns {{ disp: NodeDisposition, cs: StyleInfo | null }}
 */
function classifyNode(node, ctx) {
	// [0] node type 閘
	if (node.nodeType === NODE_TEXT) return { disp: "WALK", cs: null };
	if (node.nodeType === NODE_COMMENT || node.nodeType === NODE_PI) {
		return { disp: "SKIP_SUBTREE", cs: null };
	}
	if (node.nodeType !== NODE_ELEMENT) return { disp: "SKIP_SUBTREE", cs: null };

	const el = /** @type {Element} */ (node);
	const tag = el.tagName;

	// [1] 自家標記（二次 walk 高命中、最便宜）；data-koine-translated 是 §P4 button-class 原地換字
	// 的防自吞標記——標記消失（框架重渲染換掉節點、或標記被清）即不再命中此檢查、自動視為未譯重新採集。
	if (el.hasAttribute("data-koine-id") || el.classList.contains("koine-translated")
		|| el.hasAttribute("data-koine-translated")) {
		return { disp: "SKIP_SUBTREE", cs: null };
	}

	// [2] 硬標籤黑名單（Set.has O(1)、整棵剪枝）；MathML 命中根即整棵跳
	if (SKIP_SUBTREE_TAGS.has(tag) || tag === "MATH") return { disp: "SKIP_SUBTREE", cs: null };

	// [3] PRE → SKIP；CODE（祖先無 PRE）→ OPAQUE
	if (tag === "PRE") return { disp: "SKIP_SUBTREE", cs: null };
	if (tag === "CODE") {
		const inPre = typeof el.closest === "function" && el.closest("pre");
		return inPre ? { disp: "SKIP_SUBTREE", cs: null } : { disp: "OPAQUE_INLINE", cs: null };
	}

	// [4] OPAQUE_INLINE_TAGS（trim 非空才併）
	if (OPAQUE_INLINE_TAGS.has(tag)) {
		return hasText(el) ? { disp: "OPAQUE_INLINE", cs: null } : { disp: "SKIP_SUBTREE", cs: null };
	}

	// [5] 屬性隱藏 / 語意（純屬性讀取、無 reflow）
	if (el.getAttribute("aria-hidden") === "true") return { disp: "SKIP_SUBTREE", cs: null };
	if (el.hidden === true || el.hasAttribute("hidden")) return { disp: "SKIP_SUBTREE", cs: null };
	if (isContentEditable(el)) return { disp: "SKIP_SUBTREE", cs: null };
	const role = el.getAttribute("role");
	if (role && SKIP_ROLES.has(role.toLowerCase().trim())) return { disp: "SKIP_SUBTREE", cs: null };
	if (hasSkipClass(el)) return { disp: "SKIP_SUBTREE", cs: null };

	// [6] translate-no（容器白名單護欄）
	if (respectsTranslateNo(el)) {
		// block 級 → SKIP_SUBTREE；行內留待 §6 buffer 當 OPAQUE 併（此處先整棵跳，行內 case 由覆寫表處理）
		return { disp: "SKIP_SUBTREE", cs: null };
	}

	// [7] 站台覆寫（hostname → selector，v1 空表）— 預留

	// [8] lang 自身為目標語（不繼承）
	if (isAlreadyTargetLang(el, ctx.targetLang)) return { disp: "SKIP_SUBTREE", cs: null };

	// [9] getStyle（唯一一次）：display:none / visibility / content-visibility
	const cs = ctx.getStyle(el);
	if (cs.display === "none" || cs.display === "") return { disp: "SKIP_SUBTREE", cs };
	if (cs.contentVisibility === "hidden") return { disp: "SKIP_SUBTREE", cs };
	// visibility:hidden 不整棵跳（§3.7 B5）：自身不產段、續 walk 子孫 → 交給採集核心，此處放行
	return { disp: "WALK", cs };
}

/** contenteditable 繼承（§3.4 安全紅線）。 */
function isContentEditable(el) {
	if (typeof el.isContentEditable === "boolean") return el.isContentEditable;
	const v = el.getAttribute("contenteditable");
	return v === "" || v === "true";
}

/** §3.4 sr-only / visually-hidden class 比對。 */
function hasSkipClass(el) {
	return el.classList.contains("sr-only") || el.classList.contains("visually-hidden");
}

/** §3.5 translate="no" / .notranslate，大容器降級不尊重。 */
function respectsTranslateNo(el) {
	// 只看元素自身明示訊號（attribute / class）；不用 el.translate IDL——該屬性會繼承
	// 祖先 translate="no"，使大容器降級放行後、內層非大容器子代仍被當 no 而整棵跳
	// （真 WebKit 實證：跑道 B fixture 13 產空段；linkedom 不實作此 IDL 故跑道 A 抓不到）。
	// 與 §3.6 lang「只看自身不繼承」一致；元素自帶 explicit translate=no 仍由 getAttribute 命中。
	const no = el.getAttribute("translate") === "no"
		|| el.classList.contains("notranslate");
	if (!no) return false;
	return !BULK_TRANSLATE_NO_TAGS.has(el.tagName);
}

/** §3.6 lang 自身為目標語（只看自身、不繼承祖先）。依傳入 targetLang 判斷，非硬編 zh。 */
function isAlreadyTargetLang(el, targetLang) {
	const lang = el.getAttribute("lang")?.toLowerCase().trim();
	if (!lang || !targetLang) return false;
	const target = targetLang.toLowerCase().trim();
	// zh 目標：script 變體需嚴格區分，簡中（zh-CN/zh-Hans）不視為已達繁中目標（待 Apple 支援度實測）。
	if (target === "zh" || target.startsWith("zh-hant") || target.startsWith("zh-tw")) {
		if (lang === "zh-cn" || lang.startsWith("zh-hans")) return false;
		return lang === "zh" || lang.startsWith("zh-hant") || lang.startsWith("zh-tw");
	}
	if (target === "zh-cn" || target.startsWith("zh-hans")) {
		return lang === "zh-cn" || lang.startsWith("zh-hans");
	}
	// 非 zh 目標：比對 BCP-47 primary language subtag（忽略地區／script 子標籤）。
	return lang.split("-")[0] === target.split("-")[0];
}

/**
 * §3.6 目標語是否為繁中（`insertMode` 語言對軸用）。
 * 收 `zh-hk` / `zh-mo`：兩者慣用繁體字，與 `detectPageLangIsZh` 用同一組繁中變體集（該處已一併補上 `zh-mo`）。
 * ⚠ 已知既有落差（非本函式造成）：`isAlreadyTargetLang` 對非 `zh` / `zh-hant` / `zh-tw` 的
 * 目標語會落到 BCP-47 primary subtag 比對，`zh-HK` 目標下 `lang="zh-CN"` 的段會被判成
 * 「已達目標語」而整棵跳，輪不到本軸。今天不現形（`makeContext` 硬編 `zh-Hant` 預設、
 * targetLang 無處配置），目標語一旦可選就要一起修。
 * @param {string} [targetLang]
 */
function isTraditionalChineseTarget(targetLang) {
	const t = targetLang?.toLowerCase().trim();
	if (!t) return false;
	return t === "zh" || t.startsWith("zh-hant") || t.startsWith("zh-tw")
		|| t.startsWith("zh-hk") || t.startsWith("zh-mo");
}

/** §3.6 語碼是否為簡中變體。 @param {string|null|undefined} lang 已小寫 trim 的語碼 */
function isSimplifiedChinese(lang) {
	if (!lang) return false;
	return lang === "zh-cn" || lang.startsWith("zh-hans");
}

/**
 * §3.6 元素自身的 `lang`，已小寫 trim。**三態、不可折成兩態**：
 * - `null`＝沒有 `lang` 屬性 → 語言由祖先決定（繼承）。
 * - `""`＝有 `lang` 但值為空 → HTML 規範的「語言未知」，**明確不繼承祖先**、到此為止。
 * - 其他＝該語碼。
 *
 * 把 `""` 折進 `null` 會讓 `lang=""` 靜默繼承祖先語言——正是這個函式最容易寫錯的地方，
 * 且錯的那一側是破壞性的（誤判成簡中就會就地取代、原文從頁面消失）。
 * @param {Element} el
 * @returns {string|null}
 */
function ownLangOf(el) {
	if (!el || typeof el.getAttribute !== "function") return null;
	const raw = el.getAttribute("lang");
	if (raw === null || raw === undefined) return null; // 無屬性 → 繼承
	return raw.toLowerCase().trim();                     // 含 "" → 語言未知、不繼承
}

/**
 * §3.6 段的**有效** lang：自身 `lang` 優先、否則取最近有 `lang` 的祖先（含 `<html>`＝頁面級回退）。
 *
 * 與 `isAlreadyTargetLang`「只看自身、不繼承」刻意不同——那條解的是「這段要不要翻」（繼承會讓
 * `<html lang="zh-TW">` 底下未標 lang 的英文段被誤跳），本函式解的是「這段是什麼語言」，
 * 繼承正是 HTML 對 lang 的定義。
 *
 * 只覆蓋「自身 lang」與「祖先／頁面 lang」兩層；**依內容文字偵測語言尚未實作**，查不到 lang
 * 即回 null、呼叫端保守處理（不確定就不動原文）。
 *
 * 採集路徑不呼叫本函式——`walkAndLabel` 已把有效 lang 以下行增量寫進 `NodeLabel.lang`
 * （O(1)/段，同 region 的作法）；本函式是未進 labels 的防禦路徑與純函式測試用。
 * @param {Element} el
 * @returns {string|null} 已小寫 trim 的語碼；查無回 null
 */
function effectiveLangOf(el) {
	if (!el || typeof el.closest !== "function") return null;
	const holder = el.closest("[lang]");
	if (!holder) return null;
	// 最近帶 lang 屬性的祖先（含自身）說了算，`lang=""` 亦然（＝語言未知、不再往上找）。
	// 必須與 walkAndLabel 的下行增量給出同一個答案——兩條路徑分歧時，錯的那一側會是破壞性的。
	return ownLangOf(/** @type {Element} */ (holder));
}



// ============================================================================
// §6.5 classifyRegion 區域分類（P3）：Segment 標 main / chrome，供 §10 排程消費
// ============================================================================

/** @typedef {'main'|'chrome'} RegionValue */

/** Region enum（UNKNOWN 折進 MAIN）。順序非範圍：chrome 降權後仍翻、不跳過。 */
const Region = Object.freeze({ MAIN: "main", CHROME: "chrome" });

/** §6.5 landmark tag 對照（最近祖先勝：`<article><nav>` 內 TOC 判 CHROME）。 */
const REGION_MAIN_TAGS = new Set(["MAIN", "ARTICLE"]);
const REGION_CHROME_TAGS = new Set(["NAV", "HEADER", "FOOTER", "ASIDE"]);
/** §6.5 landmark ARIA role 對照（banner=header、contentinfo=footer、complementary=aside）。 */
const REGION_MAIN_ROLES = new Set(["main", "article"]);
const REGION_CHROME_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search"]);

// §6.5 訊號① class/id regex（Readability unlikelyCandidates 式）。
// MAIN 先查＝both-match 偏 MAIN（非對稱預設的低害側，同 Readability okMaybeItsACandidate 救回）。
const RE_REGION_MAIN_HINT = /article|content|post|main|story|body|entry/i;
const RE_REGION_CHROME_HINT = /nav|menu|sidebar|footer|header|breadcrumb|widget|banner|promo|social|comment/i;

/**
 * 元素自身的 landmark region；非 landmark 回 null。role 先於 tag（顯式 ARIA 覆蓋隱式語意）。
 * @param {Element} el
 * @returns {RegionValue|null}
 */
function landmarkRegionOf(el) {
	if (typeof el.getAttribute === "function") {
		const role = el.getAttribute("role");
		if (role) {
			const r = role.toLowerCase().trim();
			if (REGION_MAIN_ROLES.has(r)) return Region.MAIN;
			if (REGION_CHROME_ROLES.has(r)) return Region.CHROME;
		}
	}
	const tag = el.tagName;
	if (REGION_MAIN_TAGS.has(tag)) return Region.MAIN;
	if (REGION_CHROME_TAGS.has(tag)) return Region.CHROME;
	return null;
}

/**
 * 元素自身的 class/id hint（§6.5 訊號①）；無訊號回 null。
 * @param {Element} el
 * @returns {RegionValue|null}
 */
function regionHintOf(el) {
	const cls = typeof el.className === "string" ? el.className : "";
	const id = el.id || "";
	if (!cls && !id) return null;
	const s = cls + " " + id;
	if (RE_REGION_MAIN_HINT.test(s)) return Region.MAIN;
	if (RE_REGION_CHROME_HINT.test(s)) return Region.CHROME;
	return null;
}

/**
 * §6.5 cascade 第 2/3 步：無 landmark 祖先時的三訊號 layout-free 評分（不讀 rect）。
 * ① 最近 class/id hint ±2；② link-density > 0.5 → CHROME +2；③ 文字長 >120 → MAIN +2、<40 → CHROME +1。
 * 同分/零訊號 → MAIN（非對稱預設：main 誤判 chrome 餓死正文＝高害、反向只是早譯＝低害）。
 * @param {Element} block
 * @param {RegionValue|null} hint  最近 class/id hint（含自身；由 walk stack 或 walk-up 提供）
 * @returns {RegionValue}
 */
function heuristicRegion(block, hint) {
	let main = 0;
	let chrome = 0;
	if (hint === Region.MAIN) main += 2;
	else if (hint === Region.CHROME) chrome += 2;
	const text = (block.textContent || "").trim();
	const len = text.length;
	if (len > 0 && typeof block.querySelectorAll === "function") {
		let linkLen = 0;
		for (const a of block.querySelectorAll("a")) linkLen += (a.textContent || "").trim().length;
		if (linkLen / len > 0.5) chrome += 2;
	}
	if (len > 120) main += 2;
	else if (len < 40) chrome += 1;
	return chrome > main ? Region.CHROME : Region.MAIN;
}

/**
 * §6.5 完整 cascade（walk-up 形；採集熱路徑用 walkAndLabel 下行 stack 增量等價版、O(1)/段）：
 * 1 最近 landmark 祖先（含自身）首個命中即定 → 2 無 landmark 時三訊號評分 → 3 不確定 MAIN。
 * @param {Element} el  段的 anchor.block
 * @returns {RegionValue}
 */
function classifyRegion(el) {
	for (let n = el; n && n.nodeType === NODE_ELEMENT; n = n.parentElement) {
		const r = landmarkRegionOf(n);
		if (r) return r;
	}
	/** @type {RegionValue|null} */
	let hint = null;
	for (let n = el; n && n.nodeType === NODE_ELEMENT; n = n.parentElement) {
		hint = regionHintOf(n);
		if (hint) break;
	}
	return heuristicRegion(el, hint);
}

// ============================================================================
// §9 Segment IR
// ============================================================================

const SegmentState = Object.freeze({
	PENDING: "pending", DRAFTING: "drafting", DRAFTED: "drafted",
	REFINING: "refining", REFINED: "refined", FAILED: "failed",
	SKIPPED: "skipped", STALE: "stale",
});

/**
 * @typedef {object} ProtectedSpan
 * @property {number} start
 * @property {number} end
 * @property {string} kind   // 'code' | 'time'
 */

/**
 * §9.2 插回模式——譯文怎麼進 DOM。**replace 的唯一擴充點**，兩條觸發軸共用同一條 render 分支：
 * ①段的種類（§P4 button-class）②語言對（簡中→繁中）。詳見 collectSegments 的 decideInsertMode。
 * @typedef {'after-segment'|'replace'} InsertMode
 */

/**
 * @typedef {object} Segment
 * @property {string} id
 * @property {number} order
 * @property {RegionValue} region   // §6.5 / §9.1：採集期算、留 JS 端不過 bridge
 * @property {string} source
 * @property {object} anchor
 * @property {string} state
 * @property {'block'|'button'} [kind]   // §P4：button-class 窄判準命中時 = "button"（段的種類分類；
 *                                       // 插回行為看 anchor.insertMode、不看本欄）
 * @property {{ protectedSpans?: ProtectedSpan[], skipReason?: string, charCount?: number, replaceSnapshot?: string }} [meta]
 *   replaceSnapshot：insertMode = "replace" 的段專用，採集當下未過濾的原始 textContent（供插回時字面防呆比對）
 */

// ============================================================================
// §6 採集演算法（兩遍 walk + buffer flush）
// ============================================================================

/** 子節點走訪：open shadow root 穿透（§5 C1）。 */
function* childNodes(node) {
	for (const c of node.childNodes) yield c;
}

/**
 * @typedef {object} NodeLabel
 * @property {NodeDisposition} disp
 * @property {StyleInfo|null} cs
 * @property {boolean} isBlock         // shallow block ∨ 含 block 子（forceBlock 上傳）
 * @property {boolean} hasBlockDescendant // §P4：isBlock 拆解出的純子代旗標（不含自身 shallowBlock），
 *                                         // 供 button-class 窄判準「無 block 子」核對（KO-5）
 * @property {boolean} transparent     // §2.4 display:contents：本身無盒，第二遍就地展開子節點重判
 * @property {string|null} lang        // §3.6 有效 lang：自身 lang，否則繼承祖先（含 <html>）；查無為 null
 * @property {RegionValue|null} region     // §6.5 最近 landmark 祖先（含自身）；無 landmark 為 null
 * @property {RegionValue|null} regionHint // §6.5 最近 class/id hint（含自身）；無訊號為 null
 */

/**
 * 第一遍：標籤 + forceBlock 上傳 + 算 hasBlockDescendant + region landmark/hint 下行增量（§6.5）。
 * @param {Node} root
 * @param {CollectContext} ctx
 * @returns {WeakMap<Node, NodeLabel>}
 */
function walkAndLabel(root, ctx) {
	/** @type {WeakMap<Node, NodeLabel>} */
	const labels = new WeakMap();

	// §6.5 region 初始 context：root 祖先鏈的最近 landmark / hint（root 自身由 visit 首層算）。
	/** @type {RegionValue|null} */
	let rootLandmark = null;
	/** @type {RegionValue|null} */
	let rootHint = null;
	// §3.6 lang 同走下行增量（最近者勝）：root 的起始值取自祖先鏈（root ＝ <body> 時通常是 <html lang>）。
	/** @type {string|null} */
	let rootLang = null;
	const rootEl = /** @type {Element} */ (root);
	for (let n = rootEl.parentElement; n && n.nodeType === NODE_ELEMENT; n = n.parentElement) {
		if (!rootLandmark) rootLandmark = landmarkRegionOf(n);
		if (!rootHint) rootHint = regionHintOf(n);
		if (rootLang === null) rootLang = ownLangOf(n); // "" 也算找到（語言未知）、停止上溯
		if (rootLandmark && rootHint && rootLang !== null) break;
	}

	/**
	 * @param {Node} node
	 * @param {RegionValue|null} landmark  繼承的最近 landmark region
	 * @param {RegionValue|null} hint      繼承的最近 class/id hint
	 * @param {string|null} lang           繼承的最近 lang（§3.6）
	 * @returns {boolean} hasBlockDescendant（含自身為 block）
	 */
	function visit(node, landmark, hint, lang) {
		// Document / DocumentFragment：無自身盒與屬性，不產段、不擋子代，直接走進去。
		// 以子樹為 root 呼叫採集（動態重採、離線片段）時 DocumentFragment 是最典型的容器，
		// 少了這條它會落到 classifyNode 的「非元素即 SKIP_SUBTREE」而整棵不採。
		if (isContainerNode(node)) {
			let hasBlockChild = false;
			for (const child of childNodes(node)) {
				if (visit(child, landmark, hint, lang)) hasBlockChild = true;
			}
			labels.set(node, {
				disp: "WALK", cs: null, isBlock: true, hasBlockDescendant: hasBlockChild,
				transparent: false, lang, region: landmark, regionHint: hint,
			});
			return true; // 容器對父層而言等同 block（實務上不會有父層）
		}
		const { disp, cs } = classifyNode(node, ctx);
		if (disp === "SKIP_SUBTREE") {
			labels.set(node, {
				disp, cs, isBlock: false, hasBlockDescendant: false, transparent: false,
				lang, region: landmark, regionHint: hint,
			});
			return false;
		}
		if (disp === "OPAQUE_INLINE") {
			labels.set(node, {
				disp, cs, isBlock: false, hasBlockDescendant: false, transparent: false,
				lang, region: landmark, regionHint: hint,
			});
			return false; // 不展開、不可分割、視為 inline
		}
		// WALK
		if (node.nodeType === NODE_TEXT) {
			labels.set(node, {
				disp, cs, isBlock: false, hasBlockDescendant: false, transparent: false,
				lang, region: landmark, regionHint: hint,
			});
			return false;
		}

		const el = /** @type {Element} */ (node);
		// §6.5 下行增量：最近者勝（更近 landmark / hint 覆蓋繼承值）、O(1)/段。
		const region = landmarkRegionOf(el) || landmark;
		const nearHint = regionHintOf(el) || hint;
		// `??` 不能換成 `||`：`lang=""`（語言未知）是有效值、不得回退成繼承（見 ownLangOf）。
		const ownLang = ownLangOf(el);
		const nearLang = ownLang === null ? lang : ownLang;
		let hasBlockChild = false;
		for (const child of childNodes(el)) {
			if (visit(child, region, nearHint, nearLang)) hasBlockChild = true;
		}
		if (el.shadowRoot) {
			// shadow 內的段沿用宿主元素的有效 lang（`closest` 不跨 shadow 邊界、下行增量會，
			// 方向上更接近使用者對「這塊是什麼語言」的直覺）。
			for (const child of childNodes(el.shadowRoot)) {
				if (visit(child, region, nearHint, nearLang)) hasBlockChild = true;
			}
		}

		const shallowBlock = isShallowBlock(el, cs);
		// §2.4 透明穿透：display:contents 不產生盒 → 標透明，第二遍就地展開子節點當父的子節點重判。
		// FORCE_BLOCK 白名單與 role=button 一律贏（§2.2 / §P4 KO-5）：isShallowBlock 已為 true 就不透明，
		// 該元素照常當 block flush 邊界，其子代仍各自成段——差別只在容器內的裸 inline 不與容器外的相鄰
		// inline 併段，屬保守側，不必為此在集合規則上再開特例。
		const transparent = !shallowBlock && !!cs && isTransparentDisplay(cs.display);
		// forceBlock 上傳：自身 block，或含 block 子（混排）→ 走 block flush 分支。
		// 透明元素回傳的是「子代有沒有 block」——穿透後那些 block 就是父的直接子代，訊號照樣要上傳，
		// 父才會走混排 flush 分支（§2.5）。
		const isBlock = shallowBlock || hasBlockChild;
		labels.set(node, {
			disp, cs, isBlock, hasBlockDescendant: hasBlockChild, transparent,
			lang: nearLang, region, regionHint: nearHint,
		});
		return isBlock;
	}

	visit(root, rootLandmark, rootHint, rootLang);
	return labels;
}

/** §2.2 shallow block 判斷（白名單先、computed 後）。 */
function isShallowBlock(el, cs) {
	if (FORCE_BLOCK_TAGS.has(el.tagName)) return true;
	// §P4 KO-5：role=button 強制視為 block flush 邊界（不受 computed display 影響），
	// 讓 <span role="button">…</span> 這類非天生 block 標籤也能取得自身 anchor。
	if (hasButtonRole(el)) return true;
	const d = cs ? cs.display : "";
	if (d === "none" || d === "") return false;
	return !isInlineDisplay(d);
}

/**
 * 第二遍：用 labels 組翻譯單位（consecutiveInline 累積、block 邊界 flush）。
 * @param {Node} root
 * @param {CollectContext} ctx
 * @param {{ walkId?: number }} [opts]
 * @returns {Segment[]}
 */
function collectSegments(root, ctx, opts = {}) {
	const labels = walkAndLabel(root, ctx);
	const walkId = opts.walkId ?? 0;
	/** @type {Segment[]} */
	const segments = [];
	let order = 0;

	function labelOf(node) {
		return labels.get(node) || classifyLabel(node, ctx);
	}
	function classifyLabel(node, c) {
		const { disp, cs } = classifyNode(node, c);
		const isBlock = node.nodeType === NODE_ELEMENT && disp === "WALK"
			&& isShallowBlock(/** @type {Element} */ (node), cs);
		const transparent = !isBlock && node.nodeType === NODE_ELEMENT && disp === "WALK"
			&& !!cs && isTransparentDisplay(cs.display);
		// 未知子代資訊時保守視為「有 block 子」，防禦路徑不誤判為 button-class（§P4）。
		return { disp, cs, isBlock, hasBlockDescendant: true, transparent, lang: null, region: null, regionHint: null };
	}
	/**
	 * §2.4 透明穿透：`display:contents` 元素不產生盒，走訪時就地以其子節點取代自身（可巢狀）。
	 * 攤平發生在組段之前，所以容器內外的 inline 會併進同一段、容器不再是 flush 邊界，段的
	 * anchor.block 也永遠落在真正有盒的祖先上（無盒元素當 anchor 會讓譯文插到錯位置、
	 * 且 getBoundingClientRect 全零會被排程誤判成「正在視窗內」）。
	 * 回傳 [節點, label] 對，省掉呼叫端重查一次 label。
	 * @param {Node} node
	 * @returns {Generator<[Node, NodeLabel]>}
	 */
	function* effectiveChildren(node) {
		for (const child of childNodes(node)) {
			const label = labelOf(child);
			if (label.transparent) {
				yield* effectiveChildren(child);
				continue;
			}
			yield [child, label];
		}
	}
	/**
	 * §6.5 段 region：landmark 由第一遍 walk stack 增量取得；無 landmark 時 flush 點三訊號評分。
	 * @param {Node} blockNode
	 * @returns {RegionValue}
	 */
	function regionOfBlock(blockNode) {
		if (!blockNode || blockNode.nodeType !== NODE_ELEMENT) return Region.MAIN;
		const el = /** @type {Element} */ (blockNode);
		const label = labels.get(blockNode);
		if (label && label.region) return label.region;
		if (label) return heuristicRegion(el, label.regionHint);
		return classifyRegion(el); // 不在 labels（防禦路徑）→ 完整 walk-up cascade
	}

	/**
	 * §P4 KO-5 完整判準：標籤／role 命中 + 無 block 子（含自身、含各深度子代）+ 段落原文 ≤20 字 +
	 * 只有純文字子代（防原地換字用 textContent 整個覆寫時，連帶砍掉 icon 等非文字元素子節點）。
	 * @param {Node} blockNode
	 * @param {string} source  已 normalize 的段落原文（此段的翻譯來源文字）
	 * @returns {boolean}
	 */
	function isButtonClassCandidate(blockNode, source) {
		if (!blockNode || blockNode.nodeType !== NODE_ELEMENT) return false;
		if (!isButtonClassElement(/** @type {Element} */ (blockNode))) return false;
		if (source.length > BUTTON_CLASS_MAX_CHARS) return false;
		if (!hasOnlyTextChildren(/** @type {Element} */ (blockNode))) return false;
		const label = labels.get(blockNode);
		const hasBlockDescendant = label ? label.hasBlockDescendant : true; // 未知時保守判有
		return !hasBlockDescendant;
	}

	/**
	 * §9.2 插回模式決策——`insertMode` 是 replace 的**唯一**擴充點，兩條觸發軸走同一條 render 分支：
	 * - ①**段的種類**：button-class 窄判準命中（§P4 KO-5/6/7；並列插回會破按鈕排版）。
	 * - ②**語言對**：簡中來源 → 繁中目標（§3.6；簡繁字面幾乎相同，並排只是重複且難看）。
	 *
	 * 兩軸共用一組**結構安全前提**：只有純文字子代。原地換字用 `textContent` 整個覆寫、會連帶
	 * 砍掉 icon／inline 標記且無法還原，不安全者一律退回 `after-segment`——並列 wrapper 只加
	 * sibling、不動原文，天生安全。①軸的這道閘在 `isButtonClassCandidate` 內（窄判準的一部分），
	 * ②軸在本函式補上。
	 *
	 * **兩軸不共用**的是①軸的 `BUTTON_CLASS_MAX_CHARS` 長度閘——那是按鈕排版的約束、不是語言
	 * 的約束。為免②軸把①軸刻意退回的長按鈕撿走，本函式對所有 button-class 元素直接退回。
	 * @param {Node} blockNode
	 * @param {string} source        已 normalize 的段落原文（②軸的 script 安全閘要用）
	 * @param {boolean} buttonClass  已算好的 §P4 窄判準結果（其內部已含結構安全前提）
	 * @returns {InsertMode}
	 */
	function decideInsertMode(blockNode, source, buttonClass) {
		if (buttonClass) return "replace";
		if (!blockNode || blockNode.nodeType !== NODE_ELEMENT) return "after-segment";
		const el = /** @type {Element} */ (blockNode);
		// ①軸的元素沒通過窄判準＝刻意退回（太長／有 block 子／有元素子代），②軸不得從旁邊撿走
		// ——否則 21 字的按鈕在簡中頁會繞過 ≤20 字閘，換字照樣撐破按鈕排版。
		if (isButtonClassElement(el)) return "after-segment";
		// 文件／頁面根不就地取代：覆寫 <body> 的 textContent、或把整段原文寫成 <body title>
		// 都不是「段」層級該做的事。
		if (el.tagName === "BODY" || el.tagName === "HTML") return "after-segment";
		if (!isTraditionalChineseTarget(ctx.targetLang)) return "after-segment";
		const label = labels.get(blockNode);
		const lang = label ? label.lang : effectiveLangOf(el); // 未進 labels 才走防禦路徑
		if (!isSimplifiedChinese(lang)) return "after-segment";
		// **安全閘**：lang 常來自頁面級回退（`<html lang="zh-CN">`），簡中站內未標 lang 的
		// 英文留言區、日文引用段都會落在同一個 lang 底下。就地取代是破壞性的（原文從頁面
		// 消失、只剩 data 屬性），而「簡繁字面幾乎相同所以不必並排」的理由對這些段完全不成立。
		// 故再要求段自身的文字真的是漢字且無假名／諺文（沿用 §4.9 同一組 script 判準）。
		// 這**不是**依內容偵測語言那一層：它只會縮小 replace 的範圍、判不出來一律退回並列。
		if (!RE_HAS_HAN.test(source) || RE_HAS_KANA.test(source) || RE_HAS_HANGUL.test(source)) {
			return "after-segment";
		}
		return hasOnlyTextChildren(el) ? "replace" : "after-segment";
	}

	function collect(node) {
		/** @type {Node[]} */
		let buffer = [];
		const flushHere = () => {
			if (buffer.length) makeSegmentFromBuffer(buffer, node);
			buffer = [];
		};
		for (const [child, label] of effectiveChildren(node)) {
			if (child.nodeType === NODE_COMMENT || child.nodeType === NODE_PI) continue; // G5
			const { disp, isBlock } = label;
			if (disp === "SKIP_SUBTREE") continue; // 不切段：跳過不可見/無關子樹，buffer 續接
			if (child.nodeType === NODE_ELEMENT && /** @type {Element} */ (child).tagName === "BR") {
				buffer.push(child); // §6.2 BR→\n（extractText 處理）
				continue;
			}
			if (disp === "OPAQUE_INLINE") { buffer.push(child); continue; }
			if (!isBlock) { buffer.push(child); continue; } // inline / text → 累積
			// block → 先 flush 既有 buffer，再遞迴
			flushHere();
			collect(child);
		}
		flushHere();
	}

	function makeSegmentFromBuffer(buf, blockNode) {
		const { text, spans } = extractText(buf);
		const source = normalizeSource(text);
		if (source === "") return; // §6 / C2：純空白間隔不產段（連 skipped 都不建）
		const wt = worthTranslating(source, { pageLangIsZh: ctx.pageLangIsZh });
		const id = makeId(walkId, order);
		const region = regionOfBlock(blockNode);
		if (!wt.worth) {
			segments.push({
				id, order, region, source, anchor: makeAnchor(buf, blockNode),
				state: SegmentState.SKIPPED, meta: { skipReason: wt.reason, charCount: source.length },
			});
			order++;
			return;
		}
		// §9.2：插回模式在採集期決定（render 只認 anchor.insertMode、不再各自判斷觸發條件）。
		const buttonClass = isButtonClassCandidate(blockNode, source);
		const insertMode = decideInsertMode(blockNode, source, buttonClass);
		/** @type {Segment} */
		const seg = {
			id, order, region, source,
			anchor: makeAnchor(buf, blockNode, insertMode), state: SegmentState.PENDING,
		};
		// §P4：button-class 是「段的種類」分類，保留供觀測／後續規則用；插回行為看 insertMode。
		if (buttonClass) seg.kind = "button";
		// replaceSnapshot 存採集當下「未過濾」的原始 textContent（非 source——source 已被 extractText
		// 過濾掉 SKIP_SUBTREE 子代／ruby 注音等）：插回時只需拿它與插回當下的 textContent 做同一
		// property 兩次讀值的字面比對，不必重放 collect() 的過濾規則、不會有兩套還原邏輯彼此漂移的風險。
		const replaceMode = insertMode === "replace";
		if (spans.length || replaceMode) {
			seg.meta = {};
			if (spans.length) { seg.meta.protectedSpans = spans; seg.meta.charCount = source.length; }
			if (replaceMode) seg.meta.replaceSnapshot = blockNode.textContent || "";
		}
		segments.push(seg);
		order++;
	}

	// root 自身的處置也算數：`walkAndLabel` 會分類 root，落 SKIP_SUBTREE / OPAQUE_INLINE 就整棵
	// 不採。少了這道閘，`collect` 直接走 `effectiveChildren(root)`，而子代根本沒進 `labels`
	// （visit 在 SKIP_SUBTREE root 即 return），於是全落 `classifyLabel` 防禦路徑被重判成 WALK
	// ——root 的 `translate="no"` / `hidden` / `aria-hidden` / `contenteditable` / `display:none`
	// 被靜默吃掉。生產路徑 root 恆為 `<body>`（且 BODY 在 §3.5 降級集合裡）故現況不變，
	// 但以子樹為 root 呼叫（動態重採）時這是必要的。Document / DocumentFragment 由 walkAndLabel
	// 的容器分支標成 WALK，故一併通過此閘。
	if (labelOf(root).disp === "WALK") collect(root);
	return segments;
}

/** §8.1 id = "k" + base36(walkId) + "-" + base36(order)。 */
function makeId(walkId, order) {
	return "k" + (walkId >>> 0).toString(36) + "-" + (order >>> 0).toString(36);
}

/**
 * §6.4 / §9.2 anchor 載體：block = 正在收的 block 容器（collect frame 透傳，
 * 比事後 closestBlock(段末節點) 準——巢狀 inline 的段末是 inline 父，會落錯位）；
 * refNode 指段末節點（re-query / v2 替換用）；insertMode 是 render 的唯一分派鍵（§9.2）。
 * @param {Node[]} buf
 * @param {Node} blockNode
 * @param {InsertMode} [insertMode]
 */
function makeAnchor(buf, blockNode, insertMode = "after-segment") {
	return { block: blockNode || null, insertMode, refNode: buf[buf.length - 1] };
}

// ============================================================================
// §6.2 extractText 特判（br / ruby）+ 記 code/time protectedSpans
// ============================================================================

/**
 * @param {Node[]} buf
 * @returns {{ text: string, spans: ProtectedSpan[] }}
 */
function extractText(buf) {
	let text = "";
	/** @type {ProtectedSpan[]} */
	const spans = [];
	for (const node of buf) {
		text = appendNode(node, text, spans);
	}
	return { text, spans };
}

function appendNode(node, text, spans) {
	if (node.nodeType === NODE_TEXT) return text + (node.nodeValue || "");
	if (node.nodeType !== NODE_ELEMENT) return text;
	const el = /** @type {Element} */ (node);
	const tag = el.tagName;
	if (tag === "BR") return text + "\n";                 // §6.2-1
	if (tag === "RT" || tag === "RP") return text;        // §6.2-2 ruby 只取 base
	if (OPAQUE_INLINE_TAGS.has(tag)) {                    // code/time 原子 + 記 protectedSpan
		const piece = el.textContent || "";
		const start = text.length;
		text += piece;
		spans.push({ start, end: text.length, kind: tag.toLowerCase() });
		return text;
	}
	// 其餘 inline 元素：遞迴子節點（ruby base、巢狀 inline）。`display:contents` 容器不會整個進
	// buffer（走訪層已就地攤平），巢狀在 buffer 內某個 inline 底下時由這條遞迴取到同樣的文字。
	for (const child of childNodes(el)) {
		text = appendNode(child, text, spans);
	}
	return text;
}

/** 空白正規化但保 \n（§11.3）：折疊空白為單一空格、保留換行、trim 兩端。 */
function normalizeSource(text) {
	return text
		.replace(/[^\S\n]+/gu, " ")  // 非換行空白折疊成單空格
		.replace(/ *\n */gu, "\n")    // 換行兩側空白吃掉
		.replace(/\n{2,}/gu, "\n")    // 多換行折疊
		.trim();
}

// ============================================================================
// §7.1 並列插回 render 層（採集之後的獨立 pass；§8 讀寫分離：採集期不寫 DOM）
// ============================================================================

/**
 * 把帶譯文的 segment 並列插回 DOM：對每個 `drafted` 且有譯文的 segment，
 * 在其 `anchor.block` 之後（`block.after`）插一個雙語譯文 wrapper（§7.1）。
 *
 * wrapper 帶 `data-koine-id` + `koine-translated` class——再次採集時 classifyNode [1]
 * 先擋自家標記、整棵跳過，故插回不會被自己重採（§7.1 (c) 自吞防護）。
 * 只新增 sibling、不動原文節點（§7.1 (b)）。
 *
 * §9.2 例外：`anchor.insertMode === "replace"` 的段改走**原地換字**——不建 wrapper，直接覆寫
 * `block.textContent`，原文存 `title` 與 `data-koine-original`，並以 `data-koine-translated`
 * 當防自吞標記（該標記消失即視為未譯、下次採集會重新產生待譯段）。
 *
 * **本分支是 replace 的唯一實作**：觸發條件（§P4 button-class／簡→繁語言對）全在採集期收斂成
 * `insertMode`，render 只看這一個鍵——兩條軸不各做一套、行為不會漂移。
 *
 * @param {Segment[]} segments
 * @param {{ tag?: string }} [opts]   tag 預設 `div`（M1 固定 block；tag-mirror 留後續；replace 段不適用）
 * @returns {Element[]} 已插入的 wrapper 或原地換字的元素（依處理序）
 */
function insertTranslations(segments, opts = {}) {
	const tag = opts.tag || "div";
	/** @type {Element[]} */
	const inserted = [];
	for (const seg of segments) {
		if (seg.state !== SegmentState.DRAFTED) continue; // 只消費 drafted（pending / skipped 跳過）
		const text = seg.refined ?? seg.draft;            // §9.1 並列取值 refined ?? draft
		if (text == null || text === "") continue;        // 無譯文 / 譯文=空 不插
		const block = seg.anchor && seg.anchor.block;
		if (!block) continue;

		// §9.2 replace：原地換字，不加 wrapper（§P4 KO-5/6/7 與簡→繁共用本分支）。
		if ((seg.anchor.insertMode || "after-segment") === "replace") {
			if (typeof block.setAttribute !== "function") continue;
			// 防呆：採集與插回之間是非同步的（IntersectionObserver lazy 進場 + bridge 往返），
			// 若元素在這段期間被頁面自身 JS 改動（如登入/登出切換文字），代表譯文已對不上目前狀態——
			// 放棄本次覆寫，保留元素目前的真實內容，不標記 data-koine-translated，下次採集會依
			// 當下內容重新產生待譯段。
			//
			// 比對法：拿「插回當下」的 textContent 對比「採集當下」存的 replaceSnapshot——兩次讀同一個
			// property，不重放 collect() 的過濾/擷取規則（曾踩：改用 extractText 版還原比對，
			// 仍會漏掉 aria-hidden / sr-only / SVG <title> 等 SKIP_SUBTREE 子代文字，導致這些完全
			// 未變動的按鈕被誤判 drift 而永遠翻不了）。缺快照（防禦路徑）一律視為不可信、放棄覆寫。
			const snapshot = seg.meta && typeof seg.meta.replaceSnapshot === "string" ? seg.meta.replaceSnapshot : null;
			if (snapshot === null || block.textContent !== snapshot) continue;
			// textContent 字串相等不保證結構沒變：插入一個不含文字的元素子代（如 icon svg）不會讓
			// textContent 出現差異，但仍會被緊接著的 textContent 覆寫整個砍掉。插回前必須用採集時
			// 同一套「只有純文字子代」判準重新核一次目前的即時結構，結構已變同樣視為 drift、放棄覆寫。
			if (!hasOnlyTextChildren(/** @type {Element} */ (block))) continue;
			// KO-7 原文存 data 屬性（純資料、無 AT 影響）。這裡刻意存**未過濾的 snapshot**、不是
			// seg.source——它是還原用的逐字副本，連原始空白一起留住才還原得回去。
			block.setAttribute("data-koine-original", snapshot);
			// KO-6 原文存 title tooltip，但兩個前提：①元素本來沒有 `title`——覆寫會抹掉站台自己的
			// 提示且無還原路徑；②原文短到適合當 tooltip（見 REPLACE_TITLE_MAX_CHARS）。
			// 不符就只留 `data-koine-original`。
			//
			// **長度與內容都取 `seg.source`、不取 `snapshot`**：snapshot 是原始 textContent，含
			// HTML 縮排；而①軸的 BUTTON_CLASS_MAX_CHARS 卡的是 normalize 後的 source。兩者比錯
			// 邊，`<button>\n  确认提交\n</button>` 這種多行排版（真實 HTML 的主流寫法）會算成
			// 24 字而靜默失去 title，同一顆按鈕寫成一行就有——KO-6 的 tooltip 會在真實頁面上
			// 大面積失效。title 顯示的也該是使用者看得懂的那一版，不是帶縮排的原字串。
			if (!block.hasAttribute("title") && seg.source.length <= REPLACE_TITLE_MAX_CHARS) {
				block.setAttribute("title", seg.source);
			}
			block.textContent = text;                               // KO-6 直接換
			block.setAttribute("data-koine-translated", "");        // KO-7 防自吞標記（消失即視為未譯）
			inserted.push(block);
			continue;
		}

		if (typeof block.after !== "function") continue;
		const doc = block.ownerDocument;
		if (!doc) continue;
		const wrapper = doc.createElement(tag);
		wrapper.setAttribute("data-koine-id", seg.id);
		wrapper.className = "koine-translated";
		wrapper.textContent = text;
		block.after(wrapper);
		inserted.push(wrapper);
	}
	return inserted;
}

// ============================================================================
// §10 進場排程（P3 tiered dispatch + priorityGate；lazy 進場才觸發取譯）
// ============================================================================

/** §10.1 eager 預算：文件序前 N 個 MAIN pending 段載入即發（chrome 永不 eager）。 */
const EAGER_MAIN_BUDGET = 10;
/** §10.1 tiered IO rootMargin：main 讀前預取、chrome 近了才排。 */
const MAIN_ROOT_MARGIN = "1200px";
const CHROME_ROOT_MARGIN = "400px";
/** §10.2 distanceBucket 桶寬（px）：微滾動不重洗牌。 */
const DISTANCE_BUCKET_PX = 300;
/** §10.2 滾動 re-sort throttle（ms）：≈ dispatch cadence（daemon ~3 段/秒、更快是白工）。 */
const RESORT_THROTTLE_MS = 200;

/**
 * 瀏覽器預設 observer 工廠：包 `IntersectionObserver`。
 * 跑道 A（linkedom）無此 API，故 body 內才 new——測試一律由 opts 注入 stub、不會走到這。
 * @param {IntersectionObserverCallback} cb
 * @param {IntersectionObserverInit} options
 * @returns {IntersectionObserver}
 */
function defaultMakeObserver(cb, options) {
	return new IntersectionObserver(cb, options);
}

/**
 * 瀏覽器預設段距視窗量測：block 距視窗邊緣的 px（0 = 相交）。
 * 只在 priorityGate 的 throttled re-bucket 批次讀呼叫、不進採集/分類路徑（§8 讀寫分離不破）。
 * 跑道 A（linkedom）由 opts.measure 注入 stub。
 * @param {Element} block
 * @returns {number}
 */
function defaultMeasure(block) {
	if (!block || typeof block.getBoundingClientRect !== "function") return 0;
	const rect = block.getBoundingClientRect();
	const vh = typeof innerHeight === "number" ? innerHeight : 0;
	if (rect.bottom < 0) return -rect.bottom;  // 已滾過（視窗上方）
	if (rect.top > vh) return rect.top - vh;    // 未到（視窗下方）
	return 0;                                   // 相交
}

/**
 * §10 排程：對 `pending` segment 做 tiered dispatch + priorityGate（P3）。
 *
 * tiered dispatch（§10.1）——所有觸發餵進同一個 priorityGate：
 * - main eager：文件序前 `eagerBudget`（預設 EAGER_MAIN_BUDGET=10）個 MAIN 段**載入即發**、不等 IO。
 * - main lazy：IO rootMargin 1200px（讀前預取）；chrome lazy：IO rootMargin 400px（近了才排）。
 * - 進場即 unobserve（一次性）；已入列段不重複入列；全段已 eager 的 block 免觀察。
 *
 * priorityGate（§10.2）——FIFO → min-first 優先佇列：
 * - sortKey = (viewportBand, regionRank, distanceBucket@300px, order)，lexicographic、dequeue 最小。
 * - 滾動 re-sort：scroll → throttle ~200ms trailing → rAF → 只 re-bucket 未 dispatch 段。
 * - 併發閘門 maxInFlight（預設 6）不變（§10 D3，on-device 硬約束；真閘門是 daemon ~3 段/秒）。
 *
 * 只做「排程 + 閘門 + 呼鉤子」、不碰 bridge——`onEnter` 由呼叫端注入（C 接 native bridge、
 * 測試塞 fake）。只排 `pending` 段（skipped / drafted / 無 block 跳過）；每個 block 只
 * observe 一次（多段共用同一 block 時進場一併入列）。
 *
 * @param {Segment[]} segments
 * @param {{
 *   onEnter: (seg: Segment) => (void | Promise<void>),
 *   maxInFlight?: number,
 *   makeObserver?: (cb: Function, options: object) => { observe: Function, unobserve: Function, disconnect?: Function },
 *   measure?: (block: Element) => number,
 *   eagerBudget?: number,
 *   rootMargin?: string,        // 覆寫兩層（相容舊單層呼叫）
 *   mainRootMargin?: string,
 *   chromeRootMargin?: string,
 *   threshold?: number,
 * }} opts
 * @returns {{ observer: object|null, observers: object[], resort: () => void, disconnect: () => void }}
 *   disconnect() 停 observer + 清未 dispatch 的排隊段；resort() 手動觸發 re-bucket（測試 / throttle 目標）
 */
function observeSegments(segments, opts) {
	const onEnter = opts.onEnter;
	if (typeof onEnter !== "function") {
		throw new TypeError("observeSegments: opts.onEnter 必須為 function（取譯觸發鉤子、必填）");
	}
	const maxInFlight = opts.maxInFlight ?? 6;
	const makeObserver = opts.makeObserver || defaultMakeObserver;
	const measure = opts.measure || defaultMeasure;
	const eagerBudget = opts.eagerBudget ?? EAGER_MAIN_BUDGET;

	// block → 該 block 綁的 pending 段（多段共用同一 block 時進場一併入列）。
	/** @type {Map<Element, Segment[]>} */
	const blockToSegs = new Map();
	/** @type {Segment[]} */
	const pendings = [];
	for (const seg of segments) {
		if (seg.state !== SegmentState.PENDING) continue; // 只排待譯段
		const block = seg.anchor && seg.anchor.block;
		if (!block) continue;
		pendings.push(seg);
		let arr = blockToSegs.get(block);
		if (!arr) { arr = []; blockToSegs.set(block, arr); }
		arr.push(seg);
	}

	// ---- priorityGate（§10.2）----------------------------------------------
	/** @type {Segment[]} */
	const queued = [];                 // 已觸發、未 dispatch 的段（min-first）
	const enqueuedSet = new WeakSet(); // 防重複入列（eager 與 IO 觸發可能重疊）
	/** @type {Map<Segment, number[]>} */
	const keys = new Map();            // seg → sortKey tuple（re-bucket 時全量 re-key）
	let dirty = false;                 // 佇列需重排（入列 / re-key 後 lazy sort）
	let inFlight = 0;
	let disconnected = false;

	/** sortKey = (viewportBand, regionRank, distanceBucket, order)（§10.2、dequeue 最小）。 */
	function keyOf(seg) {
		const d = Number(measure(seg.anchor && seg.anchor.block)) || 0;
		const band = d <= 0 ? 0 : 1;                                  // 0 = 與視窗相交、壓過一切
		const rank = seg.region === Region.CHROME ? 1 : 0;            // offscreen 時 region 壓過 distance
		const bucket = d <= 0 ? 0 : Math.floor(d / DISTANCE_BUCKET_PX);
		return [band, rank, bucket, seg.order || 0];
	}
	function compareSegs(a, b) {
		const ka = keys.get(a);
		const kb = keys.get(b);
		for (let i = 0; i < 4; i++) {
			if (ka[i] !== kb[i]) return ka[i] - kb[i];
		}
		return 0;
	}
	function enqueue(seg) {
		if (enqueuedSet.has(seg)) return;
		enqueuedSet.add(seg);
		keys.set(seg, keyOf(seg));
		queued.push(seg);
		dirty = true;
	}
	function dequeueMin() {
		if (dirty) {
			queued.sort(compareSegs); // 集合小（pending 遞縮）、sorted-array 與 heap 等效（§10.2）
			dirty = false;
		}
		return queued.shift();
	}
	/** re-bucket：只 re-key 未 dispatch 段（量測批次讀、throttled）。 */
	function resort() {
		if (disconnected || queued.length === 0) return;
		for (const seg of queued) keys.set(seg, keyOf(seg));
		dirty = true;
	}
	function pump() {
		while (!disconnected && inFlight < maxInFlight && queued.length > 0) {
			const seg = dequeueMin();
			inFlight++;
			// 包進 promise 鏈：吸收 onEnter 的同步 throw / 回傳 Promise，settle 後補位。
			Promise.resolve().then(() => onEnter(seg)).then(settle, settle);
		}
	}
	function settle() {
		inFlight--;
		pump();
	}

	// ---- 滾動 re-sort throttle（§10.2：scroll → ~200ms trailing → rAF → resort）----
	/** @type {any} */
	let resortTimer = null;
	const raf = typeof requestAnimationFrame === "function"
		? requestAnimationFrame
		: /** @param {() => void} fn */ (fn) => { fn(); return 0; };
	function scheduleResort() {
		if (disconnected || resortTimer != null) return; // throttle：窗內合併、窗尾（trailing）必觸發
		resortTimer = setTimeout(() => {
			resortTimer = null;
			raf(() => resort());
		}, RESORT_THROTTLE_MS);
	}
	const scrollTarget = typeof window !== "undefined" ? window : null;
	const onScroll = scrollTarget ? () => scheduleResort() : null;
	if (scrollTarget && onScroll) scrollTarget.addEventListener("scroll", onScroll, { passive: true });

	// ---- tiered dispatch（§10.1）--------------------------------------------
	// main eager：文件序前 N 個 MAIN pending 段、載入即發（不等 IO callback）。
	if (eagerBudget > 0) {
		const mains = pendings
			.filter((s) => s.region !== Region.CHROME) // region 缺省折進 MAIN（§6.5 非對稱預設）
			.sort((a, b) => (a.order || 0) - (b.order || 0));
		const n = Math.min(eagerBudget, mains.length);
		for (let i = 0; i < n; i++) enqueue(mains[i]);
	}

	// lazy：兩層 IO（main / chrome 各一、rootMargin 不同），全段已 eager 的 block 免觀察。
	const threshold = opts.threshold ?? 0.1;
	const tierMargins = {
		main: opts.rootMargin || opts.mainRootMargin || MAIN_ROOT_MARGIN,
		chrome: opts.rootMargin || opts.chromeRootMargin || CHROME_ROOT_MARGIN,
	};
	/** @type {{ main: Element[], chrome: Element[] }} */
	const tierBlocks = { main: [], chrome: [] };
	for (const [block, segs] of blockToSegs) {
		if (segs.every((s) => enqueuedSet.has(s))) continue; // 全 eager → 免觀察
		tierBlocks[segs[0].region === Region.CHROME ? "chrome" : "main"].push(block);
	}
	const ioCallback = (entries, obs) => {
		if (disconnected) return;
		let added = false;
		for (const entry of entries) {
			if (!entry.isIntersecting) continue;
			obs.unobserve(entry.target); // 進場即 unobserve：一次性、不重複觸發
			const segs = blockToSegs.get(entry.target);
			if (!segs) continue;
			for (const seg of segs) {
				if (enqueuedSet.has(seg)) continue;
				enqueue(seg);
				added = true;
			}
		}
		if (added) pump();
	};
	/** @type {object[]} */
	const observers = [];
	for (const tier of /** @type {const} */ (["main", "chrome"])) {
		if (!tierBlocks[tier].length) continue;
		const obs = makeObserver(ioCallback, { root: null, rootMargin: tierMargins[tier], threshold });
		observers.push(obs);
		for (const block of tierBlocks[tier]) obs.observe(block);
	}

	pump(); // eager 段即刻 dispatch（載入即發）

	return {
		observer: observers[0] || null,
		observers,
		resort, // 手動 re-bucket（測試用；throttle 路徑的目標函式）
		// disconnect：停 observer + 清空尚未 dispatch 的排隊段（已 in-flight 的 onEnter 無法取消）。
		disconnect() {
			disconnected = true;
			queued.length = 0;
			keys.clear();
			if (resortTimer != null) { clearTimeout(resortTimer); resortTimer = null; }
			if (scrollTarget && onScroll) scrollTarget.removeEventListener("scroll", onScroll);
			for (const obs of observers) {
				if (typeof obs.disconnect === "function") obs.disconnect();
			}
		},
	};
}

// ============================================================================
// §9.4 bridge 串接：onEnter 取譯 → 狀態機 pending→drafting→drafted/failed → 插回
// ============================================================================

/**
 * 單段取譯：送 { id, source, from, to } 過 bridge → 回 { id, text } / { id, error } →
 * 落狀態機並在成功時插回。進場觀察的 onEnter 掛此函式（B 的鉤子由此接真 send）。
 * `send` 由呼叫端注入（瀏覽器走 background sendMessage、測試塞 fake）、回 Promise。
 * M1 不 retry（failed 即終態、記 meta.failReason）。
 *
 * @param {Segment} seg
 * @param {(req: { id: string, source: string, from?: string, to?: string }) => Promise<any>} send
 * @param {{ from?: string, to?: string, insertOpts?: object }} [opts]
 * @returns {Promise<void>}
 */
async function translateSegment(seg, send, opts = {}) {
	if (seg.state !== SegmentState.PENDING) return; // 只譯 pending
	seg.state = SegmentState.DRAFTING;
	let res;
	try {
		res = await send({ id: seg.id, source: seg.source, from: opts.from, to: opts.to });
	} catch (e) {
		seg.state = SegmentState.FAILED;
		seg.meta = Object.assign({}, seg.meta, { failReason: String(e) });
		return;
	}
	if (!res || res.error != null || typeof res.text !== "string") {
		seg.state = SegmentState.FAILED;
		seg.meta = Object.assign({}, seg.meta, {
			failReason: (res && res.error != null) ? String(res.error) : "no-text",
		});
		return;
	}
	// §9.1：res.text === "" = 譯文＝原文、不顯示（有效終態、非失敗）；insertTranslations 自會跳過。
	seg.draft = res.text;
	seg.state = SegmentState.DRAFTED;
	// render 獨立 pass：insert 例外不回溯污染已定案的 drafted（§7.1 讀寫分離、關注點分離）。
	insertTranslations([seg], opts.insertOpts);
}

/**
 * 組 native bridge 訊息（background 轉 sendNativeMessage）。抽成具名純函式供測試斷言線上形狀。
 * @param {{ id: string, source: string, from?: string, to?: string }} req
 * @returns {{ type: string, id: string, source: string, from?: string, to?: string }}
 */
function buildBridgeMessage(req) {
	return { type: "translate", id: req.id, source: req.source, from: req.from, to: req.to };
}

// ============================================================================
// 瀏覽器自動執行：採集 → 進場觀察 → 取譯 → 插回（M1 完整管線）
// ============================================================================

function main() {
	console.log("[雅言] content script loaded");
	const htmlLang = document.documentElement.getAttribute("lang");
	// 無 lang 屬性才取樣（避免無謂 textContent 讀取）；純讀不觸發 reflow。
	const sample = htmlLang ? "" : (document.body?.textContent || "").slice(0, 500);
	const ctx = makeContext({ pageLangIsZh: detectPageLangIsZh(htmlLang, sample) });
	const segments = collectSegments(document.body, ctx, { walkId: 1 });
	if (!segments.length) return;
	const from = htmlLang || undefined;
	const send = (req) => browser.runtime.sendMessage(buildBridgeMessage(req));
	observeSegments(segments, {
		onEnter: (seg) => translateSegment(seg, send, { from, to: ctx.targetLang }),
	});
}

if (typeof document !== "undefined" && typeof browser !== "undefined") {
	main();
}

// ============================================================================
// 測試取用尾巴（browser classic script：module 不存在、globalThis 沙盒安全）
// ============================================================================

const __koineExports = {
	FORCE_BLOCK_TAGS, SKIP_SUBTREE_TAGS, OPAQUE_INLINE_TAGS, SegmentState,
	Region, EAGER_MAIN_BUDGET, BUTTON_CLASS_MAX_CHARS,
	isInlineDisplay, isTransparentDisplay, hasText, worthTranslating, isFilenameOnly, detectPageLangIsZh,
	isAlreadyTargetLang, hasButtonRole, isButtonClassElement,
	isTraditionalChineseTarget, isSimplifiedChinese, ownLangOf, effectiveLangOf,
	REPLACE_TITLE_MAX_CHARS,
	makeContext, classifyNode, isShallowBlock, classifyRegion, heuristicRegion,
	walkAndLabel, collectSegments, extractText, normalizeSource, makeId,
	insertTranslations, observeSegments, translateSegment, buildBridgeMessage,
};

if (typeof module !== "undefined" && module.exports) {
	module.exports = __koineExports;
}
if (typeof globalThis !== "undefined") {
	globalThis.__koine__ = __koineExports;
}
