// 从 main.js 搬出来的（撞行数闸时按仓库规矩先腾地方，不抬闸线）。
// 纯几何：给提交列表排出提交图的泳道与连线，零外部依赖。

export function layoutGitGraph(entries) {
  const lanes = [];
  const hashToLane = new Map();
  const rows = [];

  for (const e of entries) {
    let lane = hashToLane.get(e.hash);
    if (lane == null) {
      lane = lanes.indexOf(null);
      if (lane < 0) lane = lanes.length;
      if (lane >= lanes.length) lanes.push(e.hash);
      else lanes[lane] = e.hash;
    }

    const merges = [];
    const forks = [];

    for (let i = 0; i < lanes.length; i++) {
      if (i !== lane && lanes[i] === e.hash) {
        merges.push(i);
        lanes[i] = null;
      }
    }

    const parents = e.parents || [];
    if (parents.length > 0) {
      lanes[lane] = parents[0];
      hashToLane.set(parents[0], lane);
    } else {
      lanes[lane] = null;
    }

    for (let pi = 1; pi < parents.length; pi++) {
      const ph = parents[pi];
      let fl = hashToLane.get(ph);
      if (fl == null) {
        fl = lanes.indexOf(null);
        if (fl < 0) fl = lanes.length;
        if (fl >= lanes.length) lanes.push(ph);
        else lanes[fl] = ph;
        hashToLane.set(ph, fl);
      }
      forks.push(fl);
    }

    const activeLanes = lanes.map((v, i) => v != null ? i : -1).filter(i => i >= 0);
    rows.push({ entry: e, lane, merges, forks, activeLanes: [...activeLanes], maxLane: lanes.length });
  }
  return rows;
}
