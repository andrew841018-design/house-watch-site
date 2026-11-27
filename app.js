// house_watch 網頁（WP8b）：地圖、清單、條件編輯、資料新鮮度、比價。
//
// 安全規則（R2-01）：
// - 外來文字（社區名、路名、地址、格局、來源與錯誤代碼）一律用文字節點放進頁面，不組 HTML 字串；
//   也不把字串交給 Leaflet 的彈出視窗、提示框或屬性控制項（那些會把字串當 HTML）。
// - 資料只用 fetch 讀 JSON。外部連結由 deeplinks.js 依「來源＋編號」產生，
//   只允許白名單上的 https 主機，並加 rel="noopener noreferrer"。
// - 分享片段（#p=…）在啟動時第一件事就讀出並從網址列拿掉；內容不會原樣出現在畫面或錯誤訊息裡。
// - 個人條件只存在 localStorage（house-watch:profiles:v1）與分享片段，不送到任何地方。
//
// 這個檔也負責 test/selftest.html：在瀏覽器裡跑規則案例表（那一頁不載入地圖）。

import {
  BADGE_LABELS,
  NEAR_THRESHOLD_REASONS,
  PARKING_CHOICES,
  PROFILE_STORAGE_KEY,
  REASON_LABELS,
  RULE_CONSTANTS,
  comps,
  evaluate,
  freshness,
  listingBadges,
  nanCases,
  parseDate,
  parseProfiles,
  profileAreaKind,
  profilesToFragment,
  readFragment,
  runCases,
  serializeProfiles,
  taipeiDate,
  txBadges,
  unitPriceRange,
} from "./rules.js";
import {
  LINK_REL,
  hasSearchLinks,
  listingUrl,
  safeExternalUrl,
  search591Url,
  searchSinyiUrl,
  sourceLabel,
} from "./deeplinks.js";

// ---------------------------------------------------------------- DOM 小工具

const ALLOWED_ATTRS = new Set([
  "class",
  "id",
  "type",
  "title",
  "role",
  "tabindex",
  "for",
  "name",
  "value",
  "min",
  "max",
  "step",
  "inputmode",
  "placeholder",
  "readonly",
  "disabled",
  "checked",
  "selected",
  "hidden",
  "target",
  "rel",
  "lang",
  "autocomplete",
]);

/** 建立元素。屬性只收白名單；子節點的字串一律變成文字節點。 */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "text") node.textContent = String(value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("aria-") || ALLOWED_ATTRS.has(key)) {
      node.setAttribute(key, value === true ? "" : String(value));
    } else {
      throw new Error("el(): 不允許的屬性");
    }
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

/** 換掉節點的內容；null、undefined、false 會被略過（原生的 replaceChildren 會把它們變成文字）。 */
function fill(node, ...children) {
  node.replaceChildren();
  return append(node, children);
}

/** 加在節點最後面；略過規則同 fill()。 */
function put(node, ...children) {
  return append(node, children);
}

function byId(id) {
  return document.getElementById(id);
}

/** 外部連結：網址先過白名單；不通過就只顯示文字。 */
function externalLink(url, text, className) {
  const safe = safeExternalUrl(url);
  if (!safe) return el("span", { class: className, text });
  const link = el("a", { class: className, target: "_blank", rel: LINK_REL, text });
  link.href = safe;
  return link;
}

function button(text, onClick, attrs = {}) {
  const node = el("button", { type: "button", ...attrs, text });
  node.addEventListener("click", onClick);
  return node;
}

// ---------------------------------------------------------------- 顯示格式

const TAIPEI_OFFSET_MS = 8 * 3600 * 1000;

