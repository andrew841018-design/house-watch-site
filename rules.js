// house_watch 瀏覽器規則（契約 C3、C4）。ES module，不碰 DOM。
//
// 這個檔由 WP8a 擁有。內容：
// - evaluate()：一筆紀錄對一組條件的判定（C4）。
// - parseProfiles()、serializeProfiles()：條件的讀寫，給 localStorage 與分享連結用（C3）。
// - 其他純函式：分享片段、資料新鮮度、比價、徽章、顯示用換算。網頁（app.js）與測試共用。
//
// 契約格式（WP0 定）：
// - ENUMS 與 REASONS 的內容要寫成合法 JSON（雙引號、不放註解、不留尾逗號），
//   夾在 /*<contract:名稱>*/ 與 /*</contract:名稱>*/ 兩個標記之間。
// - Python 的契約測試（tests/test_web_contract.py）用正則取出這兩段：
//   ENUMS 必須和 src/house_watch/models.py 的 RULE_ENUMS 完全相同；
//   案例表（test/rules_cases.json）用到的原因代碼都要在 REASONS 裡。
// - 列舉值只由 WP0 新增；原因代碼由 WP8a 維護。
//
// 單位與口徑：
// - 金額一律是整數元；條件的「萬」只在比較前乘 10000。
// - 開價物件的面積是 0.01 坪的整數（main_cp）；成交是 0.01 m² 的整數（main_cm2）。
//   1 坪 = 400/121 m²。面積與單價的門檻一律用整數交叉相乘（BigInt），不經過浮點除法（R3-10）。
// - 「以下」「以上」「以內」含本數；「未滿」不含本數。
// - 缺值：null、undefined、NaN、空字串（含只有空白）都算缺值。每條規則先看缺值，最後才比大小（R3-02）。
//   缺值一律是「待確認」，不會讓上限型的條件通過。

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export const ENUMS = deepFreeze(/*<contract:ENUMS>*/{
  "BType": ["大樓", "華廈", "公寓", "透天", "其他"],
  "Elevator": ["yes", "no", "inferred", "unknown"],
  "MainKind": ["main", "main_plus_aux"],
  "Parking": [
    "ramp_flat",
    "ground_flat",
    "lift_flat",
    "flat_unknown_access",
    "mechanical",
    "mixed_with_flat",
    "mixed_no_flat",
    "none",
    "unknown"
  ],
  "Precision": ["site", "door", "community", "road", "none"],
  "RecordStatus": ["active", "gone"],
  "UpBasis": ["official", "estimated", "none"]
}/*</contract:ENUMS>*/);

// 原因代碼。fail 類：區域、位置、價格、屋齡、樓層、面積、電梯、車位、單價不符。
// pending 類：<欄位>_missing（缺值）、邊界類（*_boundary、drive_near、age_boundary）、
// 衝突類（group_conflict、loc_conflict）、位置類（loc_road_mid）與口徑不明的幾種。
export const REASONS = deepFreeze(/*<contract:REASONS>*/[
  "area_mismatch",
  "loc_missing",
  "loc_conflict",
  "district_out",
  "district_missing",
  "near_missing",
  "near_boundary",
  "near_out",
  "rca_missing",
  "rca_boundary",
  "rca_within",
  "road_frac_missing",
  "loc_road_mid",
  "loc_road_out",
  "drive_missing",
  "drive_near",
  "drive_out",
  "date_missing",
  "tx_old",
  "price_missing",
  "price_over",
  "price_excl_parking_missing",
  "parking_price_missing",
  "built_missing",
  "age_boundary",
  "age_under",
  "age_over",
  "floor_missing",
  "floor_out",
  "main_missing",
  "main_under",
  "main_boundary",
  "main_plus_aux",
  "main_kind_missing",
  "elevator_missing",
  "elevator_no",
  "elevator_inferred",
  "parking_missing",
  "parking_not_ok",
  "parking_flat_access",
  "parking_public",
  "up_missing",
  "up_over",
  "up_range",
  "group_conflict"
]/*</contract:REASONS>*/);

// ---------------------------------------------------------------- 常數

export const RULE_CONSTANTS = deepFreeze({
  // R1-24：距離落在門檻 ±30 m 內（含）算「接近邊界」→ 待確認。
  NEAR_BOUNDARY_M: 30,
  // 社區精度（OSM 社區名或他站同社區的座標）只到社區、不是那一戶：接近邊界放寬到 ±150 m
  // （事後審查 P-5；契約 C2 原本只給門牌或網站座標精度距離）。
  COMMUNITY_BOUNDARY_M: 150,
  // 中壢車程：超出所選分鐘數、但在下一檔之內的，算「接近車程門檻」→ 待確認（PLAN_v2 §4 第 3 項）。
  // evaluate() 拿不到區域的選項清單，所以「下一檔」寫成固定的寬度：選項每檔相差 2 分鐘，
  // 另一個路線引擎也普遍快約 2 分鐘。選項清單改成不同間距時，這裡要一起改。
  DRIVE_NEAR_BAND_MIN: 2,
  // R1-14、R3-06：路段精度用門牌點比例判斷。
  ROAD_IN: 0.9,
  ROAD_OUT: 0.1,
  // R1-23：比價範圍。
  COMPS_RADIUS_M: 300,
  COMPS_YEARS: 3,
  COMPS_DEFAULT_MONTHS: 12,
  // PLAN §4：新上架是首次出現後 72 小時內。
  NEW_BADGE_HOURS: 72,
  // R3-22：價格差不到 1 萬不算一次變動；降價徽章和「首次 X 萬」也照這條（和 Python 一致）。
  PRICE_MIN_STEP_YUAN: 10000,
});

export const PROFILE_STORAGE_KEY = "house-watch:profiles:v1";
export const PROFILE_VERSION = 1;
export const MAX_PROFILES = 20;
export const MAX_PROFILE_TEXT = 20000;
const MAX_FRAGMENT = 30000;
const FRAGMENT_PREFIX = "#p=";

// C3 的條件欄位，也是 serializeProfiles() 輸出的鍵順序。
export const PROFILE_KEYS = Object.freeze([
  "name",
  "area",
  "price_max_wan",
  "built_years",
  "floor",
  "main_min_ping",
  "elevator",
  "parking_ok",
  "lift_flat_ok",
  "near_m",
  "rca_m",
  "drive_min",
  "unit_price_max_wan",
  "tx_months",
]);

// parking_ok 可以選的車位類型。升降平面另用 lift_flat_ok 切換（DESIGN 4-1），
// 「平面但出入方式不明」「混合」「不明」是由資料推出來的狀態，不能直接選。
export const PARKING_CHOICES = Object.freeze(["ramp_flat", "ground_flat", "mechanical", "none"]);
const FLAT_KINDS = Object.freeze(["ramp_flat", "ground_flat", "lift_flat"]);
const CONFLICT = "conflict";

