// 从 main.js 搬出来的（撞行数闸时按仓库规矩先腾地方，不抬闸线）。
// 纯函数、零外部依赖。

export function _mergeMichaelDesignEvidence(previous, next) {
  if (!previous) return next || null;
  if (!next) return previous;
  const queries = [previous.query, next.query].map((value) => String(value || "").trim()).filter(Boolean);
  const mergeList = (a, b, limit = 24) => [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])].slice(0, limit);
  const previousSignals = previous.visualSignals || {};
  const nextSignals = next.visualSignals || {};
  const previousTracks = previous.researchTracks || {};
  const nextTracks = next.researchTracks || {};
  return {
    query: [...new Set(queries)].join(" | ").slice(0, 480),
    researchQueries: mergeList(previous.researchQueries || (previous.query ? [previous.query] : []), next.researchQueries || (next.query ? [next.query] : []), 8),
    researchTracks: {
      informationArchitecture: !!(previousTracks.informationArchitecture || nextTracks.informationArchitecture),
      colorSystem: !!(previousTracks.colorSystem || nextTracks.colorSystem),
      responsiveLayout: !!(previousTracks.responsiveLayout || nextTracks.responsiveLayout),
      componentSystem: !!(previousTracks.componentSystem || nextTracks.componentSystem),
      signatureMotion: !!(previousTracks.signatureMotion || nextTracks.signatureMotion),
      responsiveMotion: !!(previousTracks.responsiveMotion || nextTracks.responsiveMotion),
      mediaAssets: !!(previousTracks.mediaAssets || nextTracks.mediaAssets),
      semanticIcons: !!(previousTracks.semanticIcons || nextTracks.semanticIcons),
    },
    hitCount: Math.max(Number(previous.hitCount || 0), Number(next.hitCount || 0)),
    domains: mergeList(previous.domains, next.domains, 12),
    sourceSections: mergeList(previous.sourceSections, next.sourceSections, 12),
    paletteTokens: mergeList(previous.paletteTokens, next.paletteTokens),
    tailwindPaletteTokens: mergeList(previous.tailwindPaletteTokens, next.tailwindPaletteTokens),
    mediaUrls: mergeList(previous.mediaUrls, next.mediaUrls),
    motionTechniques: mergeList(previous.motionTechniques, next.motionTechniques),
    layoutTechniques: mergeList(previous.layoutTechniques, next.layoutTechniques),
    motionParameters: mergeList(previous.motionParameters, next.motionParameters, 20),
    componentTechniques: mergeList(previous.componentTechniques, next.componentTechniques, 12),
    visualSignals: {
      typography: !!(previousSignals.typography || nextSignals.typography),
      buttons: !!(previousSignals.buttons || nextSignals.buttons),
      avatars: !!(previousSignals.avatars || nextSignals.avatars),
      motion: !!(previousSignals.motion || nextSignals.motion),
      layout: !!(previousSignals.layout || nextSignals.layout),
      icons: !!(previousSignals.icons || nextSignals.icons),
      components: !!(previousSignals.components || nextSignals.components),
    },
    at: Math.max(Number(previous.at || 0), Number(next.at || 0), Date.now()),
  };
}