function timeText(ms) {
  if (ms === null || ms === undefined) return "—";
  return new Date(ms + TAIPEI_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");
}

function agoText(hours) {
  if (hours === null || hours === undefined) return "";
  if (hours < -0.25) return "（時間比現在還晚，電腦的時鐘可能不準）";
  if (hours < 1) return "不到 1 小時前";
  if (hours < 48) return `${Math.floor(hours)} 小時前`;
  return `${Math.floor(hours / 24)} 天前`;
}

const isNum = (value) => typeof value === "number" && Number.isFinite(value);
const isConflictValue = (value) => value === "conflict";

function wanText(yuan) {
  return (yuan / 10000).toLocaleString("zh-TW", { maximumFractionDigits: 1 });
}

function priceText(min, max) {
  if (!isNum(min)) return "價格不明";
  if (!isNum(max) || max === min) return `${wanText(min)} 萬`;
  return `${wanText(min)}–${wanText(max)} 萬`;
}

function pingFromCp(cp) {
  if (isConflictValue(cp)) return "各站不一";
  return isNum(cp) ? `${(cp / 100).toFixed(2)} 坪` : "坪數不明";
}

function pingFromCm2(cm2) {
  return isNum(cm2) ? `${((cm2 * 121) / 40000).toFixed(2)} 坪` : "坪數不明";
}

function floorName(floor) {
  return floor < 0 ? `B${-floor}` : `${floor}`;
}

function floorText(lo, hi, total) {
  if (isConflictValue(lo) || isConflictValue(hi)) return "樓層各站不一";
  const known = [lo, hi].filter(isNum);
  let text = "樓層不明";
  if (known.length === 2 && lo !== hi) text = `${floorName(lo)}–${floorName(hi)} 樓`;
  else if (known.length) text = `${floorName(known[0])} 樓`;
  if (isNum(total)) text += `／共 ${total} 樓`;
  return text;
}

const DAY_MS = 86400000;

function dateMs(value) {
  const date = parseDate(value);
  return date ? Date.UTC(date.y, date.m - 1, date.d) : null;
}

/** 屋齡（年，小數一位，只供顯示；判定一律用 rules.js 的日曆年規則）。 */
function ageText(lo, hi, refDate) {
  if (isConflictValue(lo) || isConflictValue(hi)) return "完工日各站不一";
  const ref = dateMs(refDate);
  const loMs = dateMs(lo);
  const hiMs = dateMs(hi);
  if (ref === null || (loMs === null && hiMs === null)) return "屋齡不明";
  const years = (ms) => Math.max(0, (ref - ms) / DAY_MS / 365.2425).toFixed(1);
  if (loMs !== null && hiMs !== null) {
    const a = years(hiMs);
    const b = years(loMs);
    return a === b ? `約 ${a} 年` : `約 ${a}–${b} 年`;
  }
  return loMs !== null ? `最多約 ${years(loMs)} 年` : `至少約 ${years(hiMs)} 年`;
}

const PARKING_LABELS = {
  ramp_flat: "坡道平面",
  ground_flat: "一樓平面",
  lift_flat: "升降平面",
  flat_unknown_access: "平面（坡道或升降不明）",
  mechanical: "機械",
  mixed_with_flat: "多個車位（含平面）",
  mixed_no_flat: "多個車位（無平面）",
  none: "無車位",
  unknown: "車位不明",
};

const PARKING_CHOICE_LABELS = {
  ramp_flat: "坡道平面",
  ground_flat: "一樓平面",
  mechanical: "機械車位",
  none: "沒有車位也可以",
};

const ELEVATOR_LABELS = { yes: "有電梯", no: "無電梯", inferred: "推定有電梯", unknown: "電梯不明" };

const PRECISION_LABELS = {
  site: "網站座標",
  door: "門牌",
  community: "社區定位",
  road: "只到路段",
  none: "定位不到",
};

const ERROR_LABELS = {
  blocked: "被網站擋下",
  rate_limited: "請求太頻繁，被網站限制",
  challenge: "遇到驗證頁",
  page_invalid: "頁面格式和預期不同",
  parse_rate_low: "解析成功率太低",
  count_short: "筆數比上次少一半以上",
  budget_exhausted: "請求上限用完",
  timeout: "逾時",
  http_5xx: "網站錯誤（5xx）",
  robots_changed: "robots.txt 有變動，等人確認",
  paused: "暫停中",
  tls_error: "憑證錯誤",
  doorindex_invalid: "門牌資料檢查失敗",
  lvr_invalid: "實價登錄資料檢查失敗",
  publish_failed: "發布失敗",
  push_rejected: "推送被拒",
};

const STATUS_LABELS = { match: "符合", pending: "待確認", fail: "不符" };

function labelOf(table, key, fallback) {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : fallback;
}

function parkingText(value) {
  if (isConflictValue(value)) return "車位各站不一";
  return labelOf(PARKING_LABELS, value, "車位不明");
}

function elevatorText(value) {
  if (isConflictValue(value)) return "電梯各站不一";
  return labelOf(ELEVATOR_LABELS, value, "電梯不明");
}

function txParkingText(spaces) {
  if (!Array.isArray(spaces)) return "車位不明";
  if (spaces.length === 0) return "無車位";
  return spaces.map((space) => labelOf(PARKING_LABELS, space && space.ptype, "車位不明")).join("＋");
}

function unitPriceText(up) {
  const range = unitPriceRange(up);
  if (!range) return "扣車位單價：算不出來";
  if (range.basis === "official") return `扣車位單價 ${range.mid.toFixed(2)} 萬／坪（官方拆價）`;
  return `扣車位單價 ${range.lo.toFixed(2)}–${range.hi.toFixed(2)} 萬／坪（估算）`;
}

// ---------------------------------------------------------------- 狀態

const COLORS = ["#2563eb", "#dc2626", "#059669", "#7c3aed", "#d97706", "#0891b2", "#be185d", "#4d7c0f"];
const NEUTRAL = "#64748b";
const NEUTRAL_DARK = "#334155";
const PAGE_SIZE = 200;

const state = {
  fixtures: false,
  meta: null,
  areaId: null,
  data: new Map(),
  profiles: [],
  profileSource: "none",
  notices: [],
  view: "listing",
  filter: "match",
  focus: "all",
  shown: PAGE_SIZE,
  selected: null,
  results: new Map(),
  today: taipeiDate(Date.now()),
  link: null,
  fitted: new Set(),
  bounds: null,
  pendingFit: false,
  autoFit: true,
};

let map = null;
const layers = {};

// ---------------------------------------------------------------- localStorage（每次存取都包 try/catch）

function storageGet() {
  try {
    return window.localStorage.getItem(PROFILE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storageSet(text) {
  try {
    window.localStorage.setItem(PROFILE_STORAGE_KEY, text);
    return true;
  } catch {
    return false;
  }
}

function storageRemove() {
  try {
    window.localStorage.removeItem(PROFILE_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 讀資料

class LoadError extends Error {}

/**
 * 網站上的路徑（data/…、geo/…，相對於網站根目錄）。
 * 開發用示意資料（網址帶 ?fixtures）放在 test/fixtures/；其中 data/ 改叫 sample_data/，
 * 因為 repo 的 .gitignore 會擋掉所有叫 data/ 的資料夾。
 */
function sitePath(path) {
  return state.fixtures ? `test/fixtures/${path.replace(/^data\//, "sample_data/")}` : path;
}

async function fetchJson(path, { noStore = false, version = null } = {}) {
  const url = sitePath(path) + (version ? `?v=${encodeURIComponent(version)}` : "");
  let response;
  try {
    response = await fetch(url, { cache: noStore ? "no-store" : "default", credentials: "same-origin" });
  } catch {
    throw new LoadError("network");
  }
  if (!response.ok) throw new LoadError("http");
  try {
    return await response.json();
  } catch {
    throw new LoadError("json");
  }
}

const BUILD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SITE_PATH = /^(?:data|geo)\/[a-z0-9_]+\.(?:json|geojson)$/;

function validMeta(meta) {
  return (
    meta &&
    typeof meta === "object" &&
    typeof meta.build_id === "string" &&
    BUILD_ID.test(meta.build_id) &&
    Array.isArray(meta.areas) &&
    meta.areas.every(
      (area) =>
        area &&
        typeof area.id === "string" &&
        typeof area.name === "string" &&
        Array.isArray(area.files) &&
        area.files.every((file) => typeof file === "string" && SITE_PATH.test(file)),
    )
  );
}

function areaMeta(areaId = state.areaId) {
  return state.meta ? state.meta.areas.find((area) => area.id === areaId) || null : null;
}

function areaFile(area, prefix) {
  return area.files.find((file) => file.startsWith(prefix)) || null;
}

async function loadArea(areaId) {
  if (state.data.has(areaId)) return state.data.get(areaId);
  const area = areaMeta(areaId);
  const version = state.meta.build_id;
  const listingsPath = areaFile(area, `data/listings_${areaId}.`) || areaFile(area, "data/listings_");
  const txPath = areaFile(area, `data/tx_${areaId}.`) || areaFile(area, "data/tx_");
  const geoPath = areaFile(area, "geo/");
  const [listingsFile, txFile, geo] = await Promise.all([
    listingsPath ? fetchJson(listingsPath, { version }) : null,
    txPath ? fetchJson(txPath, { version }) : null,
    geoPath ? fetchJson(geoPath, { version }).catch(() => null) : null,
  ]);
  for (const file of [listingsFile, txFile]) {
    if (file && (file.schema_version !== 1 || file.area !== areaId)) throw new LoadError("version");
  }
  const groups = listingsFile && Array.isArray(listingsFile.groups) ? listingsFile.groups : [];
  const txs = txFile && Array.isArray(txFile.tx) ? txFile.tx : [];
  const entry = {
    listings: groups.filter((g) => g && typeof g === "object").map((g) => ({ ...g, area: areaId })),
    tx: txs.filter((t) => t && typeof t === "object").map((t) => ({ ...t, area: areaId })),
    txAsOf: txFile && typeof txFile.as_of === "string" ? txFile.as_of : null,
    geo: geo && typeof geo === "object" && Array.isArray(geo.features) ? geo : null,
  };
  state.data.set(areaId, entry);
  return entry;
}

// ---------------------------------------------------------------- 條件

function areaProfiles() {
  return state.profiles.filter((profile) => profile.area === state.areaId);
}

function focusedProfiles() {
  const list = areaProfiles();
  return state.focus === "all" ? list : list.filter((profile) => profile.name === state.focus);
}

function profileColor(profile) {
  const index = state.profiles.indexOf(profile);
  return COLORS[(index < 0 ? 0 : index) % COLORS.length];
}

function computeResults() {
  state.results = new Map();
  const entry = state.data.get(state.areaId);
  if (!entry) return;
  const profiles = areaProfiles();
  for (const [kind, records] of [
    ["listing", entry.listings],
    ["tx", entry.tx],
  ]) {
    for (const rec of records) {
      state.results.set(
        rec,
        profiles.map((profile) => ({ profile, ...evaluate(kind, rec, profile, state.today) })),
      );
    }
  }
}

/** 一筆紀錄在目前聚焦的條件下的分類：best 是最好的狀態，matched／pending 是各自的條件。 */
function classify(rec) {
  const focusNames = new Set(focusedProfiles().map((profile) => profile.name));
  const list = (state.results.get(rec) || []).filter((item) => focusNames.has(item.profile.name));
  if (!list.length) return { best: "none", list, matched: [], pending: [] };
  const matched = list.filter((item) => item.status === "match");
  const pending = list.filter((item) => item.status === "pending");
  const best = matched.length ? "match" : pending.length ? "pending" : "fail";
  return { best, list, matched, pending };
}

function visibleRecords(kind) {
  const entry = state.data.get(state.areaId);
  if (!entry) return [];
  const records = kind === "listing" ? entry.listings : entry.tx;
  const hasProfiles = focusedProfiles().length > 0;
  return records.filter((rec) => {
    if (!hasProfiles || state.filter === "all") return true;
    return classify(rec).best === state.filter;
  });
}

function setProfiles(profiles, source) {
  state.profiles = profiles;
  state.profileSource = source;
  if (state.focus !== "all" && !profiles.some((profile) => profile.name === state.focus)) state.focus = "all";
}

// ---------------------------------------------------------------- 通知

function notify(kind, text, actions = []) {
  state.notices.push({ kind, text, actions });
  renderNotices();
}

function renderNotices() {
  const box = byId("notices");
  fill(box);
  for (const notice of state.notices) {
    const row = el("div", { class: `notice notice-${notice.kind}`, role: notice.kind === "error" ? "alert" : "status" });
    put(row, el("span", { text: notice.text }));
    for (const action of notice.actions) put(row, " ", button(action.label, action.onClick, { class: "link-button" }));
    put(row, 
      " ",
      button("關閉", () => {
        state.notices = state.notices.filter((item) => item !== notice);
        renderNotices();
      }, { class: "link-button", "aria-label": "關閉這則通知" }),
    );
    put(box, row);
  }
}

function sourceNotice() {
  state.notices = state.notices.filter((notice) => notice.tag !== "source");
  let notice = null;
  if (state.profileSource === "link") {
    notice = {
      kind: "info",
      text: "目前用的是連結裡的條件，沒有存在這個瀏覽器（重新整理就會消失）。",
      actions: [{ label: "存到這個瀏覽器", onClick: saveProfiles }],
    };
  } else if (state.profileSource === "unsaved") {
    notice = {
      kind: "info",
      text: "條件已更新，但還沒儲存。",
      actions: [
        { label: "存到這個瀏覽器", onClick: saveProfiles },
        { label: "只產生連結", onClick: makeLink },
      ],
    };
  }
  if (notice) state.notices.unshift({ ...notice, tag: "source" });
  renderNotices();
}

// ---------------------------------------------------------------- 頁首：區域與新鮮度

function renderHeader() {
  const select = byId("area-select");
  fill(select, 
    ...state.meta.areas.map((area) => el("option", { value: area.id, selected: area.id === state.areaId, text: area.name })),
  );
  select.value = state.areaId;
  renderFreshness();
}

function renderFreshness() {
  const fresh = freshness(state.meta, Date.now());
  const summary = byId("fresh-summary");
  const stale = [...fresh.sources.filter((s) => s.publish), ...fresh.datasets].filter((item) => item.stale === true);
  fill(summary, 
    el("span", { text: `資料更新：${timeText(fresh.generated.at)}（台北）` }),
    fresh.generated.ageHours !== null ? el("span", { class: "muted", text: ` ${agoText(fresh.generated.ageHours)}` }) : null,
    fresh.generated.stale ? el("span", { class: "badge badge-warn", text: "網站資料過期" }) : null,
    stale.length ? el("span", { class: "badge badge-warn", text: `${stale.length} 項過期` }) : null,
  );

  const rows = fresh.sources.map((source) => {
    let status;
    if (!source.publish) status = el("span", { class: "muted", text: "不公開" });
    else if (source.paused) status = el("span", { class: "warn", text: `暫停到 ${timeText(source.pausedUntil)}` });
    else if (source.stale) status = el("span", { class: "warn", text: `過期（超過 ${source.limitHours} 小時）` });
    else if (source.stale === null) status = el("span", { class: "muted", text: "沒有過期門檻" });
    else status = el("span", { class: "ok", text: "正常" });
    const error = source.errorCode ? el("div", { class: "warn small", text: labelOf(ERROR_LABELS, source.errorCode, "錯誤") }) : null;
    return el(
      "tr",
      {},
      el("th", { text: sourceLabel(source.id) || source.id }),
      el("td", { text: timeText(source.lastOk) }),
      el("td", { text: timeText(source.lastFullOk) }),
      el("td", {}, status, error),
    );
  });
  const datasetRows = fresh.datasets.map((dataset) => {
    const label = dataset.id === "lvr" ? "實價登錄" : "門牌資料";
    const extra = dataset.id === "lvr" ? `資料截至 ${dataset.asOf || "—"}` : `版本 ${dataset.version || "—"}`;
    const status = dataset.stale
      ? el("span", { class: "warn", text: `過期（超過 ${dataset.limitHours} 小時）` })
      : el("span", { class: "ok", text: "正常" });
    return el("tr", {}, el("th", { text: label }), el("td", { text: timeText(dataset.lastCheck) }), el("td", { text: extra }), el("td", {}, status));
  });
  fill(byId("fresh-table"), 
    el(
      "table",
      { class: "fresh-table" },
      el("thead", {}, el("tr", {}, el("th", { text: "來源" }), el("th", { text: "最後成功" }), el("th", { text: "最後完整掃描" }), el("th", { text: "狀態" }))),
      el("tbody", {}, rows),
      el("thead", {}, el("tr", {}, el("th", { text: "資料集" }), el("th", { text: "最後成功" }), el("th", { text: "資料截至／版本" }), el("th", { text: "狀態" }))),
      el("tbody", {}, datasetRows),
    ),
    el("p", { class: "muted small", text: "時間都是台北時間。「最後成功」是最近一次成功抓到資料；「最後完整掃描」才會用來判斷下架。過期門檻依各來源分開設定。" }),
  );
}

// ---------------------------------------------------------------- 條件列與搜尋連結

function searchLinks(profile, withNote) {
  const box = el("span", { class: "search-links" });
  const url591 = search591Url(profile);
  const urlSinyi = searchSinyiUrl(profile);
  if (url591) put(box, externalLink(url591, "到 591 搜尋", "chip-link"));
  if (urlSinyi) put(box, " ", externalLink(urlSinyi, "到信義搜尋", "chip-link"));
  if (withNote && (url591 || urlSinyi)) {
    put(box, el("span", { class: "muted small", text: " 會把你目前的篩選條件送到該網站" }));
  }
  return box;
}

function countFor(profile, kind) {
  const entry = state.data.get(state.areaId);
  const records = entry ? (kind === "listing" ? entry.listings : entry.tx) : [];
  let match = 0;
  let pending = 0;
  for (const rec of records) {
    const item = (state.results.get(rec) || []).find((result) => result.profile === profile);
    if (item && item.status === "match") match += 1;
    else if (item && item.status === "pending") pending += 1;
  }
  return { match, pending };
}

function renderProfileBar() {
  const bar = byId("profile-bar");
  fill(bar);
  const profiles = areaProfiles();
  const elsewhere = state.profiles.length - profiles.length;
  if (!profiles.length) {
    put(bar, 
      el("p", {
        text: "這個區域還沒有條件：所有物件用同一種中性顏色顯示，各檔範圍線也用同一種樣式畫。",
      }),
      button("新增條件", () => openEditor(), { class: "primary" }),
      " ",
      hasSearchLinks(state.areaId) ? searchLinks({ area: state.areaId }, false) : null,
      elsewhere > 0 ? el("p", { class: "muted small", text: `其他區域有 ${elsewhere} 組條件。` }) : null,
    );
    return;
  }
  const list = el("ul", { class: "profile-list" });
  for (const profile of profiles) {
    const counts = countFor(profile, state.view);
    const swatch = el("span", { class: "swatch", "aria-hidden": "true" });
    swatch.style.setProperty("--c", profileColor(profile));
    put(list, 
      el(
        "li",
        {},
        swatch,
        el("strong", { text: profile.name }),
        el("span", { class: "muted", text: `　符合 ${counts.match}・待確認 ${counts.pending}` }),
        el("div", {}, searchLinks(profile, true)),
      ),
    );
  }
  const unique = { match: 0, pending: 0 };
  const entry = state.data.get(state.areaId);
  for (const rec of entry ? (state.view === "listing" ? entry.listings : entry.tx) : []) {
    const results = state.results.get(rec) || [];
    if (results.some((item) => item.status === "match")) unique.match += 1;
    else if (results.some((item) => item.status === "pending")) unique.pending += 1;
  }
  const focus = el("select", { id: "focus-select", "aria-label": "只看哪一組條件" });
  put(focus, el("option", { value: "all", text: "全部條件", selected: state.focus === "all" }));
  for (const profile of profiles) {
    put(focus, el("option", { value: profile.name, text: profile.name, selected: state.focus === profile.name }));
  }
  focus.addEventListener("change", () => {
    state.focus = focus.value;
    state.shown = PAGE_SIZE;
    renderAll();
  });
  put(bar, 
    list,
    profiles.length > 1
      ? el("p", { class: "muted small", text: `不重複：符合 ${unique.match}・待確認 ${unique.pending}（同時符合多組的只算一次）` })
      : null,
    el("label", { class: "inline" }, "顯示：", focus),
    elsewhere > 0 ? el("p", { class: "muted small", text: `其他區域另有 ${elsewhere} 組條件。` }) : null,
  );
}

// ---------------------------------------------------------------- 清單

function badgeList(codes) {
  return el(
    "span",
    { class: "badges" },
    codes.map((code) => el("span", { class: `badge badge-${code}`, text: labelOf(BADGE_LABELS, code, code) })),
  );
}

function statusChips(rec) {
  const { list } = classify(rec);
  return el(
    "div",
    { class: "chips" },
    list.map((item) => {
      const chip = el(
        "span",
        { class: `chip chip-${item.status}` },
        el("span", { class: "swatch", "aria-hidden": "true" }),
        `${item.profile.name}：${STATUS_LABELS[item.status]}`,
      );
      chip.firstChild.style.setProperty("--c", profileColor(item.profile));
      if (item.reasons.length) chip.title = item.reasons.map((code) => labelOf(REASON_LABELS, code, code)).join("；");
      return chip;
    }),
  );
}

function reasonsText(rec) {
  const { list } = classify(rec);
  const parts = list
    .filter((item) => item.status !== "match" && item.reasons.length)
    .map((item) => {
      const text = item.reasons.map((code) => labelOf(REASON_LABELS, code, code)).join("、");
      return list.length > 1 ? `${item.profile.name}：${text}` : text;
    });
  if (!parts.length) return null;
  return el("p", { class: "reasons small", text: parts.join("；") });
}

function nearBadge(rec) {
  const { list } = classify(rec);
  return list.some((item) => item.reasons.some((code) => NEAR_THRESHOLD_REASONS.includes(code))) ? ["near_threshold"] : [];
}

function locationText(kind, rec) {
  const precision = kind === "listing" ? rec.loc && rec.loc.precision : rec.precision;
  const metrics = rec.metrics && typeof rec.metrics === "object" ? rec.metrics : {};
  const parts = [labelOf(PRECISION_LABELS, precision, "位置不明")];
  const area = areaMeta();
  if (area && area.kind === "buffer" && precision !== "road") {
    if (isNum(metrics.d_zhonglu_m)) parts.push(`離中路特區 ${metrics.d_zhonglu_m} m`);
    if (isNum(metrics.d_yiwen_m)) parts.push(`離藝文特區 ${metrics.d_yiwen_m} m`);
    if (isNum(metrics.d_rca_m)) parts.push(`離 RCA ${metrics.d_rca_m} m`);
  }
  if (area && area.kind === "drive" && precision !== "road") {
    if (metrics.in_district === false) parts.push("不在行政區內");
    else if (isNum(metrics.drive_min)) parts.push(`交流道 ${metrics.drive_min} 分鐘檔內`);
    else if (metrics.drive_min === null && metrics.in_district === true) parts.push("在每一檔車程範圍外");
  }
  if (precision === "road" && metrics.road_frac && typeof metrics.road_frac === "object") {
    const shares = focusedProfiles()
      .map((profile) => {
        const key = profileAreaKind(profile) === "drive" ? String(profile.drive_min) : `n${profile.near_m}_r${profile.rca_m}`;
        const share = metrics.road_frac[key];
        return isNum(share) ? `${profile.name}：路上門牌點 ${Math.round(share * 100)}% 在範圍內` : null;
      })
      .filter(Boolean);
    parts.push(...shares);
  }
  const district = kind === "listing" ? rec.loc && rec.loc.district : rec.district;
  if (typeof district === "string") parts.unshift(district);
  return parts.join("・");
}

function memberLinks(group) {
  const members = Array.isArray(group.members) ? group.members : [];
  return el(
    "ul",
    { class: "members" },
    members.map((member) => {
      const label = sourceLabel(member.src) || `其他來源（${member.src}）`;
      const url = listingUrl(member.src, member.id);
      const price = isNum(member.price) ? `${wanText(member.price)} 萬` : "價格不明";
      const dropAt = typeof member.price_drop_at === "string" ? Date.parse(member.price_drop_at) : Number.NaN;
      const drop =
        isNum(member.price) && isNum(member.price_first) && member.price_first - member.price >= RULE_CONSTANTS.PRICE_MIN_STEP_YUAN
          ? `（首次 ${wanText(member.price_first)} 萬${Number.isFinite(dropAt) ? `，${timeText(dropAt).slice(0, 10)} 降價` : ""}）`
          : "";
      const original = isNum(member.site_original_price) ? `（站方標示原價 ${wanText(member.site_original_price)} 萬）` : "";
      const gone = member.status === "gone" ? "（已下架）" : "";
      return el(
        "li",
        {},
        url ? externalLink(url, label) : el("span", { text: label }),
        ` ${price}${drop}${original}${gone}`,
      );
    }),
  );
}

function listingCard(group) {
  const facts = group.facts && typeof group.facts === "object" ? group.facts : {};
  const title = [facts.community_name, facts.road_text].find((text) => typeof text === "string" && text !== "conflict");
  const card = el("li", { class: `card card-${classify(group).best}`, tabindex: "0" });
  put(card, 
    el(
      "div",
      { class: "card-head" },
      el("strong", { class: "price", text: priceText(group.price_min, group.price_max) }),
      badgeList([...listingBadges(group, Date.now()), ...nearBadge(group)]),
    ),
    el("div", { class: "card-title", text: title || "（沒有社區名或路名）" }),
    el(
      "div",
      { class: "facts small" },
      [
        `主建物 ${pingFromCp(facts.main_cp)}${facts.main_kind === "main_plus_aux" ? "（含附屬）" : ""}`,
        ageText(facts.built_lo, facts.built_hi, state.today),
        floorText(facts.floor_lo, facts.floor_hi, facts.floors_total),
        parkingText(facts.parking),
        elevatorText(facts.elevator),
      ].join("・"),
    ),
    el("div", { class: "loc small muted", text: locationText("listing", group) }),
    statusChips(group),
    reasonsText(group),
    memberLinks(group),
  );
  bindSelect(card, "listing", group);
  return card;
}

function txCard(tx) {
  const card = el("li", { class: `card card-${classify(tx).best}`, tabindex: "0" });
  put(card, 
    el(
      "div",
      { class: "card-head" },
      el("strong", { class: "price", text: `${tx.date || "日期不明"}　${priceText(tx.total, tx.total)}` }),
      badgeList([...txBadges(tx), ...nearBadge(tx)]),
    ),
    el("div", { class: "card-title", text: typeof tx.addr === "string" ? tx.addr : "（沒有地址）" }),
    el("div", { class: "small", text: unitPriceText(tx.up) }),
    el(
      "div",
      { class: "facts small" },
      [
        `主建物 ${pingFromCm2(tx.main_cm2)}`,
        `成交時${ageText(tx.built_lo, tx.built_hi, tx.date)}`,
        floorText(tx.floor_lo, tx.floor_hi, tx.floors_total),
        txParkingText(tx.parking),
        elevatorText(tx.elevator),
      ].join("・"),
    ),
    el("div", { class: "loc small muted", text: locationText("tx", tx) }),
    statusChips(tx),
    reasonsText(tx),
  );
  bindSelect(card, "tx", tx);
  return card;
}

function bindSelect(node, kind, rec) {
  const choose = () => select(kind, rec, true);
  node.addEventListener("click", (event) => {
    if (event.target.closest("a, button")) return;
    choose();
  });
  node.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose();
    }
  });
}

function sortRecords(kind, records) {
  const rank = { match: 0, pending: 1, fail: 2, none: 3 };
  const decorated = records.map((rec) => ({ rec, best: classify(rec).best }));
  decorated.sort((a, b) => {
    if (rank[a.best] !== rank[b.best]) return rank[a.best] - rank[b.best];
    if (kind === "listing") {
      const goneA = a.rec.status === "gone" ? 1 : 0;
      const goneB = b.rec.status === "gone" ? 1 : 0;
      if (goneA !== goneB) return goneA - goneB;
      return String(b.rec.first_seen).localeCompare(String(a.rec.first_seen));
    }
    return String(b.rec.date).localeCompare(String(a.rec.date));
  });
  return decorated.map((item) => item.rec);
}

function renderTabsAndFilters() {
  const entry = state.data.get(state.areaId);
  for (const [kind, id, label] of [
    ["listing", "tab-listing", "開價物件"],
    ["tx", "tab-tx", "成交"],
  ]) {
    const tab = byId(id);
    const total = entry ? (kind === "listing" ? entry.listings.length : entry.tx.length) : 0;
    tab.textContent = `${label}（${total}）`;
    tab.setAttribute("aria-selected", String(state.view === kind));
    tab.classList.toggle("active", state.view === kind);
  }
  const hasProfiles = focusedProfiles().length > 0;
  for (const node of document.querySelectorAll("[data-filter]")) {
    const active = hasProfiles ? node.dataset.filter === state.filter : node.dataset.filter === "all";
    node.classList.toggle("active", active);
    node.setAttribute("aria-pressed", String(active));
    node.disabled = !hasProfiles && node.dataset.filter !== "all";
  }
}

function renderList() {
  const listNode = byId("list");
  const more = byId("more");
  fill(listNode);
  const summary = byId("summary");
  const records = sortRecords(state.view, visibleRecords(state.view));
  const hasProfiles = focusedProfiles().length > 0;
  if (!records.length) {
    const box = el("div", { class: "empty" });
    if (hasProfiles && state.filter === "match") {
      const pendingCount = (state.view === "listing" ? state.data.get(state.areaId).listings : state.data.get(state.areaId).tx).filter(
        (rec) => classify(rec).best === "pending",
      ).length;
      put(box, 
        el("p", { text: `這組條件下沒有符合的${state.view === "listing" ? "物件" : "成交"}；待確認有 ${pendingCount} 筆。` }),
        pendingCount ? button("看待確認", () => setFilter("pending"), { class: "link-button" }) : null,
      );
    } else {
      put(box, el("p", { text: "沒有資料。" }));
    }
    fill(summary, box);
    more.hidden = true;
    return;
  }
  fill(summary, 
    el("p", { class: "muted small", text: `共 ${records.length} 筆${records.length > state.shown ? `，先顯示前 ${state.shown} 筆` : ""}。` }),
  );
  const shown = records.slice(0, state.shown);
  put(listNode, ...shown.map((rec) => (state.view === "listing" ? listingCard(rec) : txCard(rec))));
  more.hidden = records.length <= state.shown;
}

function setFilter(filter) {
  state.filter = filter;
  state.shown = PAGE_SIZE;
  renderAll();
}

// ---------------------------------------------------------------- 詳細與比價

function select(kind, rec, pan) {
  state.selected = rec ? { kind, rec } : null;
  renderDetail();
  renderMap(false);
  if (rec && pan && map) {
    const point = recordPoint(kind, rec);
    if (point) {
      state.autoFit = false;
      map.panTo(point);
    }
  }
  if (rec) byId("detail").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function conflictTable(group) {
  const conflicts = group.conflicts && typeof group.conflicts === "object" ? group.conflicts : {};
  const fields = Object.keys(conflicts);
  if (!fields.length) return null;
  return el(
    "div",
    {},
    el("h4", { text: "各站資料不一" }),
    el(
      "ul",
      { class: "small" },
      fields.map((field) =>
        el(
          "li",
          {},
          `${field}：`,
          (Array.isArray(conflicts[field]) ? conflicts[field] : [])
            .map((item) => `${sourceLabel(item && item.src) || (item && item.src)} ${String(item && item.value)}`)
            .join("、"),
        ),
      ),
    ),
  );
}

function compsPanel(group) {
  const entry = state.data.get(state.areaId);
  const focus = focusedProfiles();
  const months = focus.length === 1 && focus[0].tx_months ? focus[0].tx_months : RULE_CONSTANTS.COMPS_DEFAULT_MONTHS;
  const result = comps(group, entry ? entry.tx : [], { today: state.today, months });
  const box = el("div", { class: "comps" }, el("h4", { text: "附近成交比價" }));
  if (!result.ok) {
    put(box, 
      el("p", {
        class: "muted small",
        text:
          result.reason === "precision"
            ? "位置只到路段、社區或定位不到，不做 300 公尺比價。"
            : "完工日不明，無法找屋齡相近的成交。",
      }),
    );
    return box;
  }
  const fmt = (value) => (value === null ? "—" : `${value.toFixed(2)} 萬／坪`);
  put(box, 
    el("p", {
      class: "small",
      text: `${RULE_CONSTANTS.COMPS_RADIUS_M} 公尺內、完工日相差 ${RULE_CONSTANTS.COMPS_YEARS} 年內、最近 ${months} 個月：${result.n} 筆。`,
    }),
    el("p", { class: "small", text: `扣車位單價中位數：含估算 ${fmt(result.medianAll)}（${result.n} 筆）；不含估算 ${fmt(result.medianOfficial)}（${result.nOfficial} 筆）。` }),
    el("p", {
      class: "muted small",
      text: `實價登錄資料截至 ${(entry && entry.txAsOf) || "—"}；最近兩三個月的成交通常還沒登記完整，所以「最近 ${months} 個月」實際涵蓋的時間比較短。估算值取區間中點。`,
    }),
  );
  if (result.items.length) {
    put(box, 
      el(
        "ul",
        { class: "small comps-list" },
        result.items.slice(0, 20).map((item) =>
          el(
            "li",
            {},
            `${item.tx.date}・${item.distanceM} m・${item.unit.toFixed(2)} 萬／坪${item.basis === "estimated" ? "（估算）" : ""}・`,
            typeof item.tx.addr === "string" ? item.tx.addr : "",
          ),
        ),
      ),
    );
  }
  return box;
}

function renderDetail() {
  const box = byId("detail");
  fill(box);
  if (!state.selected) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const { kind, rec } = state.selected;
  const close = button("關閉", () => select(null, null, false), { class: "link-button close", "aria-label": "關閉詳細資料" });
  if (kind === "listing") {
    const facts = rec.facts && typeof rec.facts === "object" ? rec.facts : {};
    put(box, 
      close,
      el("h3", { text: [facts.community_name, facts.road_text].find((t) => typeof t === "string" && t !== "conflict") || "物件" }),
      el("p", {}, priceText(rec.price_min, rec.price_max), " ", badgeList(listingBadges(rec, Date.now()))),
      el(
        "p",
        { class: "small" },
        [
          `主建物 ${pingFromCp(facts.main_cp)}`,
          `權狀 ${pingFromCp(facts.title_area_cp)}`,
          ageText(facts.built_lo, facts.built_hi, state.today),
          `完工 ${facts.built_lo || "?"}～${facts.built_hi || "?"}`,
          floorText(facts.floor_lo, facts.floor_hi, facts.floors_total),
          typeof facts.btype === "string" ? facts.btype : null,
          elevatorText(facts.elevator),
          parkingText(facts.parking),
          facts.parking_public === true ? "公有車位" : null,
          facts.price_excl_parking === true ? `車位另計 ${isNum(facts.parking_price_yuan) ? `${wanText(facts.parking_price_yuan)} 萬` : "（價格不明）"}` : null,
          typeof facts.layout === "string" ? facts.layout : null,
        ]
          .filter(Boolean)
          .join("・"),
      ),
      el("p", { class: "small muted", text: locationText("listing", rec) }),
      statusChips(rec),
      reasonsText(rec),
      conflictTable(rec),
      el("h4", { text: "刊登" }),
      memberLinks(rec),
      compsPanel(rec),
    );
  } else {
    put(box, 
      close,
      el("h3", { text: typeof rec.addr === "string" ? rec.addr : "成交" }),
      el("p", {}, `${rec.date || ""}　總價 ${priceText(rec.total, rec.total)}`, " ", badgeList(txBadges(rec))),
      el("p", { class: "small", text: unitPriceText(rec.up) }),
      el(
        "p",
        { class: "small" },
        [
          `主建物 ${pingFromCm2(rec.main_cm2)}`,
          `成交時${ageText(rec.built_lo, rec.built_hi, rec.date)}`,
          floorText(rec.floor_lo, rec.floor_hi, rec.floors_total),
          typeof rec.btype === "string" ? rec.btype : null,
          elevatorText(rec.elevator),
          txParkingText(rec.parking),
        ]
          .filter(Boolean)
          .join("・"),
      ),
      el("p", { class: "small muted", text: locationText("tx", rec) }),
      statusChips(rec),
      reasonsText(rec),
    );
  }
}

// ---------------------------------------------------------------- 地圖

function recordPoint(kind, rec) {
  const lat = kind === "listing" ? rec.loc && rec.loc.lat : rec.lat;
  const lon = kind === "listing" ? rec.loc && rec.loc.lon : rec.lon;
  return isNum(lat) && isNum(lon) ? [lat, lon] : null;
}

function ensureMap() {
  if (map) return true;
  const L = window.L;
  const box = byId("map");
  if (!L) {
    fill(box, el("p", { class: "map-missing", text: "地圖元件沒有載入，清單仍然可以用。" }));
    return false;
  }
  map = L.map(box, { preferCanvas: true, attributionControl: false, zoomControl: true }).setView([24.99, 121.3], 13);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
  // 自己畫出處，不用 Leaflet 的屬性控制項（它把字串當 HTML 放進頁面）。
  const Credit = L.Control.extend({
    options: { position: "bottomright" },
    onAdd() {
      const credit = el(
        "div",
        { class: "map-credit" },
        "底圖 © ",
        externalLink("https://www.openstreetmap.org/copyright", "OpenStreetMap"),
        " 貢獻者",
      );
      L.DomEvent.disableClickPropagation(credit);
      return credit;
    },
  });
  new Credit().addTo(map);
  layers.geo = L.layerGroup().addTo(map);
  layers.extra = L.layerGroup().addTo(map);
  layers.data = L.layerGroup().addTo(map);
  layers.counts = L.layerGroup().addTo(map);
  // 網頁可能在背景分頁或尺寸還沒定的面板裡載入；容器尺寸一變就更新地圖，
  // 還沒對準範圍的區域等到容器有尺寸再對準。
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      map.invalidateSize({ pan: false });
      if (state.pendingFit || state.autoFit) fitArea(true);
    }).observe(box);
  }
  const stopAutoFit = () => {
    state.autoFit = false;
  };
  box.addEventListener("pointerdown", stopAutoFit);
  box.addEventListener("wheel", stopAutoFit, { passive: true });
  box.addEventListener("keydown", stopAutoFit);
  return true;
}

function bandValue(props) {
  if (Number.isSafeInteger(props.option)) return props.option;
  if (Number.isSafeInteger(props.minutes)) return props.minutes;
  return null;
}

function chosenThresholds() {
  const chosen = { near_band: new Map(), avoid_band: new Map(), drive: new Map(), driveNext: new Map() };
  for (const profile of focusedProfiles()) {
    const color = profileColor(profile);
    if (profileAreaKind(profile) === "drive") {
      chosen.drive.set(profile.drive_min, color);
      chosen.driveNext.set(profile.drive_min + RULE_CONSTANTS.DRIVE_NEAR_BAND_MIN, color);
    } else {
      chosen.near_band.set(profile.near_m, color);
      chosen.avoid_band.set(profile.rca_m, color);
    }
  }
  return chosen;
}

const FIXED_STYLES = {
  near: { color: "#1d4ed8", weight: 2, fillColor: "#3b82f6", fillOpacity: 0.12 },
  avoid: { color: "#b91c1c", weight: 2, fillColor: "#ef4444", fillOpacity: 0.2 },
  district: { color: NEUTRAL_DARK, weight: 1.5, dashArray: "6 4", fill: false },
  clip: { color: NEUTRAL_DARK, weight: 2.5, dashArray: "2 6", fill: false },
  // L.geoJSON 的 style 也會套到點上，所以交流道入口點的樣式寫在這裡。
  marker: { color: "#111827", weight: 2, fill: true, fillColor: "#fbbf24", fillOpacity: 1, dashArray: null },
};

function geoStyle(feature, chosen, hasProfiles) {
  const props = feature && feature.properties && typeof feature.properties === "object" ? feature.properties : {};
  if (Object.prototype.hasOwnProperty.call(FIXED_STYLES, props.role)) return FIXED_STYLES[props.role];
  const neutral = { color: NEUTRAL, weight: 1.2, dashArray: "4 4", fill: false, opacity: 0.8 };
  if (!hasProfiles || !["near_band", "avoid_band", "drive"].includes(props.role)) return neutral;
  const value = bandValue(props);
  const color = chosen[props.role].get(value);
  if (color) return { color, weight: 2.5, fill: false };
  if (props.role === "drive" && chosen.driveNext.has(value)) {
    return { color: chosen.driveNext.get(value), weight: 1.5, dashArray: "8 6", fill: false };
  }
  return neutral;
}

function geoVisible(feature, chosen, hasProfiles) {
  const props = feature && feature.properties && typeof feature.properties === "object" ? feature.properties : {};
  if (!["near_band", "avoid_band", "drive"].includes(props.role) || !hasProfiles) return true;
  const value = bandValue(props);
  return chosen[props.role].has(value) || (props.role === "drive" && chosen.driveNext.has(value));
}

function drawGeo() {
  layers.geo.clearLayers();
  const entry = state.data.get(state.areaId);
  if (!entry || !entry.geo) return null;
  const L = window.L;
  const chosen = chosenThresholds();
  const hasProfiles = focusedProfiles().length > 0;
  const layer = L.geoJSON(entry.geo, {
    interactive: false,
    filter: (feature) => geoVisible(feature, chosen, hasProfiles),
    style: (feature) => geoStyle(feature, chosen, hasProfiles),
    pointToLayer: (feature, latlng) => L.circleMarker(latlng, { ...FIXED_STYLES.marker, radius: 6, interactive: false }),
  });
  layer.addTo(layers.geo);
  return layer;
}

function markerStyle(kind, rec, info) {
  const small = kind === "tx";
  const approx = kind === "listing"
    ? ["road", "community"].includes(rec.loc && rec.loc.precision)
    : ["road", "community"].includes(rec.precision) || (rec.up && rec.up.basis === "estimated");
  const base = { radius: small ? 5 : 7, weight: 1.5, color: "#ffffff", fillOpacity: 0.85, dashArray: approx ? "2 3" : null };
  if (info.best === "none") return { ...base, fillColor: NEUTRAL, color: NEUTRAL_DARK };
  if (info.best === "fail") return { ...base, radius: small ? 3 : 4, fillColor: "#cbd5e1", color: "#94a3b8", fillOpacity: 0.7 };
  if (info.best === "match") {
    const color = info.matched.length === 1 ? profileColor(info.matched[0].profile) : NEUTRAL_DARK;
    return { ...base, fillColor: color, color: "#ffffff" };
  }
  const color = info.pending.length === 1 ? profileColor(info.pending[0].profile) : NEUTRAL_DARK;
  return { ...base, weight: 2.5, fillColor: "#ffffff", fillOpacity: 0.9, color, dashArray: "4 3" };
}

function renderMap(fit) {
  if (!ensureMap()) return;
  const L = window.L;
  const geoLayer = drawGeo();
  layers.data.clearLayers();
  layers.counts.clearLayers();
  layers.extra.clearLayers();
  const points = [];
  for (const rec of visibleRecords(state.view)) {
    const point = recordPoint(state.view, rec);
    if (!point) continue;
    points.push(point);
    const info = classify(rec);
    const marker = L.circleMarker(point, { ...markerStyle(state.view, rec, info), bubblingMouseEvents: false });
    marker.on("click", () => select(state.view, rec, false));
    marker.addTo(layers.data);
    const many = info.best === "match" ? info.matched.length : info.best === "pending" ? info.pending.length : 0;
    if (many > 1) {
      const icon = L.divIcon({ className: "hw-count", html: el("span", { text: String(many) }), iconSize: [16, 16], iconAnchor: [-4, 18] });
      L.marker(point, { icon, interactive: false, keyboard: false }).addTo(layers.counts);
    }
  }
  if (state.selected) {
    const point = recordPoint(state.selected.kind, state.selected.rec);
    if (point) {
      L.circleMarker(point, { radius: 13, color: "#111827", weight: 2, fill: false, interactive: false }).addTo(layers.extra);
    }
    if (state.selected.kind === "listing") {
      const result = comps(state.selected.rec, state.data.get(state.areaId).tx, { today: state.today });
      if (result.ok) {
        for (const item of result.items) {
          L.circleMarker([item.tx.lat, item.tx.lon], { radius: 4, color: "#111827", weight: 1, fillColor: "#fde047", fillOpacity: 1, interactive: false }).addTo(layers.extra);
        }
      }
    }
  }
  state.bounds = geoLayer && geoLayer.getLayers().length ? geoLayer.getBounds() : points.length ? L.latLngBounds(points) : null;
  if (fit && !state.fitted.has(state.areaId)) fitArea(false);
  renderLegend();
}

/**
 * 讓地圖對準目前區域。容器還沒有尺寸（例如在背景分頁載入）時先記下來，等 ResizeObserver 有尺寸再對準；
 * 使用者還沒動過地圖時，容器尺寸改變也重新對準。
 */
function fitArea(force) {
  if (!map || !state.bounds || !state.bounds.isValid()) return;
  if (!force && state.fitted.has(state.areaId)) return;
  const box = byId("map");
  if (!box.clientWidth || !box.clientHeight) {
    state.pendingFit = true;
    return;
  }
  map.invalidateSize({ pan: false });
  map.fitBounds(state.bounds, { padding: [16, 16], animate: false });
  state.fitted.add(state.areaId);
  state.pendingFit = false;
}

function renderLegend() {
  const legend = byId("legend");
  const area = areaMeta();
  const profiles = focusedProfiles();
  const items = [];
  if (!profiles.length) {
    items.push(el("li", { text: "灰點：還沒有條件，所有物件同一種顏色。各檔範圍線都用同一種灰色虛線。" }));
  } else {
    for (const profile of profiles) {
      const swatch = el("span", { class: "swatch", "aria-hidden": "true" });
      swatch.style.setProperty("--c", profileColor(profile));
      items.push(el("li", {}, swatch, `${profile.name}：實心＝符合，空心虛線＝待確認；範圍線是這組選的那一檔`));
    }
    items.push(el("li", { text: "深灰色加數字：同時符合（或待確認）好幾組條件，數字是組數。淺灰小點：不符（只在「全部」顯示）。" }));
  }
  items.push(el("li", { text: `大點是開價物件、小點是成交；點線外框表示位置只到路段或社區，或成交單價是估算的。` }));
  if (area && area.kind === "buffer") {
    // PLAN_v2 §4 第 4 項：中路／藝文的最大周邊選項跨到蘆竹區的那一小塊直接裁掉，地圖上畫出裁切線並註明。
    const example = area.id === "taoyuan_core" ? "最大的周邊選項跨到蘆竹區的那一小塊已裁掉，" : "跨到鄰區的部分已裁掉，";
    items.push(el("li", { text: `藍色是特區、紅色是 RCA 管制區。周邊範圍只算到這個區域查詢的行政區為止：${example}粗點線就是裁切線。` }));
  }
  if (area && area.kind === "drive") {
    items.push(el("li", { text: "車程用一般路況（不塞車）的保守引擎估算。「接近車程門檻」＝超出你選的分鐘數、但在下一檔之內，列為待確認；另一個路線引擎普遍快約 2 分鐘。黃點是交流道入口。" }));
  }
  fill(legend, el("ul", { class: "small" }, items));
}

// ---------------------------------------------------------------- 條件編輯

function numberValue(input) {
  const text = input.value.trim();
  if (text === "") return null;
  return Number(text);
}

function field(labelText, control, hint) {
  return el("label", { class: "field" }, el("span", { class: "field-label", text: labelText }), control, hint ? el("span", { class: "muted small", text: hint }) : null);
}

function numberInput(name, value, attrs = {}) {
  return el("input", { type: "number", name, value: value === null || value === undefined ? "" : String(value), inputmode: "decimal", step: "any", ...attrs });
}

function profileForm(original, onDone) {
  const areas = state.meta.areas;
  const form = el("div", { class: "profile-form" });
  const p = original || { name: "", area: state.areaId };
  const name = el("input", { type: "text", name: "name", value: p.name || "", autocomplete: "off" });
  const area = el("select", { name: "area" }, areas.map((item) => el("option", { value: item.id, selected: item.id === p.area, text: item.name })));
  const price = numberInput("price_max_wan", p.price_max_wan);
  const ageLo = numberInput("age_lo", p.built_years ? p.built_years[0] : null, { step: "1" });
  const ageHi = numberInput("age_hi", p.built_years ? p.built_years[1] : null, { step: "1" });
  const floorLo = numberInput("floor_lo", p.floor ? p.floor[0] : null, { step: "1" });
  const floorHi = numberInput("floor_hi", p.floor ? p.floor[1] : null, { step: "1" });
  const main = numberInput("main_min_ping", p.main_min_ping);
  const elevatorRequired = el("input", { type: "checkbox", checked: Boolean(p.elevator && p.elevator.required) });
  const elevatorInferred = el("input", { type: "checkbox", checked: Boolean(p.elevator && p.elevator.inferred_ok) });
  const parkingBoxes = PARKING_CHOICES.map((choice) => ({
    choice,
    input: el("input", { type: "checkbox", checked: Boolean(p.parking_ok && p.parking_ok.includes(choice)) }),
  }));
  const liftOk = el("input", { type: "checkbox", checked: p.lift_flat_ok === true });
  const unitPrice = numberInput("unit_price_max_wan", p.unit_price_max_wan);
  const months = numberInput("tx_months", p.tx_months, { step: "1" });
  const thresholdBox = el("div", { class: "thresholds" });
  const thresholdSelects = {};
  const error = el("p", { class: "warn", role: "alert" });

  const renderThresholds = () => {
    fill(thresholdBox);
    const meta = areas.find((item) => item.id === area.value);
    const options = meta && meta.options && typeof meta.options === "object" ? meta.options : {};
    const keys = meta && meta.kind === "drive" ? [["drive_min", "到交流道車程（分鐘以內）"]] : [["near_m", "特區周邊（公尺以內）"], ["rca_m", "避開 RCA（公尺以內排除）"]];
    for (const key of Object.keys(thresholdSelects)) delete thresholdSelects[key];
    for (const [key, label] of keys) {
      const values = Array.isArray(options[key]) ? options[key] : [];
      const current = original && original.area === area.value ? original[key] : null;
      const selectNode = el("select", { name: key }, el("option", { value: "", text: "請選一檔" }), values.map((value) => el("option", { value: String(value), selected: value === current, text: String(value) })));
      thresholdSelects[key] = selectNode;
      put(thresholdBox, field(label, selectNode));
    }
    if (meta && meta.kind === "drive") {
      put(thresholdBox, el("p", { class: "muted small", text: "超出所選分鐘數、但在下一檔之內的，會列為「接近車程門檻」（待確認）。另一個路線引擎普遍快約 2 分鐘。" }));
    }
  };
  area.addEventListener("change", renderThresholds);
  renderThresholds();

  const collect = () => {
    const pair = (a, b) => {
      const x = numberValue(a);
      const y = numberValue(b);
      return x === null && y === null ? null : [x, y];
    };
    const profile = {
      name: name.value.trim(),
      area: area.value,
      price_max_wan: numberValue(price),
      built_years: pair(ageLo, ageHi),
      floor: pair(floorLo, floorHi),
      main_min_ping: numberValue(main),
      elevator: elevatorRequired.checked ? { required: true, inferred_ok: elevatorInferred.checked } : null,
      unit_price_max_wan: numberValue(unitPrice),
      tx_months: numberValue(months),
    };
    const chosen = parkingBoxes.filter((box) => box.input.checked).map((box) => box.choice);
    if (chosen.length || liftOk.checked) {
      profile.parking_ok = chosen;
      profile.lift_flat_ok = liftOk.checked;
    }
    for (const [key, selectNode] of Object.entries(thresholdSelects)) {
      profile[key] = selectNode.value === "" ? null : Number(selectNode.value);
    }
    return profile;
  };

  const save = () => {
    const edited = collect();
    const others = state.profiles.filter((item) => item !== original);
    const next = original ? state.profiles.map((item) => (item === original ? edited : item)) : [...others, edited];
    try {
      const text = serializeProfiles({ v: 1, profiles: next }, { areas });
      const parsed = parseProfiles(text, { areas });
      if (!parsed.ok) throw new Error(parsed.error);
      setProfiles(parsed.profiles, "unsaved");
      onDone();
    } catch (problem) {
      error.textContent = problem.message;
    }
  };

  put(form, 
    field("名稱", name, "例如「條件甲」"),
    field("區域", area),
    thresholdBox,
    field("開價上限（萬元，以下含本數）", price),
    el("div", { class: "pair" }, field("屋齡：滿幾年", ageLo), field("未滿幾年", ageHi)),
    el("div", { class: "pair" }, field("樓層：最低", floorLo), field("最高", floorHi)),
    field("主建物（坪以上）", main),
    el("fieldset", {}, el("legend", { text: "電梯" }), el("label", { class: "check" }, elevatorRequired, "要有電梯"), el("label", { class: "check" }, elevatorInferred, "依建物型態推定有電梯也算")),
    el(
      "fieldset",
      {},
      el("legend", { text: "可以接受的車位（都不勾＝不篩車位）" }),
      parkingBoxes.map((box) => el("label", { class: "check" }, box.input, PARKING_CHOICE_LABELS[box.choice])),
      el("label", { class: "check" }, liftOk, "升降平面也算（會另外標示）"),
    ),
    field("成交扣車位單價上限（萬／坪，只用在成交）", unitPrice),
    field("成交：最近幾個月", months, "空白＝不限"),
    error,
    el("div", { class: "actions" }, button("套用", save, { class: "primary" }), " ", button("取消", onDone, { class: "link-button" })),
  );
  return form;
}

function saveProfiles() {
  const areas = state.meta.areas;
  let text;
  try {
    text = serializeProfiles({ v: 1, profiles: state.profiles }, { areas });
  } catch (problem) {
    notify("error", `條件無法儲存：${problem.message}`);
    return;
  }
  if (storageSet(text)) {
    state.profileSource = "stored";
    sourceNotice();
    notify("info", "已存在這個瀏覽器。");
  } else {
    notify("error", "這個瀏覽器不允許儲存（可能是私密瀏覽）。可以改用「只產生連結」並存成書籤。");
  }
  if (!byId("editor").hidden) renderEditor();
}

function makeLink() {
  const areas = state.meta.areas;
  try {
    const fragment = profilesToFragment({ v: 1, profiles: state.profiles }, { areas });
    state.link = `${location.origin}${location.pathname}${location.search}${fragment}`;
  } catch (problem) {
    notify("error", `無法產生連結：${problem.message}`);
    return;
  }
  openEditor();
  const copy = navigator.clipboard && window.isSecureContext ? navigator.clipboard.writeText(state.link) : Promise.reject(new Error("no clipboard"));
  copy.then(
    () => notify("info", "已複製你的條件連結。把它存成書籤，之後用書籤打開就會帶入條件。"),
    () => notify("info", "請從「我的連結」欄位手動複製。"),
  );
}

function clearStored() {
  if (storageRemove()) notify("info", "已清除這個瀏覽器存的條件（目前畫面上的條件還在，重新整理後就不見了）。");
  if (state.profileSource === "stored") {
    state.profileSource = "unsaved";
    sourceNotice();
  }
  renderEditor();
}

function openEditor() {
  byId("editor").hidden = false;
  renderEditor();
  byId("editor").scrollIntoView({ block: "start" });
}

function closeEditor() {
  byId("editor").hidden = true;
  state.link = null;
  renderAll();
}

function renderEditor(formFor) {
  const box = byId("editor");
  fill(box);
  const header = el("div", { class: "editor-head" }, el("h2", { text: "我的條件" }), button("完成", closeEditor, { class: "primary" }));
  put(box, header);
  if (formFor !== undefined) {
    put(box, 
      el("h3", { text: formFor ? "編輯條件" : "新增條件" }),
      profileForm(formFor, () => {
        sourceNotice();
        renderEditor();
        renderAll();
      }),
    );
    return;
  }
  const list = el("ul", { class: "profile-edit-list" });
  for (const profile of state.profiles) {
    const area = areaMeta(profile.area);
    const swatch = el("span", { class: "swatch", "aria-hidden": "true" });
    swatch.style.setProperty("--c", profileColor(profile));
    put(list, 
      el(
        "li",
        {},
        swatch,
        el("strong", { text: profile.name }),
        el("span", { class: "muted", text: `　${area ? area.name : profile.area}` }),
        " ",
        button("編輯", () => renderEditor(profile), { class: "link-button" }),
        " ",
        button("刪除", () => {
          setProfiles(state.profiles.filter((item) => item !== profile), "unsaved");
          sourceNotice();
          renderEditor();
          renderAll();
        }, { class: "link-button" }),
      ),
    );
  }
  put(box, 
    state.profiles.length ? list : el("p", { class: "muted", text: "還沒有條件。網頁不附任何預設條件，請自己新增。" }),
    button("新增一組條件", () => renderEditor(null), { class: "primary" }),
    el("h3", { text: "保存方式" }),
    el("p", { class: "small", text: "條件只存在你的瀏覽器或你產生的連結裡，網頁不會自己送出去；只有按 591、信義的搜尋按鈕時，會把部分條件放進那個網站的搜尋網址。" }),
    el(
      "div",
      { class: "actions" },
      button("存到這個瀏覽器", saveProfiles, { disabled: !state.profiles.length }),
      " ",
      button("只產生連結（不存在這個瀏覽器）", makeLink, { disabled: !state.profiles.length }),
      " ",
      button("清除這個瀏覽器存的條件", clearStored, { class: "link-button" }),
    ),
    el("p", {
      class: "warn small",
      text: "注意：同一個 GitHub 帳號底下的所有 Pages 網站共用同一個瀏覽器儲存空間，存在這裡的條件，那些網站也讀得到。不想留在瀏覽器，就用「只產生連結」並把連結存成書籤。",
    }),
    el("p", { class: "muted small", text: "連結裡帶著你的條件，只給你信任的人。打開連結時，條件會先從網址列拿掉，不會出現在截圖裡。" }),
  );
  if (state.link) {
    const output = el("input", { type: "text", readonly: true, "aria-label": "我的連結", value: state.link });
    output.addEventListener("focus", () => output.select());
    put(box, field("我的連結", output));
  }
}

// ---------------------------------------------------------------- 整頁

function renderAll() {
  if (!state.meta || !state.data.has(state.areaId)) return;
  state.today = taipeiDate(Date.now()); // 網頁開著跨過午夜時，屋齡與成交月數也用今天（事後審查 P-8）
  computeResults();
  renderTabsAndFilters();
  renderProfileBar();
  renderList();
  if (state.selected && !state.results.has(state.selected.rec)) state.selected = null;
  renderDetail();
  renderMap(true);
}

async function showArea(areaId) {
  state.areaId = areaId;
  state.selected = null;
  state.shown = PAGE_SIZE;
  state.focus = "all";
  state.autoFit = true;
  state.fitted.delete(areaId);
  fill(byId("list"), el("li", { class: "muted", text: "讀取中…" }));
  try {
    await loadArea(areaId);
  } catch (problem) {
    showLoadError(problem);
    return;
  }
  renderHeader();
  renderAll();
}

function showLoadError(problem) {
  const fileProtocol = location.protocol === "file:";
  const version = problem instanceof LoadError && problem.message === "version";
  const text = version
    ? "資料格式的版本和網頁不同：請重新整理；如果還是這樣，代表網頁和資料不是同一版。"
    : fileProtocol
      ? "讀不到資料：直接用檔案（file://）打開時，瀏覽器會擋住資料讀取。請改用 `house-watch serve`，或把網站放在任何靜態主機上。"
      : "讀不到資料：請稍後重新整理。如果是在本機看，請用 `house-watch serve` 打開。";
  notify("error", text);
  fill(byId("list"));
  fill(byId("summary"), el("p", { class: "warn", text: "目前沒有可以顯示的資料（這不代表 0 筆）。" }));
}

function wireStaticControls() {
  byId("area-select").addEventListener("change", (event) => showArea(event.target.value));
  byId("edit-profiles").addEventListener("click", () => openEditor());
  byId("tab-listing").addEventListener("click", () => {
    state.view = "listing";
    state.shown = PAGE_SIZE;
    state.selected = null;
    renderAll();
  });
  byId("tab-tx").addEventListener("click", () => {
    state.view = "tx";
    state.shown = PAGE_SIZE;
    state.selected = null;
    renderAll();
  });
  for (const node of document.querySelectorAll("[data-filter]")) {
    node.addEventListener("click", () => setFilter(node.dataset.filter));
  }
  byId("more").addEventListener("click", () => {
    state.shown += PAGE_SIZE;
    renderList();
  });
}

function captureFragment() {
  // 啟動的第一件事：讀出 #p= 並從網址列拿掉（R2-01），之後才發任何請求。
  const result = readFragment(location.hash);
  if (result.present) {
    try {
      history.replaceState(null, "", `${location.pathname}${location.search}`);
    } catch {
      // 有些環境不允許改網址；條件仍然只在記憶體裡。
    }
  }
  return result;
}

/** 套用分享片段裡的條件；成功回 true。失敗時整份不套用，只說明錯在哪一類（不回顯片段內容）。 */
function applyFragment(fragment) {
  if (!fragment.present) return false;
  const parsed = fragment.ok ? parseProfiles(fragment.text, { areas: state.meta.areas }) : fragment;
  if (parsed.ok) {
    setProfiles(parsed.profiles, "link");
    return true;
  }
  notify("error", `這個連結裡的條件無法讀取（${parsed.error}），整份都沒有套用。`);
  return false;
}

/** 頁面已經開著時打開書籤，瀏覽器只改 # 片段、不重新載入；一樣讀出、拿掉、套用。 */
async function onHashChange() {
  const fragment = captureFragment();
  if (!fragment.present || !state.meta) return;
  if (!applyFragment(fragment)) return;
  sourceNotice();
  const first = state.profiles.find((profile) => areaMeta(profile.area));
  if (first && first.area !== state.areaId) await showArea(first.area);
  else renderAll();
}

function applyStartupProfiles(fragment) {
  const areas = state.meta.areas;
  if (applyFragment(fragment)) return;
  const stored = storageGet();
  if (stored === null) return;
  const parsed = parseProfiles(stored, { areas });
  if (parsed.ok) {
    setProfiles(parsed.profiles, "stored");
  } else {
    notify("error", `這個瀏覽器存的條件無法讀取（${parsed.error}），整份都沒有套用。`, [
      { label: "清除存的條件", onClick: () => { storageRemove(); notify("info", "已清除。"); } },
    ]);
  }
}

async function startMain() {
  const fragment = captureFragment();
  const params = new URLSearchParams(location.search);
  state.fixtures = params.has("fixtures");
  wireStaticControls();
  try {
    const meta = await fetchJson("data/meta.json", { noStore: true });
    if (!validMeta(meta)) throw new LoadError("json");
    if (meta.schema_version !== 1) throw new LoadError("version");
    state.meta = meta;
  } catch (problem) {
    showLoadError(problem);
    return;
  }
  if (!state.meta.areas.length) {
    notify("info", "資料建立中：還沒有任何區域的資料。");
    return;
  }
  if (state.meta.status === "building") notify("info", "資料建立中：第一次完整更新還沒跑完，清單可能不完整。");
  applyStartupProfiles(fragment);
  sourceNotice();
  window.addEventListener("hashchange", onHashChange);
  const firstProfileArea = state.profiles.find((profile) => areaMeta(profile.area));
  await showArea(firstProfileArea ? firstProfileArea.area : state.meta.areas[0].id);
}

// ---------------------------------------------------------------- selftest.html

async function startSelftest() {
  const out = byId("selftest");
  let table;
  try {
    const response = await fetch("rules_cases.json", { cache: "no-store" });
    table = await response.json();
  } catch {
    fill(out, el("p", { class: "warn", text: "讀不到 rules_cases.json：請用本機伺服器打開這一頁。" }));
    return;
  }
  const results = [...runCases(table), ...runCases({ cases: nanCases(table) })];
  const failed = results.filter((item) => !item.ok);
  const roundTrip = table.cases.every((item) => {
    const parsed = parseProfiles(serializeProfiles({ v: 1, profiles: [item.profile] }));
    return parsed.ok && JSON.stringify(serializeProfiles({ v: 1, profiles: parsed.profiles })) === JSON.stringify(serializeProfiles({ v: 1, profiles: [item.profile] }));
  });
  fill(out, 
    el("p", { class: failed.length ? "warn" : "ok", text: `案例 ${results.length} 筆：通過 ${results.length - failed.length}，失敗 ${failed.length}。` }),
    el("p", { class: roundTrip ? "ok" : "warn", text: `條件寫出再讀回：${roundTrip ? "一致" : "不一致"}。` }),
    el(
      "table",
      { class: "fresh-table" },
      el("thead", {}, el("tr", {}, el("th", { text: "案例" }), el("th", { text: "預期" }), el("th", { text: "結果" }))),
      el(
        "tbody",
        {},
        [...failed, ...results.filter((item) => item.ok)].map((item) =>
          el(
            "tr",
            { class: item.ok ? "" : "row-fail" },
            el("td", { text: item.name }),
            el("td", { text: `${item.expect.status} ${item.expect.reasons.join(",")}` }),
            el("td", { text: `${item.ok ? "✓" : "✗"} ${item.got.status} ${item.got.reasons.join(",")}` }),
          ),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------- 進入點

// 被別的網站用 iframe 嵌入時不顯示編輯器與按鈕，避免誘騙點擊（事後審查 SA-11）。
// meta CSP 設不了 frame-ancestors，GitHub Pages 也不能加回應標頭，所以在這裡擋。
function framedByAnotherSite() {
  try {
    return window.top !== window.self;
  } catch {
    return true; // 跨網域的上層視窗讀不到，就是被嵌入
  }
}

if (typeof document !== "undefined") {
  if (framedByAnotherSite()) {
    document.body.replaceChildren(
      el("p", { text: "這個網頁不能嵌在別的網站裡。請直接打開它的網址。" }),
    );
  } else if (document.documentElement.dataset.page === "selftest") startSelftest();
  else startMain();
}
