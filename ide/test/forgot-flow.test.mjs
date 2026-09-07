// 「忘记密码」这条路在客户端的三块接线：网页登录页（gate.html）、桌面端登录框（Shell.jsx +
// main.js）、三种语言的文案。2026-09-05 之前产品里没有任何改密码的入口，忘了密码的人只能
// 找运营者去数据库里改——这组断言守的是「再也不用这样」。服务端那半在 server/src/auth.rs 的
// password_reset_tests 里守。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CODE } from "./helpers/source.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = readFileSync(join(HERE, "..", "gate", "gate.html"), "utf8");
const SHELL = readFileSync(join(HERE, "..", "src", "app", "Shell.jsx"), "utf8");
const I18N = readFileSync(join(HERE, "..", "src", "i18n.js"), "utf8");

test("网页登录页：忘记密码先发码、再收码和新密码、最后用服务端签发的令牌直接进站", () => {
  assert.match(GATE, /id="forgotBtn"/, "登录表单上没有「忘记密码」入口");
  assert.match(GATE, /id="resetForm"/, "没有重置表单");
  const forgotAt = GATE.indexOf('$("forgotBtn").addEventListener("click"');
  assert.ok(forgotAt > 0, "「忘记密码」按钮没接处理器");
  const forgot = GATE.slice(forgotAt, forgotAt + 1200);
  const sendAt = forgot.indexOf('post("/api/auth/send-code"');
  const showAt = forgot.indexOf('show("reset")');
  assert.ok(sendAt > 0 && showAt > sendAt, "必须先发码成功再切到重置表单，否则用户面对一个永远收不到码的输入框");
  const submitAt = GATE.indexOf('forms.reset.addEventListener("submit"');
  assert.ok(submitAt > 0, "重置表单没接提交处理器");
  const submit = GATE.slice(submitAt, submitAt + 1200);
  assert.match(submit, /post\("\/api\/auth\/reset-password", \{/, "提交没打重置接口");
  assert.match(submit, /finish\(res\.data\.token\)/, "重置成功后没有用签发的令牌进站——用户还得再登录一次");
  // 表单要注册进 show()，否则切过去时别的表单不会藏起来。
  assert.match(GATE, /reset: \$\("resetForm"\)/, "resetForm 没注册进表单表，show() 藏不住它");
  assert.match(GATE, /which === "reset" \? "Reset your password"/, "重置页没有自己的标题");
});

test("桌面端登录框：已有账号才显示「忘记密码」，走的是同一个发码 + 新接口", () => {
  assert.match(SHELL, /id="loginForgotBtn"[^>]*hidden/, "按钮要默认隐藏，查完邮箱确认账号存在才露出来");
  assert.match(CODE, /authResetPassword: \(email, password, code\) => _michaelAuth\("reset-password", \{ email, password, code \}\)/,
    "真后端没有 authResetPassword");
  assert.match(CODE, /authResetPassword: async \(\) => \(\{ success: true/, "预览模式的假后端没有同名方法，网页版会在这里炸");
  // 查邮箱之后：存在才显示。
  const nextAt = CODE.indexOf('$("loginNextBtn")?.addEventListener("click"');
  assert.ok(nextAt > 0);
  assert.match(CODE.slice(nextAt, nextAt + 2200), /forgot\.hidden = !exists/, "「忘记密码」没有按账号是否存在显隐");
  // 提交分支。
  const submitAt = CODE.indexOf('$("loginSubmitBtn")?.addEventListener("click"');
  assert.ok(submitAt > 0);
  const submit = CODE.slice(submitAt, submitAt + 2600);
  assert.match(submit, /_loginMode === "reset"/, "提交处理器没有重置分支");
  assert.match(submit, /backend\.authResetPassword\(email, password, code\)/, "重置分支没调新接口");
  assert.match(submit, /password\.length < 6/, "重置分支没有和注册一样的密码下限");
  // 点了「忘记密码」：切模式、露出验证码框、发码。
  const forgotAt = CODE.indexOf('$("loginForgotBtn")?.addEventListener("click"');
  assert.ok(forgotAt > 0, "「忘记密码」按钮没接处理器");
  const forgot = CODE.slice(forgotAt, forgotAt + 1400);
  assert.match(forgot, /_loginMode = "reset"/);
  assert.match(forgot, /_showCodeField\(true\)/, "没露出验证码框，码来了也没地方填");
  assert.match(forgot, /backend\.authSendCode\(email\)/, "没发码");
  // 关掉登录框再打开，要回到普通登录，按钮也要藏回去。
  const resetAt = CODE.indexOf("function _resetLoginUI()");
  assert.match(CODE.slice(resetAt, resetAt + 600), /loginForgotBtn/, "_resetLoginUI 没把「忘记密码」藏回去");
});

test("三种语言都有重置文案，缺一种那种语言的用户会看到键名", () => {
  for (const key of ["login.forgot", "login.newPasswordPlaceholder", "login.resetHint", "login.completeReset", "login.resetting"]) {
    const n = I18N.split(`"${key}":`).length - 1;
    assert.equal(n, 3, `${key} 应在 en / zh / ja 三张表里各出现一次，实际 ${n} 次`);
  }
});