// ---------------------------------------------------------------- 小工具

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainObject(value) {
  if (!isObject(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const isConflict = (value) => value === CONFLICT;
const intValue = (value) => (Number.isSafeInteger(value) ? value : null);
const nonNegInt = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const posInt = (value) => (Number.isSafeInteger(value) && value >= 1 ? value : null);

function fraction(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function enumValue(name, value) {
  return typeof value === "string" && ENUMS[name].includes(value) ? value : null;
}

function isLatLon(lat, lon) {
  return (
    typeof lat === "number" &&
    typeof lon === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  );
}

// ---------------------------------------------------------------- 日期（日曆計算）

function isLeap(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year, month) {
  if (month === 2) return isLeap(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** "YYYY-MM-DD" → {y, m, d}；格式或日期不合法時回 null（當成缺值）。 */
export function parseDate(value) {
  if (typeof value !== "string") return null;
  const found = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!found) return null;
  const y = Number(found[1]);
  const m = Number(found[2]);
  const d = Number(found[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

const dayKey = (date) => date.y * 10000 + date.m * 100 + date.d;

/**
 * 加 n 年（n 可以是負數）。2 月 29 日加到平年時用 2 月 28 日（R1-06：寫死這一種）。
 * 例：2016-02-29 加 10 年是 2026-02-28，所以 2026-02-28 當天滿 10 年。
 */
export function addYears(date, years) {
  const y = date.y + years;
  return { y, m: date.m, d: Math.min(date.d, daysInMonth(y, date.m)) };
}

/** 加 n 個月（n 可以是負數）；目標月沒有那一天時用月底。 */
export function addMonths(date, months) {
  const index = date.y * 12 + (date.m - 1) + months;
  const y = Math.floor(index / 12);
  const m = index - y * 12 + 1;
  return { y, m, d: Math.min(date.d, daysInMonth(y, m)) };
}

export function formatDate(date) {
  const pad = (n, w) => String(n).padStart(w, "0");
  return `${pad(date.y, 4)}-${pad(date.m, 2)}-${pad(date.d, 2)}`;
}

/** 台北的日期 YYYY-MM-DD。台灣沒有日光節約時間，固定 UTC+8。 */
export function taipeiDate(nowMs) {
  return new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- 單條規則的結果

const PASS = Object.freeze({ r: "pass" });
const pending = (code) => ({ r: "pending", code });
const failure = (code) => ({ r: "fail", code });

// ---------------------------------------------------------------- 位置

function locationResults(kind, rec, profile) {
  const useNear = profile.near_m !== null;
  const useRca = profile.rca_m !== null;
  const useDrive = profile.drive_min !== null;
  if (!useNear && !useRca && !useDrive) return [];

  let precision;
  if (kind === "listing") {
    const loc = isObject(rec.loc) ? rec.loc : null;
    // R3-01：定位證據互相矛盾 → 待確認，不用可能算錯的指標判定。
    if (loc && loc.conflict === true) return [pending("loc_conflict")];
    precision = loc ? enumValue("Precision", loc.precision) : null;
  } else {
    precision = enumValue("Precision", rec.precision);
  }
  if (precision === null || precision === "none") return [pending("loc_missing")];

  const metrics = isObject(rec.metrics) ? rec.metrics : {};
  // 有效範圍＝外推範圍 ∩ 區域查詢的行政區（R3-21）。Python 明確寫「不在區內」就不符。
  if (metrics.in_district === false) return [failure("district_out")];

  const results = [];
  if (precision === "road") {
    const fractions = isObject(metrics.road_frac) ? metrics.road_frac : null;
    if (useNear || useRca) results.push(roadBuffer(fractions, profile.near_m, profile.rca_m));
    if (useDrive) results.push(roadDrive(fractions, profile.drive_min));
    return results;
  }
  const margin = precision === "community" ? RULE_CONSTANTS.COMMUNITY_BOUNDARY_M : RULE_CONSTANTS.NEAR_BOUNDARY_M;
  if (useNear) results.push(nearCheck([metrics.d_zhonglu_m, metrics.d_yiwen_m], profile.near_m, margin));
  if (useRca) results.push(rcaCheck(metrics.d_rca_m, profile.rca_m, margin));
  if (useDrive) results.push(driveCheck(metrics, profile.drive_min, precision));
  return results;
}

// 周邊：到兩個特區的較小距離 ≤ near_m 算在範圍內（含本數）。
// 距離 0 是在特區裡面，一定通過；|距離 − 門檻| ≤ 30 m 算接近邊界（R1-24）。
function nearCheck(values, limit, margin = RULE_CONSTANTS.NEAR_BOUNDARY_M) {
  const distances = values.map(nonNegInt);
  const known = distances.filter((d) => d !== null);
  if (known.length === 0) return pending("near_missing");
  const nearest = Math.min(...known);
  if (nearest === 0 || nearest < limit - margin) return PASS;
  // 另一個距離不知道時，它可能更近，所以不能判不符。
  if (known.length < distances.length) return pending("near_missing");
  if (nearest <= limit + margin) return pending("near_boundary");
  return failure("near_out");
}

// 避開 RCA：距離 ≤ rca_m 就排除（含本數）；距離 0 是在管制區裡面，一律排除。
function rcaCheck(value, limit, margin = RULE_CONSTANTS.NEAR_BOUNDARY_M) {
  const distance = nonNegInt(value);
  if (distance === null) return pending("rca_missing");
  if (distance === 0) return failure("rca_within");
  if (distance > limit + margin) return PASS;
  if (distance >= limit - margin) return pending("rca_boundary");
  return failure("rca_within");
}

// 中壢車程（門牌、網站座標或社區精度）。
// C2：drive_min 是「包含這點的最小車程檔，沒有就是 null」。所以在區內、drive_min 是 null
// 就是在每一檔之外 → 不符；drive_min 缺欄位、空字串、NaN 才是缺值。
function driveCheck(metrics, limit, precision = null) {
  if (metrics.in_district !== true) return pending("district_missing");
  if (metrics.drive_min === null) return failure("drive_out");
  const band = posInt(metrics.drive_min);
  if (band === null) return pending("drive_missing");
  // 社區精度只到社區：剛好落在所選那一檔時，那一戶可能在下一檔（修完再審 F1-9）。
  if (precision === "community" && band === limit) return pending("drive_near");
  if (band <= limit) return PASS;
  if (band <= limit + RULE_CONSTANTS.DRIVE_NEAR_BAND_MIN) return pending("drive_near");
  return failure("drive_out");
}

function roadFraction(fractions, key) {
  return fractions && hasOwn(fractions, key) ? fraction(fractions[key]) : null;
}

// 路段精度：門牌點落在範圍內的比例。≥ 90% 在內，≤ 10% 在外，其餘待確認（R3-06）。
function roadBuffer(fractions, near, rca) {
  if (near === null || rca === null) return pending("road_frac_missing");
  const share = roadFraction(fractions, `n${near}_r${rca}`);
  if (share === null) return pending("road_frac_missing");
  if (share >= RULE_CONSTANTS.ROAD_IN) return PASS;
  if (share > RULE_CONSTANTS.ROAD_OUT) return pending("loc_road_mid");
  return failure("loc_road_out");
}

function roadDrive(fractions, limit) {
  const share = roadFraction(fractions, String(limit));
  if (share === null) return pending("road_frac_missing");
  if (share >= RULE_CONSTANTS.ROAD_IN) return PASS;
  if (share > RULE_CONSTANTS.ROAD_OUT) return pending("loc_road_mid");
  // 幾乎都在所選分鐘數之外；如果下一檔有不少門牌點，就是接近車程門檻。
  const next = roadFraction(fractions, String(limit + RULE_CONSTANTS.DRIVE_NEAR_BAND_MIN));
  if (next !== null && next > RULE_CONSTANTS.ROAD_OUT) return pending("drive_near");
  return failure("loc_road_out");
}

// ---------------------------------------------------------------- 其他條件

// 成交日在最近 N 個月內（含當天往回 N 個月的那一天）。
function txMonthsCheck(rec, months, today) {
  const date = parseDate(rec.date);
  if (!date) return pending("date_missing");
  return dayKey(date) >= dayKey(addMonths(today, -months)) ? PASS : failure("tx_old");
}

// 開價：用在架刊登中最低的價格（R1-30）；總價不含車位時加上車位價（R1-13）。
function priceCheck(rec, facts, capWan) {
  const cap = Math.round(capWan * 10000);
  let price = nonNegInt(rec.price_min);
  if (price === null && rec.status === "gone" && Array.isArray(rec.members)) {
    // 下架的群組沒有在架成員，改用各刊登最後的價格。
    const prices = rec.members
      .map((member) => (isObject(member) ? nonNegInt(member.price) : null))
      .filter((value) => value !== null);
    if (prices.length) price = Math.min(...prices);
  }
  if (price === null) return pending("price_missing");
  if (price > cap) return failure("price_over");
  const excluded = facts.price_excl_parking;
  if (isConflict(excluded)) return pending("group_conflict");
  if (excluded === true) {
    if (isConflict(facts.parking_price_yuan)) return pending("group_conflict");
    const parkingPrice = nonNegInt(facts.parking_price_yuan);
    if (parkingPrice === null) return pending("parking_price_missing");
    return price + parkingPrice <= cap ? PASS : failure("price_over");
  }
  if (excluded === false || facts.parking === "none") return PASS;
  return pending("price_excl_parking_missing");
}

// 屋齡在 [a, b) 年：完工日 d 滿 a 年（d + a 年 ≤ 基準日），而且未滿 b 年（基準日 < d + b 年）。
// 完工日是區間 [lo, hi]：區間內每一天都成立 → 符合；每一天都不成立 → 不符；其他 → 待確認（r4 §3.10）。
function ageCheck(loRaw, hiRaw, years, ref) {
  if (isConflict(loRaw) || isConflict(hiRaw)) return pending("group_conflict");
  const [minYears, maxYears] = years;
  let lo = parseDate(loRaw);
  let hi = parseDate(hiRaw);
  if (lo && hi && dayKey(lo) > dayKey(hi)) {
    lo = null;
    hi = null;
  }
  if (!lo && !hi) return pending("built_missing");
  const at = dayKey(ref);
  if (lo && dayKey(addYears(lo, minYears)) > at) return failure("age_under");
  if (hi && dayKey(addYears(hi, maxYears)) <= at) return failure("age_over");
  if (!lo || !hi) return pending("built_missing");
  if (dayKey(addYears(hi, minYears)) <= at && at < dayKey(addYears(lo, maxYears))) return PASS;
  return pending("age_boundary");
}

// 樓層：這一戶的每一層都要在 [lo, hi] 內（DESIGN 4-4）。
function floorCheck(loRaw, hiRaw, range) {
  if (isConflict(loRaw) || isConflict(hiRaw)) return pending("group_conflict");
  const [low, high] = range;
  const lo = intValue(loRaw);
  const hi = intValue(hiRaw);
  if (lo === null && hi === null) return pending("floor_missing");
  if ([lo, hi].some((floor) => floor !== null && (floor < low || floor > high))) {
    return failure("floor_out");
  }
  if (lo === null || hi === null || lo > hi) return pending("floor_missing");
  return PASS;
}

// 開價物件的主建物（0.01 坪）。網站顯示值剛好等於門檻時可能是進位來的 → 待確認（R3-10）。
// 網站只顯示到 0.1 坪時（數值是 0.1 坪的整數倍），真正的值可能差 ±0.05 坪（事後審查 P-7）。
function displayedSlack(cp) {
  return cp % 10 === 0 ? 5 : 0;
}

function mainListingCheck(facts, minPing) {
  const threshold = Math.round(minPing * 100);
  if (isConflict(facts.main_cp) || isConflict(facts.main_kind)) return pending("group_conflict");
  const value = nonNegInt(facts.main_cp);
  if (value === null) {
    // 權狀坪一定 ≥ 主建物；權狀都不到門檻，主建物就一定不到。
    const titleArea = nonNegInt(facts.title_area_cp);
    if (titleArea !== null && titleArea + displayedSlack(titleArea) < threshold) return failure("main_under");
    return pending("main_missing");
  }
  const slack = displayedSlack(value);
  // 不論口徑（主建物或主建物＋附屬），數值都 ≥ 真正的主建物；數值不到門檻就一定不符。
  if (value + slack < threshold) return failure("main_under");
  const kind = enumValue("MainKind", facts.main_kind);
  if (kind === null) return pending("main_kind_missing");
  if (kind === "main_plus_aux") return pending("main_plus_aux");
  if (value - slack <= threshold && value + slack >= threshold) return pending("main_boundary");
  return PASS;
}

// 成交的主建物（0.01 m²）：121 × K ≥ 400 × S100（R3-10）。
function mainTxCheck(rec, minPing) {
  const area = nonNegInt(rec.main_cm2);
  if (area === null) return pending("main_missing");
  const threshold = BigInt(Math.round(minPing * 100));
  return 121n * BigInt(area) >= 400n * threshold ? PASS : failure("main_under");
}

// 電梯（DESIGN 4-6、R1-16）：推定有電梯算不算通過，由條件的 inferred_ok 決定。
function elevatorCheck(raw, preference) {
  if (isConflict(raw)) return pending("group_conflict");
  const value = enumValue("Elevator", raw);
  if (value === null || value === "unknown") return pending("elevator_missing");
  if (value === "yes") return PASS;
  if (value === "no") return failure("elevator_no");
  return preference.inferred_ok ? PASS : pending("elevator_inferred");
}

function acceptedParking(profile) {
  const accepted = new Set(profile.parking_ok ?? []);
  if (profile.lift_flat_ok === true) accepted.add("lift_flat");
  return accepted;
}

// 一種車位類型對「可接受的類型」的結果（R1-12）。
// - 平面但出入方式不明：坡道、一樓、升降三種都可以接受 → 符合；只接受其中幾種 → 待確認。
// - 混合（含平面）：至少有一個車位可以接受就算符合；平面那個的出入方式不明時同上。
function parkingKindResult(kind, accepted) {
  if (kind === "unknown") return pending("parking_missing");
  if (accepted.has(kind)) return PASS;
  if (kind === "mixed_with_flat" && accepted.has("mechanical")) return PASS;
  if (kind === "flat_unknown_access" || kind === "mixed_with_flat") {
    const flats = FLAT_KINDS.filter((flat) => accepted.has(flat)).length;
    if (flats === FLAT_KINDS.length) return PASS;
    if (flats > 0) return pending("parking_flat_access");
    return failure("parking_not_ok");
  }
  if (kind === "mixed_no_flat" && accepted.has("mechanical")) return PASS;
  return failure("parking_not_ok");
}

function parkingListingCheck(facts, accepted) {
  if (isConflict(facts.parking)) return pending("group_conflict");
  const kind = enumValue("Parking", facts.parking);
  if (kind === null) return pending("parking_missing");
  const result = parkingKindResult(kind, accepted);
  if (result.r !== "pass" || kind === "none") return result;
  // 公有車位常是抽籤或輪停，不一定真的有車位可用 → 待確認（R1-12）。
  if (isConflict(facts.parking_public)) return pending("group_conflict");
  return facts.parking_public === true ? pending("parking_public") : PASS;
}

// 成交可能有好幾個車位：只要有一個可以接受就算符合；沒有車位就當成「無」。
function parkingTxCheck(spaces, accepted) {
  if (!Array.isArray(spaces)) return pending("parking_missing");
  if (spaces.length === 0) return parkingKindResult("none", accepted);
  const results = spaces.map((space) => {
    const kind = isObject(space) ? enumValue("Parking", space.ptype) : null;
    return kind === null ? pending("parking_missing") : parkingKindResult(kind, accepted);
  });
  return (
    results.find((result) => result.r === "pass") ??
    results.find((result) => result.r === "pending") ??
    failure("parking_not_ok")
  );
}

// 扣車位單價 ≤ U 萬／坪 ⇔ 400 × Q ≤ 121 × U100 × K（R3-10）。
// q、k 是區間：上界＝q_hi / k_lo，下界＝q_lo / k_hi（交叉配對，r4 §2.2 #4）。
function unitPriceCheck(up, capWan) {
  const range = unitPriceInputs(up);
  if (!range) return pending("up_missing");
  const cap = BigInt(Math.round(capWan * 100));
  if (400n * BigInt(range.qHi) <= 121n * cap * BigInt(range.kLo)) return PASS;
  if (400n * BigInt(range.qLo) > 121n * cap * BigInt(range.kHi)) return failure("up_over");
  return pending("up_range");
}

function unitPriceInputs(up) {
  if (!isObject(up) || (up.basis !== "official" && up.basis !== "estimated")) return null;
  const qLo = nonNegInt(up.q_lo);
  const qHi = nonNegInt(up.q_hi);
  const kLo = posInt(up.k_lo);
  const kHi = posInt(up.k_hi);
  if (qLo === null || qHi === null || kLo === null || kHi === null) return null;
  if (qLo > qHi || kLo > kHi) return null;
  return { qLo, qHi, kLo, kHi };
}

// ---------------------------------------------------------------- evaluate（C4）

const checkedProfiles = new WeakMap();

function checkedProfile(profile) {
  if (!isObject(profile)) throw new TypeError("profile 必須是物件");
  let normalized = checkedProfiles.get(profile);
  if (!normalized) {
    try {
      normalized = validateProfile(profile, 0, null);
    } catch (error) {
      if (error instanceof ProfileError) throw new TypeError(`profile 不合格式：${error.message}`);
      throw error;
    }
    checkedProfiles.set(profile, normalized);
  }
  return normalized;
}

function combine(results) {
  for (const status of ["fail", "pending"]) {
    const codes = [...new Set(results.filter((result) => result.r === status).map((result) => result.code))];
    if (codes.length) return { status, reasons: codes };
  }
  return { status: "match", reasons: [] };
}

/**
 * 判定一筆紀錄對一組條件的結果（C4）。
 *
 * 順序：區域不符 → fail（area_mismatch），其他條件都不看；
 * 任一條不符 → fail；否則任一條待確認 → pending；否則 match。
 * reasons 只列決定狀態的那一類代碼，依條件的固定順序：
 * 位置、成交月數、開價、屋齡、樓層、主建物、電梯、車位、扣車位單價。
 *
 * - 開價上限只套用在開價物件；單價上限與成交月數只套用在成交（R1-23）。
 * - 屋齡的基準日：開價物件是 today；成交是成交日（成交當時的屋齡）。
 * - 條件沒設定（null 或沒有這個鍵）的那一條不評估。條件本身不合格式時丟出 TypeError。
 *
 * @param {"listing"|"tx"} kind
 * @param {object} rec 匯出紀錄：listings 檔的一個 group，或 tx 檔的一筆；
 *   另外帶 `area`，也就是它所在資料檔的區域 id。
 * @param {object} profile 一組條件（C3）。
 * @param {string} today 台北日期，YYYY-MM-DD。
 * @returns {{status: "match"|"pending"|"fail", reasons: string[]}}
 */
export function evaluate(kind, rec, profile, today) {
  if (kind !== "listing" && kind !== "tx") throw new TypeError("kind 必須是 listing 或 tx");
  const ref = parseDate(today);
  if (!ref) throw new TypeError("today 必須是 YYYY-MM-DD");
  if (!isObject(rec)) throw new TypeError("rec 必須是物件");
  const p = checkedProfile(profile);
  if (typeof rec.area !== "string" || rec.area !== p.area) {
    return { status: "fail", reasons: ["area_mismatch"] };
  }

  const facts = kind === "listing" ? (isObject(rec.facts) ? rec.facts : {}) : rec;
  const results = locationResults(kind, rec, p);
  if (kind === "tx" && p.tx_months !== null) results.push(txMonthsCheck(rec, p.tx_months, ref));
  if (kind === "listing" && p.price_max_wan !== null) {
    results.push(priceCheck(rec, facts, p.price_max_wan));
  }
  if (p.built_years !== null) {
    const at = kind === "tx" ? parseDate(rec.date) : ref;
    results.push(at ? ageCheck(facts.built_lo, facts.built_hi, p.built_years, at) : pending("date_missing"));
  }
  if (p.floor !== null) results.push(floorCheck(facts.floor_lo, facts.floor_hi, p.floor));
  if (p.main_min_ping !== null) {
    results.push(kind === "tx" ? mainTxCheck(rec, p.main_min_ping) : mainListingCheck(facts, p.main_min_ping));
  }
  if (p.elevator !== null && p.elevator.required) results.push(elevatorCheck(facts.elevator, p.elevator));
  const accepted = acceptedParking(p);
  if (accepted.size > 0) {
    results.push(kind === "tx" ? parkingTxCheck(rec.parking, accepted) : parkingListingCheck(facts, accepted));
  }
  if (kind === "tx" && p.unit_price_max_wan !== null) {
    results.push(unitPriceCheck(rec.up, p.unit_price_max_wan));
  }
  return combine(results);
}

/** 條件屬於哪一種區域門檻："buffer"（周邊＋RCA）、"drive"（車程）或 null。 */
export function profileAreaKind(profile) {
  if (!isObject(profile)) return null;
  if (profile.drive_min !== null && profile.drive_min !== undefined) return "drive";
  if (profile.near_m !== null && profile.near_m !== undefined) return "buffer";
  if (profile.rca_m !== null && profile.rca_m !== undefined) return "buffer";
  return null;
}

// ---------------------------------------------------------------- 條件（C3）

class ProfileError extends Error {}

// 控制字元、換行與會改變文字方向的字元都不收（名稱只用 textContent 顯示，這是避免畫面混淆）。
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const AREA_CODE = /^[a-z][a-z0-9_]{0,39}$/;

function isDecimal2(value, max) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= max &&
    Math.abs(value * 100 - Math.round(value * 100)) < 1e-6
  );
}

function isIntIn(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function intPair(value, min, max, strict) {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [lo, hi] = value;
  if (!isIntIn(lo, min, max) || !isIntIn(hi, min, max)) return null;
  if (strict ? lo >= hi : lo > hi) return null;
  return Object.freeze([lo, hi]);
}

function validateProfile(raw, index, areas) {
  const where = `第 ${index + 1} 組條件`;
  const bad = (what) => {
    throw new ProfileError(`${where}：${what}`);
  };
  if (!isPlainObject(raw)) bad("格式不對");
  // 錯誤訊息不引用外來內容（鍵名、值），只說哪一組、哪一類錯（R2-01）。
  if (Object.keys(raw).some((key) => !PROFILE_KEYS.includes(key))) bad("有不認得的欄位");
  const get = (key) => (raw[key] === undefined || raw[key] === null ? null : raw[key]);
  const out = {};

  const name = raw.name;
  if (typeof name !== "string" || name.length < 1 || name.length > 40) bad("名稱要 1–40 個字");
  if (name.trim() !== name || UNSAFE_TEXT.test(name)) bad("名稱前後不能有空白，也不能有控制字元");
  out.name = name;

  if (typeof raw.area !== "string" || !AREA_CODE.test(raw.area)) bad("區域代號不對");
  out.area = raw.area;

  out.price_max_wan = get("price_max_wan");
  if (out.price_max_wan !== null && !isDecimal2(out.price_max_wan, 100000)) {
    bad("開價上限要是大於 0 的數字（萬元，最多兩位小數）");
  }

  out.built_years = get("built_years");
  if (out.built_years !== null) {
    out.built_years = intPair(out.built_years, 0, 100, true);
    if (!out.built_years) bad("屋齡要是 [滿幾年, 未滿幾年] 兩個整數，而且前者較小");
  }

  out.floor = get("floor");
  if (out.floor !== null) {
    out.floor = intPair(out.floor, -10, 200, false);
    if (!out.floor) bad("樓層要是 [最低, 最高] 兩個整數");
  }

  out.main_min_ping = get("main_min_ping");
  if (out.main_min_ping !== null && !isDecimal2(out.main_min_ping, 1000)) {
    bad("主建物下限要是大於 0 的數字（坪，最多兩位小數）");
  }

  const elevator = get("elevator");
  if (elevator === null) {
    out.elevator = null;
  } else {
    const keys = isPlainObject(elevator) ? Object.keys(elevator).sort().join(",") : "";
    if (
      keys !== "inferred_ok,required" ||
      typeof elevator.required !== "boolean" ||
      typeof elevator.inferred_ok !== "boolean"
    ) {
      bad("電梯要寫成 {required, inferred_ok} 兩個是非值");
    }
    out.elevator = Object.freeze({ required: elevator.required, inferred_ok: elevator.inferred_ok });
  }

  const parking = get("parking_ok");
  if (parking === null) {
    out.parking_ok = null;
  } else {
    if (
      !Array.isArray(parking) ||
      parking.some((kind) => !PARKING_CHOICES.includes(kind)) ||
      new Set(parking).size !== parking.length
    ) {
      bad("可接受的車位類型不對（升降平面請用另一個選項）");
    }
    out.parking_ok = Object.freeze([...parking]);
  }

  out.lift_flat_ok = get("lift_flat_ok");
  if (out.lift_flat_ok !== null && typeof out.lift_flat_ok !== "boolean") bad("升降平面選項要是是非值");

  out.near_m = get("near_m");
  out.rca_m = get("rca_m");
  out.drive_min = get("drive_min");
  if (out.near_m !== null && !isIntIn(out.near_m, 0, 100000)) bad("周邊距離要是整數公尺");
  if (out.rca_m !== null && !isIntIn(out.rca_m, 0, 100000)) bad("避開 RCA 距離要是整數公尺");
  if (out.drive_min !== null && !isIntIn(out.drive_min, 1, 120)) bad("車程要是整數分鐘");

  out.unit_price_max_wan = get("unit_price_max_wan");
  if (out.unit_price_max_wan !== null && !isDecimal2(out.unit_price_max_wan, 10000)) {
    bad("單價上限要是大於 0 的數字（萬元／坪，最多兩位小數）");
  }

  out.tx_months = get("tx_months");
  if (out.tx_months !== null && !isIntIn(out.tx_months, 1, 240)) bad("成交月數要是 1–240 的整數");

  const hasBuffer = out.near_m !== null || out.rca_m !== null;
  const hasDrive = out.drive_min !== null;
  if (hasBuffer && hasDrive) bad("周邊／RCA 門檻和車程門檻不能放在同一組");
  if (hasBuffer && (out.near_m === null || out.rca_m === null)) bad("周邊距離和避開 RCA 距離要一起設定");
  if (!hasBuffer && !hasDrive) bad("缺少區域門檻");

  if (areas) {
    const area = areas.find((item) => isObject(item) && item.id === out.area);
    if (!area) bad("條件指向不存在的區域");
    const kind = hasDrive ? "drive" : "buffer";
    if (area.kind !== kind) bad("門檻和區域的種類不符");
    const options = isObject(area.options) ? area.options : {};
    for (const key of kind === "drive" ? ["drive_min"] : ["near_m", "rca_m"]) {
      if (!Array.isArray(options[key]) || !options[key].includes(out[key])) {
        bad("門檻不在這個區域的選項裡");
      }
    }
  }
  return Object.freeze(out);
}

function readRoot(data, areas) {
  if (!isPlainObject(data)) throw new ProfileError("條件格式不對");
  const keys = Object.keys(data);
  if (keys.length !== 2 || !hasOwn(data, "v") || !hasOwn(data, "profiles")) {
    throw new ProfileError("條件格式不對（只能有 v 與 profiles）");
  }
  if (data.v !== PROFILE_VERSION) {
    throw new ProfileError(`條件版本不符：這個網頁只認得第 ${PROFILE_VERSION} 版`);
  }
  if (!Array.isArray(data.profiles)) throw new ProfileError("profiles 要是清單");
  if (data.profiles.length > MAX_PROFILES) throw new ProfileError(`最多 ${MAX_PROFILES} 組條件`);
  const profiles = data.profiles.map((item, index) => validateProfile(item, index, areas));
  const names = new Set();
  for (const profile of profiles) {
    if (names.has(profile.name)) throw new ProfileError("條件名稱重複");
    names.add(profile.name);
  }
  return Object.freeze(profiles);
}

/**
 * 解析分享片段或 localStorage 的內容（C3：{v: 1, profiles: [...]}）。
 * 有任何不認得的鍵、不合法的值或版本不符，就整份拒絕（r4 §2.2 #8）。
 *
 * @param {string} str
 * @param {{areas?: object[]}} [opts] 傳入 meta.json 的 areas 時，另外檢查區域代號、
 *   區域種類，以及門檻是不是該區域的選項（R3-16）。
 * @returns {{ok: true, profiles: object[]} | {ok: false, error: string}}
 *   profiles 是正規化後的條件：每個鍵都在，沒設定的是 null。
 */
export function parseProfiles(str, opts = {}) {
  try {
    if (typeof str !== "string") throw new ProfileError("條件不是文字");
    if (str.length > MAX_PROFILE_TEXT) throw new ProfileError("條件太長");
    let data;
    try {
      data = JSON.parse(str);
    } catch {
      throw new ProfileError("條件不是合法的 JSON");
    }
    return { ok: true, profiles: readRoot(data, opts.areas ?? null) };
  } catch (error) {
    if (error instanceof ProfileError) return { ok: false, error: error.message };
    throw error;
  }
}

function compactProfile(profile) {
  const out = {};
  for (const key of PROFILE_KEYS) {
    const value = profile[key];
    if (value === null) continue;
    if (key === "elevator") out[key] = { required: value.required, inferred_ok: value.inferred_ok };
    else out[key] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}

/**
 * 把條件寫成分享片段與 localStorage 用的字串（C3）。
 * 先用和 parseProfiles() 相同的規則檢查，不合格式就丟出 Error，不會默默丟掉任何條件
 * （例如 NaN 不會被寫成 null）。沒設定的鍵不寫出來；鍵的順序固定。
 *
 * @param {{v: 1, profiles: object[]}} obj
 * @param {{areas?: object[]}} [opts]
 * @returns {string}
 */
export function serializeProfiles(obj, opts = {}) {
  let profiles;
  try {
    profiles = readRoot(obj, opts.areas ?? null);
  } catch (error) {
    if (error instanceof ProfileError) throw new Error(error.message);
    throw error;
  }
  if (JSON.stringify(profiles).length > MAX_PROFILE_TEXT) throw new Error("條件太長");
  return JSON.stringify({ v: PROFILE_VERSION, profiles: profiles.map(compactProfile) });
}

// ---------------------------------------------------------------- 分享片段 #p=<base64url(JSON)>

function base64urlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(body) {
  if (body.length % 4 === 1) throw new Error("長度不對");
  const padded = body.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((body.length + 3) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** 產生分享片段（含開頭的 #）。條件不合格式時丟出 Error。 */
export function profilesToFragment(obj, opts = {}) {
  return FRAGMENT_PREFIX + base64urlEncode(serializeProfiles(obj, opts));
}

/**
 * 讀網址的 # 片段。沒有 #p= 時回 {present: false}；
 * 有的話回 {present: true, ok: true, text}（再交給 parseProfiles）或 {present: true, ok: false, error}。
 * 錯誤訊息不包含片段的內容。
 */
export function readFragment(hash) {
  if (typeof hash !== "string" || !hash.startsWith(FRAGMENT_PREFIX)) return { present: false };
  const body = hash.slice(FRAGMENT_PREFIX.length);
  const invalid = { present: true, ok: false, error: "連結裡的條件格式不對" };
  if (body.length === 0 || body.length > MAX_FRAGMENT || !/^[A-Za-z0-9_-]+$/.test(body)) return invalid;
  try {
    return { present: true, ok: true, text: base64urlDecode(body) };
  } catch {
    return invalid;
  }
}

// ---------------------------------------------------------------- 資料新鮮度（R1-17、R2-15）

function timestamp(value) {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * 各來源與資料集的新鮮度，依 meta.freshness_hours 的門檻與現在時間判斷。
 * stale：true 過期（或從來沒成功過）、false 正常、null 沒有門檻可以判斷。
 * generated 是網站資料最後一次產生的時間，門檻用各來源門檻的最小值。
 */
export function freshness(meta, nowMs) {
  const hours = isObject(meta) && isObject(meta.freshness_hours) ? meta.freshness_hours : {};
  const limitOf = (id) => (hasOwn(hours, id) && posInt(hours[id]) !== null ? hours[id] : null);
  const judge = (time, limit) => {
    const ageHours = time === null ? null : (nowMs - time) / 3600000;
    return { ageHours, stale: limit === null ? null : time === null || ageHours > limit };
  };

  const sourceList = isObject(meta) && Array.isArray(meta.sources) ? meta.sources.filter(isObject) : [];
  const sources = sourceList.map((source) => {
    const id = typeof source.id === "string" ? source.id : "";
    const lastOk = timestamp(source.last_ok);
    const pausedUntil = timestamp(source.paused_until);
    const limitHours = limitOf(id);
    return {
      id,
      publish: source.publish === true,
      lastOk,
      lastFullOk: timestamp(source.last_full_ok),
      pausedUntil,
      paused: pausedUntil !== null && pausedUntil > nowMs,
      errorCode: typeof source.error_code === "string" ? source.error_code : null,
      limitHours,
      ...judge(lastOk, limitHours),
    };
  });

  const datasetsRaw = isObject(meta) && isObject(meta.datasets) ? meta.datasets : {};
  const lvr = isObject(datasetsRaw.lvr) ? datasetsRaw.lvr : {};
  const door = isObject(datasetsRaw.doorindex) ? datasetsRaw.doorindex : {};
  const lvrCheck = timestamp(lvr.last_check);
  const doorCheck = timestamp(door.last_check);
  const datasets = [
    {
      id: "lvr",
      lastCheck: lvrCheck,
      asOf: parseDate(lvr.as_of) ? lvr.as_of : null,
      limitHours: limitOf("lvr"),
      ...judge(lvrCheck, limitOf("lvr")),
    },
    {
      id: "doorindex",
      lastCheck: doorCheck,
      version: typeof door.version === "string" ? door.version : null,
      limitHours: limitOf("doorindex"),
      ...judge(doorCheck, limitOf("doorindex")),
    },
  ];

  const generatedAt = isObject(meta) ? timestamp(meta.generated_at) : null;
  const sourceLimits = sources.map((source) => source.limitHours).filter((limit) => limit !== null);
  const generatedLimit = sourceLimits.length ? Math.min(...sourceLimits) : limitOf("lvr");
  return {
    generated: { at: generatedAt, limitHours: generatedLimit, ...judge(generatedAt, generatedLimit) },
    sources,
    datasets,
  };
}

// ---------------------------------------------------------------- 單價、距離、比價（R1-23）

/**
 * 扣車位單價（萬／坪），只給顯示與比價用，不用來判定門檻。
 * 區間用交叉配對：lo＝q_lo / k_hi，hi＝q_hi / k_lo；mid 用 q 與 k 各自的中點。
 */
export function unitPriceRange(up) {
  const range = unitPriceInputs(up);
  if (!range) return null;
  const wanPerPing = (q, k) => (4 * q) / (121 * k);
  return {
    basis: up.basis,
    lo: wanPerPing(range.qLo, range.kHi),
    hi: wanPerPing(range.qHi, range.kLo),
    mid: wanPerPing((range.qLo + range.qHi) / 2, (range.kLo + range.kHi) / 2),
  };
}

/** 兩點的大圓距離（公尺）。 */
export function distanceM(lat1, lon1, lat2, lon2) {
  const radius = 6371008.8;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const POINT_PRECISIONS = ["site", "door"];

/**
 * 比價：開價物件 300 m 內、完工日相差 3 年內、最近 N 個月的成交（R1-23）。
 * 只對網站座標或門牌精度的物件做，成交也只用這兩種精度。
 * 回傳樣本數與兩種中位數：含估算（官方拆價＋估算，估算取中點）與不含估算。
 *
 * @returns {{ok: false, reason: "precision"|"built"} |
 *   {ok: true, n, nOfficial, medianAll, medianOfficial, items: [{tx, distanceM, unit, basis}]}}
 */
export function comps(listing, txs, { today, months = RULE_CONSTANTS.COMPS_DEFAULT_MONTHS } = {}) {
  const ref = parseDate(today);
  if (!ref) throw new TypeError("today 必須是 YYYY-MM-DD");
  const loc = isObject(listing) && isObject(listing.loc) ? listing.loc : null;
  if (!loc || !POINT_PRECISIONS.includes(loc.precision) || !isLatLon(loc.lat, loc.lon)) {
    return { ok: false, reason: "precision" };
  }
  const facts = isObject(listing.facts) ? listing.facts : {};
  const lo = parseDate(facts.built_lo);
  const hi = parseDate(facts.built_hi);
  if (!lo || !hi) return { ok: false, reason: "built" };

  const years = RULE_CONSTANTS.COMPS_YEARS;
  const cutoff = dayKey(addMonths(ref, -months));
  const items = [];
  for (const tx of Array.isArray(txs) ? txs : []) {
    if (!isObject(tx) || !POINT_PRECISIONS.includes(tx.precision) || !isLatLon(tx.lat, tx.lon)) continue;
    const date = parseDate(tx.date);
    if (!date || dayKey(date) < cutoff) continue;
    const txLo = parseDate(tx.built_lo);
    const txHi = parseDate(tx.built_hi);
    if (!txLo || !txHi) continue;
    if (dayKey(addYears(txLo, -years)) > dayKey(hi) || dayKey(lo) > dayKey(addYears(txHi, years))) continue;
    const distance = distanceM(loc.lat, loc.lon, tx.lat, tx.lon);
    if (distance > RULE_CONSTANTS.COMPS_RADIUS_M) continue;
    const unit = unitPriceRange(tx.up);
    if (!unit) continue;
    items.push({ tx, distanceM: Math.round(distance), unit: unit.mid, basis: unit.basis });
  }
  items.sort((a, b) => a.distanceM - b.distanceM || String(a.tx.serial).localeCompare(String(b.tx.serial)));
  const all = items.map((item) => item.unit);
  const official = items.filter((item) => item.basis === "official").map((item) => item.unit);
  return {
    ok: true,
    n: all.length,
    nOfficial: official.length,
    medianAll: median(all),
    medianOfficial: median(official),
    items,
  };
}

// ---------------------------------------------------------------- 徽章

function within(iso, hours, nowMs) {
  const time = timestamp(iso);
  return time !== null && time <= nowMs + 60000 && nowMs - time <= hours * 3600000;
}

/**
 * 開價物件的徽章代碼。新上架、重新上架依首次出現時間在瀏覽器計算（R1-09）；
 * 基準（第一次回填）的群組不標新上架。降價只看同一筆刊登的價格歷史，
 * 不看站方標示的原價（R1-22）。
 */
export function listingBadges(group, nowMs) {
  const badges = [];
  if (!isObject(group)) return badges;
  const hours = RULE_CONSTANTS.NEW_BADGE_HOURS;
  if (group.status === "gone") {
    badges.push("gone");
  } else {
    if (group.baseline !== true && within(group.first_seen, hours, nowMs)) badges.push("new");
    if (within(group.relisted_at, hours, nowMs)) badges.push("relisted");
  }
  const members = Array.isArray(group.members) ? group.members.filter(isObject) : [];
  const dropped = members.some((member) => {
    const price = nonNegInt(member.price);
    const first = nonNegInt(member.price_first);
    return (
      member.status === "active" &&
      price !== null &&
      first !== null &&
      first - price >= RULE_CONSTANTS.PRICE_MIN_STEP_YUAN
    );
  });
  if (dropped) badges.push("price_drop");
  const facts = isObject(group.facts) ? group.facts : {};
  if (facts.elevator === "inferred") badges.push("inferred_elevator");
  if (facts.parking === "lift_flat") badges.push("lift_flat");
  if (facts.parking === "mixed_with_flat" || facts.parking === "mixed_no_flat") badges.push("mixed_parking");
  if (isObject(group.conflicts) && Object.keys(group.conflicts).length > 0) badges.push("conflict");
  const precision = isObject(group.loc) ? group.loc.precision : null;
  if (precision === "road" || precision === "community") badges.push("approx_location");
  return badges;
}

/** 成交的徽章代碼。 */
export function txBadges(tx) {
  const badges = [];
  if (!isObject(tx)) return badges;
  if (isObject(tx.up) && tx.up.basis === "estimated") badges.push("estimated");
  if (tx.elevator === "inferred") badges.push("inferred_elevator");
  if (Array.isArray(tx.parking) && tx.parking.some((space) => isObject(space) && space.ptype === "lift_flat")) {
    badges.push("lift_flat");
  }
  if (tx.precision === "road" || tx.precision === "community") badges.push("approx_location");
  return badges;
}

/** 這些原因代碼在網頁上另外標「接近門檻」。 */
export const NEAR_THRESHOLD_REASONS = Object.freeze(["near_boundary", "rca_boundary", "drive_near"]);

// ---------------------------------------------------------------- 顯示文字

/** 每個原因代碼在網頁上的說明。 */
export const REASON_LABELS = deepFreeze({
  area_mismatch: "不是這組條件的區域",
  loc_missing: "定位不到",
  loc_conflict: "位置的證據互相矛盾",
  district_out: "不在這個區域查詢的行政區內",
  district_missing: "不知道在不在行政區內",
  near_missing: "缺到特區的距離",
  near_boundary: "接近周邊距離的邊界（±30 公尺內）",
  near_out: "超出周邊距離",
  rca_missing: "缺到 RCA 管制區的距離",
  rca_boundary: "接近避開 RCA 距離的邊界（±30 公尺內）",
  rca_within: "在避開 RCA 的距離內",
  road_frac_missing: "位置只到路段，缺門牌點比例",
  loc_road_mid: "位置只到路段，路上的門牌點只有一部分在範圍內",
  loc_road_out: "位置只到路段，路上的門牌點幾乎都在範圍外",
  drive_missing: "缺車程資料",
  drive_near: "接近車程門檻：超出所選分鐘數，但在下一檔內（另一個路線引擎普遍快約 2 分鐘）",
  drive_out: "超出車程範圍",
  date_missing: "缺成交日",
  tx_old: "成交日早於所選的月數",
  price_missing: "缺開價",
  price_over: "開價超過上限",
  price_excl_parking_missing: "不知道開價含不含車位",
  parking_price_missing: "車位另計，但缺車位價",
  built_missing: "完工日不明或不完整",
  age_boundary: "完工日只知道區間，屋齡跨過邊界",
  age_under: "屋齡未達下限",
  age_over: "屋齡超過上限",
  floor_missing: "缺樓層",
  floor_out: "樓層不在範圍內",
  main_missing: "缺主建物坪數",
  main_under: "主建物不到下限",
  main_boundary: "主建物剛好等於下限（網站顯示值可能是進位的）",
  main_plus_aux: "坪數含附屬建物，主建物可能不到下限",
  main_kind_missing: "坪數的口徑不明",
  elevator_missing: "電梯不明",
  elevator_no: "沒有電梯",
  elevator_inferred: "電梯是依建物型態推定的",
  parking_missing: "車位類型不明",
  parking_not_ok: "車位類型不符",
  parking_flat_access: "平面車位，但不知道是坡道還是升降",
  parking_public: "公有車位（可能是抽籤或輪停）",
  up_missing: "算不出扣車位單價",
  up_over: "扣車位單價超過上限",
  up_range: "扣車位單價是估算區間，跨過上限",
  group_conflict: "各網站的資料互相矛盾",
});

/** 徽章代碼的顯示文字。 */
export const BADGE_LABELS = deepFreeze({
  new: "新上架",
  relisted: "重新上架",
  gone: "下架（列表連續兩次未見）",
  price_drop: "降價",
  inferred_elevator: "推定電梯",
  lift_flat: "升降平面",
  mixed_parking: "混合車位",
  conflict: "各站資料不一",
  approx_location: "位置只到路段或社區",
  estimated: "估算",
  near_threshold: "接近門檻",
});

// ---------------------------------------------------------------- 案例表（node --test 與 selftest.html 共用）

/** 跑一份案例表（C4 格式），回傳每筆的結果；不丟例外。 */
export function runCases(table) {
  const cases = isObject(table) && Array.isArray(table.cases) ? table.cases : [];
  return cases.map((item) => {
    let got;
    try {
      got = evaluate(item.kind, item.rec, item.profile, item.today);
    } catch (error) {
      got = { status: "error", reasons: [String(error && error.message)] };
    }
    const expect = item.expect;
    const ok =
      isObject(expect) &&
      got.status === expect.status &&
      Array.isArray(expect.reasons) &&
      got.reasons.length === expect.reasons.length &&
      got.reasons.every((reason, index) => reason === expect.reasons[index]);
    return { name: item.name, ok, got, expect };
  });
}

function findEmptyValue(value, path) {
  if (value === "") return path;
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const found = findEmptyValue(child, [...path, key]);
      if (found) return found;
    }
  }
  return null;
}

/**
 * JSON 放不進 NaN 與 Infinity，所以由案例表在記憶體裡推出這兩種缺值案例（R3-02）：
 * 每筆 *_empty 案例把空字串換成 NaN、Infinity，預期結果和同名的 *_absent 案例相同。
 */
export function nanCases(table) {
  const cases = isObject(table) && Array.isArray(table.cases) ? table.cases : [];
  const byName = new Map(cases.map((item) => [item.name, item]));
  const derived = [];
  for (const item of cases) {
    if (typeof item.name !== "string" || !item.name.endsWith("_empty")) continue;
    const absent = byName.get(`${item.name.slice(0, -"_empty".length)}_absent`);
    const path = findEmptyValue(item.rec, []);
    if (!absent || !path) continue;
    for (const [label, value] of [
      ["nan", Number.NaN],
      ["infinity", Number.POSITIVE_INFINITY],
    ]) {
      const rec = structuredClone(item.rec);
      let target = rec;
      for (const key of path.slice(0, -1)) target = target[key];
      target[path[path.length - 1]] = value;
      derived.push({ ...item, name: `${item.name.slice(0, -"_empty".length)}_${label}`, rec, expect: absent.expect });
    }
  }
  return derived;
}
