// 从 main.js 搬出来的（撞行数闸时按仓库规矩先腾地方，不抬闸线）。
// 纯函数：把本地发现（店铺/地点）结果整理成给用户看的那段摘要。
//
// escapeHtml 由调用方注入（main.js 的 _escHtml，它不是 main.js 里的声明、是跨文件全局，
// 模块里看不见）。没注入时**兜底也真转义**——这一段是直接写进 innerHTML 的，兜底成
// 恒等函数就是一个注入口。同 knowledge-preflight-card.js 的做法。

export function _localDiscoveryVisibleSummary(output, call, location, escapeHtml) {
  call = call || {};
  location = location || null;
  const esc = typeof escapeHtml === "function"
    ? escapeHtml
    : (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  const text = (value, fallback = "未知") => {
    const raw = value === null || value === undefined ? "" : String(value).trim();
    return raw ? esc(raw) : esc(fallback);
  };
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
  const distance = (value) => {
    const meters = number(value);
    if (meters === null) return "";
    if (meters < 1000) return `${Math.round(meters)}m`;
    const km = meters / 1000;
    return `${km >= 10 ? Math.round(km) : km.toFixed(1)}km`;
  };
  const coords = (item) => {
    const lat = number(item?.latitude);
    const lon = number(item?.longitude);
    if (lat === null || lon === null) return "";
    return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  };
  const sourceName = (source) => {
    const key = String(source || "").toLowerCase();
    const map = {
      nominatim: "Nominatim",
      arcgis_world_geocoding: "ArcGIS",
      overpass: "OSM",
      open_meteo: "Open-Meteo",
      wikipedia_geosearch: "Wikipedia",
      wikipedia: "Wikipedia",
    };
    return map[key] || String(source || "未知来源").replace(/_/g, " ");
  };
  const statusName = (status) => {
    const map = {
      success: "成功",
      empty: "无匹配",
      failed: "失败",
      skipped: "跳过",
      stale: "过旧",
      delayed: "延迟",
      no_coverage: "无覆盖",
    };
    return map[String(status || "").toLowerCase()] || String(status || "未知");
  };
  const openLabel = (place) => {
    if (place?.open_now === true) return "可能营业";
    if (place?.open_now === false) return "可能休息";
    if (place?.opening_hours) return `排班：${String(place.opening_hours).slice(0, 80)}`;
    return "营业状态未知";
  };
  const center = output?.center || null;
  const places = Array.isArray(output?.places) ? output.places : [];
  const context = Array.isArray(output?.nearby_context) ? output.nearby_context : [];
  const statuses = Array.isArray(output?.source_statuses) ? output.source_statuses : [];
  const weather = output?.weather || null;
  const limitations = Array.isArray(output?.limitations) ? output.limitations.filter(Boolean) : [];
  const radiusM = number(output?.radius_m ?? call?.radiusM);
  const centerLabel = center?.label || call?.near || (Number.isFinite(call?.latitude) && Number.isFinite(call?.longitude) ? "传入坐标" : "未解析");
  const centerCoord = coords(center) || (Number.isFinite(call?.latitude) && Number.isFinite(call?.longitude)
    ? `${Number(call.latitude).toFixed(5)}, ${Number(call.longitude).toFixed(5)}`
    : "");
  const requested = statuses.filter((item) => item?.status !== "skipped");
  const okCount = requested.filter((item) => item?.status === "success" || item?.status === "empty").length;
  const statusSummary = requested.length ? `${okCount}/${requested.length} 个来源返回可解析响应` : "来源状态缺失";

  let html = `<div class="ld-card">`;
  html += `<div class="ld-section ld-section--top"><div><div class="ld-k">查询中心</div><div class="ld-title">${text(centerLabel)}</div>`;
  const meta = [];
  if (centerCoord) meta.push(centerCoord);
  if (radiusM !== null) meta.push(`半径 ${distance(radiusM)}`);
  if (Number.isFinite(location?.accuracyM)) meta.push(`定位精度约 ±${Math.round(location.accuracyM)}m`);
  if (meta.length) html += `<div class="ld-meta">${text(meta.join(" · "))}</div>`;
  html += `</div><span class="ld-pill">${text(statusSummary)}</span></div>`;

  if (places.length) {
    html += `<div class="ld-section"><div class="ld-k">OSM 候选地点（前 ${Math.min(places.length, 5)} 个 / 共 ${places.length} 个）</div><ol class="ld-list">`;
    for (const place of places.slice(0, 5)) {
      const bits = [];
      if (place?.category) bits.push(String(place.category));
      if (place?.cuisine) bits.push(String(place.cuisine));
      const dist = distance(place?.distance_m);
      if (dist) bits.push(dist);
      bits.push(openLabel(place));
      html += `<li class="ld-item"><div class="ld-item__name">${text(place?.name || place?.address || place?.id || "未命名地点")}</div>`;
      html += `<div class="ld-item__meta">${text(bits.filter(Boolean).join(" · "))}</div>`;
      if (place?.address) html += `<div class="ld-item__sub">${text(place.address)}</div>`;
      html += `</li>`;
    }
    html += `</ol></div>`;
  } else {
    html += `<div class="ld-empty">本次没有拿到可展示的 OSM 地点候选；这不等于附近真的没有，只代表公开来源本次没返回匹配结果。</div>`;
  }

  if (context.length) {
    html += `<div class="ld-section"><div class="ld-k">附近背景资料（不当作推荐排序）</div><div class="ld-context">`;
    for (const item of context.slice(0, 3)) {
      const dist = distance(item?.distance_m);
      html += `<span class="ld-chip">${text(`${item?.name || item?.id || "背景条目"}${dist ? ` · ${dist}` : ""}`)}</span>`;
    }
    html += `</div></div>`;
  }

  if (weather) {
    const weatherBits = [];
    if (weather.condition) weatherBits.push(String(weather.condition));
    if (Number.isFinite(weather.temperature_c)) weatherBits.push(`${Math.round(weather.temperature_c)}°C`);
    if (Number.isFinite(weather.apparent_temperature_c)) weatherBits.push(`体感 ${Math.round(weather.apparent_temperature_c)}°C`);
    if (Number.isFinite(weather.precipitation_mm)) weatherBits.push(`降水 ${weather.precipitation_mm}mm`);
    if (Number.isFinite(weather.wind_speed_kmh)) weatherBits.push(`风 ${Math.round(weather.wind_speed_kmh)}km/h`);
    if (weather.observed_at) weatherBits.push(`观测 ${weather.observed_at}`);
    if (weatherBits.length) html += `<div class="ld-section"><div class="ld-k">天气估算</div><div class="ld-line">${text(weatherBits.join(" · "))}</div></div>`;
  }

  if (statuses.length) {
    html += `<div class="ld-section"><div class="ld-k">来源状态</div><div class="ld-statuses">`;
    for (const item of statuses.slice(0, 8)) {
      const cls = String(item?.status || "").toLowerCase();
      const count = Number.isFinite(Number(item?.result_count)) ? ` · ${Number(item.result_count)} 条` : "";
      html += `<span class="ld-status ld-status--${esc(cls || "unknown")}">${text(sourceName(item?.source))}：${text(statusName(item?.status) + count)}</span>`;
    }
    if (statuses.length > 8) html += `<span class="ld-status">另有 ${statuses.length - 8} 个来源状态</span>`;
    html += `</div></div>`;
  }

  if (limitations.length) {
    html += `<div class="ld-note">限制：${text(limitations.slice(0, 2).join("；"))}${limitations.length > 2 ? "…" : ""}</div>`;
  }
  html += `<div class="ld-note">完整结构化依据仍已提供给模型用于回答；这里不再展开原始 JSON。</div>`;
  html += `</div>`;
  return html;
}
