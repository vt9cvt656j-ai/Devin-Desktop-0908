#!/bin/bash
# cargo 的链接器包装（.cargo/config.toml 里 linker 指到这里）：照常链接，链接完若产物是**开发版
# michael-ide 主程序**，就用本机那张固定证书再签一遍。
#
# 为什么要这么做：macOS 的隐私授权（辅助功能 / 屏幕录制 / 自动化）按**代码签名要求**认应用。
# 链接器给开发版打的是 ad-hoc 签名，要求写死成这一份二进制的 cdhash——每重编一次 cdhash 就变，
# 系统就当它是个从没见过的新应用，昨天授的权今天就没了。桌面自动化于是「每次改完代码都要去
# 系统设置里重新勾一遍」，勾之前每个动作都报没权限。用固定证书签成
#   identifier "ai.devin.ide" and certificate leaf = H"…"
# 之后，重编多少次都还是同一个应用，授权一次就一直有效；打包版用的也是这张证书和这个
# identifier，两边共用同一条授权。
#
# 任何一步不满足都放行、不签（CI、别人的机器、证书被删）：签不上只是回到老样子，不能让构建挂掉。
# 关掉：MRDAY_DEV_SIGNING=0；换证书：MRDAY_DEV_SIGNING_IDENTITY="…"。
set -e

out=""
prev=""
scan() {
  for a in "$@"; do
    if [ "$prev" = "-o" ]; then out="$a"; fi
    prev="$a"
  done
}
scan "$@"
if [ -z "$out" ]; then
  # 参数太长时 rustc 会把它们写进 @响应文件，一行一个。
  for a in "$@"; do
    case "$a" in @*) f="${a#@}"; [ -f "$f" ] && { prev=""; while IFS= read -r line; do scan "$line"; done < "$f"; } ;; esac
  done
fi

cc "$@"

case "$(basename "$out")" in
  michael_ide-*|michael-ide) ;;
  *) exit 0 ;;
esac
case "$out" in *.dylib|*.so|*.rlib|*.a|*.o) exit 0 ;; esac
[ "${MRDAY_DEV_SIGNING:-1}" = "0" ] && exit 0
identity="${MRDAY_DEV_SIGNING_IDENTITY:-Mr Day One Local Signing}"
command -v codesign >/dev/null 2>&1 || exit 0
security find-identity -p codesigning 2>/dev/null | grep -q "\"$identity\"" || exit 0
# 签失败不算构建失败：没签上只是回到「每次重编都要重新授权」的老样子。
codesign --force -s "$identity" -i ai.devin.ide "$out" >/dev/null 2>&1 || echo "dev-linker: codesign failed for $out (continuing unsigned)" >&2
exit 0
