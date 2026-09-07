// 「从零建东西的第一次落盘、而本轮还没有计划」这条观测事实，挂到那次调用**自己的**
// 工具结果末尾。它以前是把调用换成 [BLOCKED_PLAN_FIRST] 假结果打回去，现在调用照常
// 执行，只把事实告诉模型，要不要因此列计划由模型自己判断。
//
// 这里判的是「这条事实这次到底说不说得出口」。判据必须存在的理由：正文逐字写着
// 「**这次调用照常执行了**」，而那句话是在工具执行**之前**定下的。设值到追加之间，
// 有三条路会让它变成假话：
//   · 同批前一项失败 → _implementationMutationBatchBlockResult 把这一项整个换成门拦正文；
//   · 工具抛异常 → 结果正文是「[ERROR] 这个工具执行时抛出异常」；
//   · 写入本身失败（审批被拒、路径非法、磁盘错）→ 失败正文。
// 三条路上追上去的都是「失败正文 + 这次调用照常执行了」。那正是这道门降级前那句谎话
// （明明没执行却说已保存）的镜像复活——方向反过来而已，同样是 harness 在说假话。
export function planFactLands({ note, msg, blocked, succeeded } = {}) {
  if (!note || !msg) return false;
  if (blocked) return false;
  return succeeded !== false;
}
