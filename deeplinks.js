// house_watch 的外部網址（R2-01、R2-04）。ES module，不碰 DOM、不發任何請求。
//
// - 物件連結：一律用「來源＋編號」套各站固定的網址樣板產生，不用抓到的網址。
//   編號先用各站的格式檢查；只允許 https 與下面列出的主機。
// - 591、信義的搜尋網址：只在瀏覽器裡，依使用者目前的條件組出來（Python 不產生）。
//   這兩站的條款禁止自動抓取，所以只給按鈕，由使用者自己點開；程式不連這兩站。
//   參數名稱與格式照 research R2a §3.2（591）與 R2b §3.5（信義）的紀錄；
//   沒有記錄、沒有驗證過的篩選（例如信義的屋齡、樓層）一律不帶。
// - 連結都加 rel="noopener noreferrer"，不讓售屋網站收到本站的網址（R2-01）。

export const LINK_REL = "noopener noreferrer";

// 物件頁的網址樣板（R2a §4、R2b §3）。樂屋的社區網址需要社區 id，這裡只有物件編號，
// 所以用 www 主機的物件網址，網站會自己轉到社區頁。
const SOURCES = Object.freeze({
  cthouse: {
    label: "中信房屋",
    id: /^[0-9]{1,15}$/,
    url: (id) => `https://buy.cthouse.com.tw/house/${id}.html`,
  },
  hbhousing: {
    label: "住商不動產",
    id: /^[A-Za-z0-9]{1,20}$/,
    url: (id) => `https://www.hbhousing.com.tw/detail?sn=${id}`,
  },
  rakuya: {
    label: "樂屋網",
    id: /^[A-Za-z0-9]{1,32}$/,
    url: (id) => `https://www.rakuya.com.tw/sell_item/info?ehid=${id}`,
  },
  etwarm: {
    label: "東森房屋",
    id: /^[0-9]{1,15}$/,
    url: (id) => `https://www.etwarm.com.tw/houses/buy/${id}`,
  },
  century21: {
    label: "21世紀不動產",
    id: /^[0-9]{1,15}$/,
    url: (id) => `https://www.century21.com.tw/buypage/${id}`,
  },
});

// 外部連結只允許這些主機（全部 https）。
export const ALLOWED_HOSTS = Object.freeze([
  "buy.cthouse.com.tw",
  "www.hbhousing.com.tw",
  "www.rakuya.com.tw",
  "www.etwarm.com.tw",
  "www.century21.com.tw",
  "sale.591.com.tw",
  "www.sinyi.com.tw",
  "www.openstreetmap.org",
  "opendatacommons.org",
  "data.gov.tw",
]);

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** 來源代碼 → 顯示名稱；不認得的來源回 null。 */
export function sourceLabel(src) {
  return typeof src === "string" && hasOwn(SOURCES, src) ? SOURCES[src].label : null;
}

/** 依「來源＋編號」產生物件頁網址；來源不認得或編號格式不對時回 null（只顯示文字，不給連結）。 */
export function listingUrl(src, id) {
  if (typeof src !== "string" || !hasOwn(SOURCES, src)) return null;
  const source = SOURCES[src];
  if (typeof id !== "string" || !source.id.test(id)) return null;
  return safeExternalUrl(source.url(encodeURIComponent(id)));
}

/**
 * 檢查外部網址：只接受 https、預設連接埠、沒有帳號密碼、主機在白名單上。
 * 通過時回傳正規化後的網址字串，否則回 null。
 */
export function safeExternalUrl(value) {
  if (typeof value !== "string") return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (!ALLOWED_HOSTS.includes(url.hostname)) return null;
  return url.href;
}

