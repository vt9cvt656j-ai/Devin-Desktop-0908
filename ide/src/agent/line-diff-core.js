// 从 main.js 搬出来的（撞行数闸时按仓库规矩先腾地方，不抬闸线）。
// 纯算法、零外部依赖：两段行数组之间的最小改动块。

export function _lineDiffHunksCore(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const hunks = [];
  let cur = null;
  const flush = () => {
    if (cur) {
      hunks.push(cur);
      cur = null;
    }
  };
  let i = 0;
  let j = 0;
  const open = () => {
    if (!cur) cur = { aStart: i, aCount: 0, bStart: j, bCount: 0 };
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      open();
      cur.aCount++;
      i++;
    } else {
      open();
      cur.bCount++;
      j++;
    }
  }
  while (i < n) {
    open();
    cur.aCount++;
    i++;
  }
  while (j < m) {
    open();
    cur.bCount++;
    j++;
  }
  flush();
  return hunks;
}