// 區域 → 各站的地區參數（行政區代碼）。只是一張對照表，不含任何門檻。
// 591：regionid 6＝桃園市；section 73＝桃園區、67＝中壢區（R2a §3.2）。
// 信義：Taoyuan-city＋郵遞區號（R2b §3.5 已驗證的網址格式）。
const AREA_SEARCH = Object.freeze({
  taoyuan_core: { s591: { regionid: 6, section: 73 }, sinyi: { city: "Taoyuan", zip: "330" } },
  zhongli_ic: { s591: { regionid: 6, section: 67 }, sinyi: { city: "Taoyuan", zip: "320" } },
});

const isNum = (value) => typeof value === "number" && Number.isFinite(value);
const isInt = (value) => Number.isSafeInteger(value);

function isPair(value) {
  return Array.isArray(value) && value.length === 2 && isInt(value[0]) && isInt(value[1]);
}

/** 這個區域有沒有搜尋網址的對照。 */
export function hasSearchLinks(areaId) {
  return typeof areaId === "string" && hasOwn(AREA_SEARCH, areaId);
}

/**
 * 591 的搜尋頁網址（給人看的搜尋頁，不是 API）。
 * - 屋齡：591 的屋齡是整數年，而且兩個欄位常差 1 年，所以下限多放寬 1 年；
 *   條件的「未滿 b 年」直接當 591 的上限 b（含本數），比條件寬。
 * - 主建物取整數往下、開價取整數往上，都只會比條件寬。
 * - 不帶車位：591 的車位篩選會漏掉沒填車位欄的物件（R2a §2）。
 *
 * @param {object} profile 正規化後的條件（parseProfiles 的結果），或 {area} 只帶區域。
 * @returns {string|null} 區域沒有對照時回 null。
 */
export function search591Url(profile) {
  const area = profile && hasSearchLinks(profile.area) ? AREA_SEARCH[profile.area].s591 : null;
  if (!area) return null;
  const elevatorRequired = Boolean(profile.elevator && profile.elevator.required);
  const params = [
    "shType=list",
    `regionid=${area.regionid}`,
    `section=${area.section}`,
    "kind=9",
    // 2 電梯大樓、5 華廈；不要求電梯時加上 1 公寓。
    `shape=${elevatorRequired ? "2,5" : "1,2,5"}`,
  ];
  if (isNum(profile.price_max_wan) && profile.price_max_wan > 0) {
    params.push(`price=$_$${Math.ceil(profile.price_max_wan)}`);
  }
  if (isPair(profile.built_years)) {
    const [minYears, maxYears] = profile.built_years;
    params.push(`houseage=$${minYears > 0 ? minYears - 1 : ""}_$${maxYears}`);
  }
  if (isPair(profile.floor)) {
    const [low, high] = profile.floor;
    params.push(`floor=$${low >= 1 ? low : ""}_$${high >= 1 ? high : ""}`);
  }
  if (isNum(profile.main_min_ping) && profile.main_min_ping > 0) {
    params.push(`mainarea=$${Math.floor(profile.main_min_ping)}_$`);
  }
  params.push("order=posttime_desc");
  return safeExternalUrl(`https://sale.591.com.tw/?${params.join("&")}`);
}

/**
 * 信義的搜尋列表網址。只用 R2b §3.5 驗證過的路徑段：價格上限（萬）、大樓＋華廈、縣市、郵遞區號、頁碼。
 *
 * @param {object} profile 正規化後的條件，或 {area} 只帶區域。
 * @returns {string|null}
 */
export function searchSinyiUrl(profile) {
  const area = profile && hasSearchLinks(profile.area) ? AREA_SEARCH[profile.area].sinyi : null;
  if (!area) return null;
  const segments = [];
  if (isNum(profile.price_max_wan) && profile.price_max_wan > 0) {
    segments.push(`min-${Math.ceil(profile.price_max_wan)}-price`);
  }
  segments.push("dalou-huaxia-type", `${area.city}-city`, `${area.zip}-zip`, "1");
  return safeExternalUrl(`https://www.sinyi.com.tw/buy/list/${segments.join("/")}`);
}
