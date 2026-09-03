import type React from "react";
import { useEffect, useState } from "react";
import { Apple } from "lucide-react";
import { Button } from "@/components/ui/button";
import { mseFetch } from "@/lib/mse";
import { pickMacArch } from "@/lib/mac-arch.js";
import type { MacArch } from "@/lib/mac-arch.js";
import { cn } from "@/lib/utils";

/*
 * 下载地址来自网关，不是 GitHub。
 *
 * 发行仓库是私有的，github.com/.../releases/latest 对访客一律 404 —— 这里以前直接写死
 * 那个链接，等于每个点"下载"的人都被送进一个 404。网关本来就为此准备了公开代下载路由
 * （update.rs：带 token 取私有仓库资产，并把清单里的地址改写成
 * /api/ide/update/download/<tag>/<file>），所以站点读同一份清单就够了。
 *
 * 没有已发布版本时清单返回 204。那时不摆死链接：明说桌面版还没放出来，把人引到注册。
 * 运营在控制台发布 release 之后，这里下一次加载自动变成真实下载，站点不用再改。
 */
const UPDATE_FEED = "https://code.mrday.one/api/ide/update";
/**
 * The installers that exist right now.
 *
 * The feed above only answers when a release carries `latest.json`, the signed manifest
 * the auto-updater needs — and the published release predates that file, so it answers
 * "no update" and this page concluded there was nothing to download at all. Installing and
 * auto-updating are different questions: this endpoint reads the release's own assets, so
 * the buttons offer what is actually published.
 */
const DOWNLOADS = "https://code.mrday.one/api/ide/downloads";
const SIGN_UP = "https://code.mrday.one/gate";

/** lucide has no Windows glyph; this is the four-pane mark. */
function WindowsMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M3 5.4 10.3 4.4v7.1H3zM11.2 4.3 21 3v8.5h-9.8zM3 12.5h7.3v7.1L3 18.6zM11.2 12.5H21V21l-9.8-1.3z" />
    </svg>
  );
}

type OS = "mac" | "windows";

/**
 * 一个下载键 = 一个真实存在的安装包。Mac 有两个，因为它就是两个包。
 *
 * 之前这里只有 `mac`，指向 x64 那一个 DMG，说明文字写「Intel & Apple Silicon」。
 * 那句话在**能不能跑**这个意义上是对的（x64 包在 M 系上能靠 Rosetta 跑起来），
 * 但代价是：占绝大多数的 M 系用户拿到的是翻译执行的包，而且首次打开会被要求装 Rosetta。
 */
type DownloadKey = "mac-arm64" | "mac-x64" | "windows";

/** Tauri 更新清单里的平台键 —— 清单那条兜底路径按这个名字取 URL。 */
const MANIFEST_KEY: Record<DownloadKey, string> = {
  "mac-arm64": "darwin-aarch64",
  "mac-x64": "darwin-x86_64",
  windows: "windows-x86_64",
};

type Release =
  | { state: "checking" }
  | { state: "ready"; version: string; urls: Partial<Record<DownloadKey, string>> }
  | { state: "none" };

/** Best guess at the visitor's platform; both downloads stay reachable either way. */
function useDetectedOS(): OS {
  const [os, setOs] = useState<OS>("mac");
  useEffect(() => {
    const ua =
      (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ||
      navigator.userAgent ||
      "";
    if (/win/i.test(ua)) setOs("windows");
  }, []);
  return os;
}

type NavigatorUAData = {
  getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>;
};

/**
 * 这台 Mac 的 GPU 名字，取不到就是空串。
 *
 * Safari 和 Firefox 不实现下面那个客户端提示 API，但它们如实报告 GPU —— 而 Mac 上
 * GPU 和 CPU 架构是绑定的：M 系是 Apple 自家的 GPU，Intel 机器上是 Intel / AMD / NVIDIA。
 * 所以这个字符串就成了这两个浏览器上唯一可用的判据。
 */
function unmaskedRenderer(): string {
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl") ||
      canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (!gl) return "";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const raw = ext
      ? gl.getParameter((ext as { UNMASKED_RENDERER_WEBGL: number }).UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    return typeof raw === "string" ? raw : "";
  } catch {
    return "";
  }
}

/**
 * Intel Mac 还是 M 系 Mac —— 判不出来时返回 null。
 *
 * **UA 在这个问题上是死路。** macOS 上每个浏览器（包括 M 系上的 Safari 和 Chrome）
 * 都仍然把自己报成 `Intel Mac OS X`，这是当年为了不打断老站点的兼容性决定，至今没改。
 * 照着 UA 判架构，结论**永远**是 Intel，一台 M 系也认不出来。所以这里一个字都不看 UA。
 *
 * 两条真正能回答的路（**下面的编号不是优先级**，优先级见 mac-arch.js：GPU 先判）：
 *
 * 1. `userAgentData.getHighEntropyValues(["architecture"])` —— 只有 Chromium 系
 *    （Chrome / Edge / Arc / Brave）有，但在那里是权威答案："arm" 或 "x86"。
 * 2. WebGL 的 unmasked renderer —— Safari / Firefox 走这条。见上面那个函数。
 *
 * 两条都可能失败（浏览器太老、WebGL 被禁、隐私模式把 GPU 名字抹成通用串），
 * 所以返回值允许是 null，调用方必须为「判不出来」准备一条出路，而不是硬猜一个了事。
 *
 * 这个函数只负责**取信号**；「取到之后怎么判」在 lib/mac-arch.js，那边是纯函数、
 * 有拿真实机器字符串跑的测试（test/mac-arch.test.mjs）。
 */
async function detectMacArch(): Promise<MacArch | null> {
  let architecture: string | undefined;
  const uaData = (navigator as { userAgentData?: NavigatorUAData }).userAgentData;
  if (typeof uaData?.getHighEntropyValues === "function") {
    try {
      architecture = (await uaData.getHighEntropyValues(["architecture"])).architecture;
    } catch {
      // 提示被拒绝或不被支持 —— 掉到 GPU 那条，不是错误。
    }
  }
  return pickMacArch({ architecture, renderer: unmaskedRenderer() });
}

function useMacArch(): MacArch | null {
  const [arch, setArch] = useState<MacArch | null>(null);
  useEffect(() => {
    let alive = true;
    void detectMacArch().then((a) => {
      if (alive && a) setArch(a);
    });
    return () => {
      alive = false;
    };
  }, []);
  return arch;
}

/**
 * The published installers, or `none` if there genuinely are not any.
 *
 * Kept separate from the manifest path above so the two reasons a download can be missing
 * stay distinguishable: "no signed manifest" is common and recoverable, "no release at
 * all" is the only one that should send someone to a sign-up link.
 */
async function installersOrNone(): Promise<Release> {
  try {
    const res = await mseFetch(DOWNLOADS, { cache: "no-store" });
    if (!res.ok) return { state: "none" };
    const body = (await res.json()) as {
      version?: string;
      mac?: string | null;
      mac_arm64?: string | null;
      mac_x64?: string | null;
      windows?: string | null;
    };
    const urls: Partial<Record<DownloadKey, string>> = {};
    // 网关分开给两个架构（update.rs 的 downloads handler）。`mac` 是它更早就有的那个键，
    // 指向 x64 —— 只在分架构的键缺席时才用它兜底，别让它盖掉 arm64。
    if (body.mac_arm64) urls["mac-arm64"] = body.mac_arm64;
    if (body.mac_x64) urls["mac-x64"] = body.mac_x64;
    if (!urls["mac-x64"] && body.mac) urls["mac-x64"] = body.mac;
    if (body.windows) urls.windows = body.windows;
    return Object.keys(urls).length
      ? { state: "ready", version: body.version ?? "", urls }
      : { state: "none" };
  } catch {
    return { state: "none" };
  }
}

function useRelease(): Release {
  const [release, setRelease] = useState<Release>({ state: "checking" });
  useEffect(() => {
    let alive = true;
    void (async () => {
      // 先问 DOWNLOADS，再回落到更新清单——**顺序不能反**。
      //
      // 这两个端点服务的是两类不同的人：DOWNLOADS 是专门为「给人下载」挑的，Mac 给 .dmg、
      // Windows 给 NSIS 的 .exe（网关那边的注释原话是 "the NSIS installer is the one to
      // hand a person"）；UPDATE_FEED 是给**自动更新器**用的清单，里面是 .app.tar.gz 这类
      // 更新产物。原来先读清单，于是这两个按钮把更新器的压缩包递给了人——页面上却写着
      // 「.dmg」和「.exe or .msi」。2026-08-19 实测：Mac 按钮下下来是 20.98MB 的
      // .app.tar.gz 而不是 21.6MB 的 DMG，Windows 下到的是 MSI 而不是 15MB 的 exe。
      //
      // 清单仍然留作兜底：DOWNLOADS 只在有可安装产物时才回内容，真没有的时候
      // 清单里可能还有东西，那时给个能装的总比什么都不给强。
      const installers = await installersOrNone();
      if (installers.state === "ready") {
        if (alive) setRelease(installers);
        return;
      }
      try {
        const res = await mseFetch(UPDATE_FEED, { cache: "no-store" });
        // 204 means the gateway is healthy and simply has no published release. Sealed or
        // not, this reads the handler's own status — a sealed 204 carries no body and is
        // rebuilt as a bodyless 204, so the distinction below survives encryption.
        if (res.status !== 200) throw new Error(String(res.status));
        const manifest = (await res.json()) as {
          version?: string;
          platforms?: Record<string, { url?: string }>;
        };
        const urls: Partial<Record<DownloadKey, string>> = {};
        for (const key of Object.keys(MANIFEST_KEY) as DownloadKey[]) {
          const url = manifest.platforms?.[MANIFEST_KEY[key]]?.url;
          if (url) urls[key] = url;
        }
        if (!alive) return;
        if (Object.keys(urls).length) {
          setRelease({ state: "ready", version: manifest.version ?? "", urls });
          return;
        }
        throw new Error("manifest carried no platforms");
      } catch {
        // No manifest is not the same as nothing to install. Ask what is actually
        // published before giving up and showing a sign-up link.
        // 走到这里说明 DOWNLOADS 和清单都没给出可装的东西。
        if (alive) setRelease({ state: "none" });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return release;
}

type IconType = React.ComponentType<{ className?: string }>;

const MAC_LABEL: Record<MacArch, string> = { arm64: "Apple Silicon", x64: "Intel" };

const PLATFORMS: Record<OS, { label: string; icon: IconType }> = {
  mac: { label: "Download for MacOS", icon: Apple },
  windows: { label: "Download for Windows", icon: WindowsMark },
};

export function DownloadButtons({
  size = "lg",
  variant = "onLight",
  className,
}: {
  size?: "md" | "lg";
  /** The CTA band is dark, so the secondary button needs a different treatment there. */
  variant?: "onLight" | "onDark";
  className?: string;
}) {
  const detected = useDetectedOS();
  const release = useRelease();
  const arch = useMacArch();
  const other: OS = detected === "mac" ? "windows" : "mac";
  const Primary = PLATFORMS[detected].icon;
  const Secondary = PLATFORMS[other].icon;
  const muted = variant === "onDark" ? "text-primary-foreground/60" : "text-muted-foreground";

  // Nothing published: say so, and offer what does work today rather than a dead button.
  if (release.state === "none") {
    return (
      <div className={cn("flex flex-col items-center gap-3", className)}>
        <Button size={size} variant={variant === "onDark" ? "inverse" : "default"} asChild>
          <a href={SIGN_UP}>Create an account</a>
        </Button>
        <p className={cn("max-w-md text-center text-xs leading-relaxed", muted)}>
          The MacOS and Windows builds are not published yet. Create an account now — the editor
          runs in your browser, and the download appears here the moment it ships.
        </p>
      </div>
    );
  }

  const urls = release.state === "ready" ? release.urls : {};
  // 判不出架构时按 arm64 发。Apple 2022 年就停售 Intel 机器了，猜 M 系对的概率高得多；
  // 而猜错的那部分人不会卡死 —— 下面那行「Intel Mac?」的链接始终在，一次点击就换过去。
  const macArch: MacArch = arch ?? "arm64";
  const macKey: DownloadKey = macArch === "arm64" ? "mac-arm64" : "mac-x64";
  const otherArch: MacArch = macArch === "arm64" ? "x64" : "arm64";
  const otherMacKey: DownloadKey = otherArch === "arm64" ? "mac-arm64" : "mac-x64";

  // Mac 那个键没有包时退到另一个架构，别把一个空按钮摆在那儿。
  const macHref = urls[macKey] ?? urls[otherMacKey];
  const servedArch: MacArch = urls[macKey] ? macArch : otherArch;
  const href = (os: OS) => (os === "mac" ? macHref : urls.windows);

  const checking = release.state === "checking";
  const live = (os: OS) => !checking && !!href(os);
  const requirement = (os: OS) =>
    os === "mac"
      ? `MacOS 13+ · ${MAC_LABEL[servedArch]} · .dmg`
      : "Windows 10+ · x64 · .exe or .msi";

  const swapHref = urls[otherMacKey];
  const swapLink =
    swapHref && urls[macKey] ? (
      <a href={swapHref} className="underline underline-offset-2 hover:opacity-80">
        {MAC_LABEL[otherArch]} Mac? Get that build
      </a>
    ) : null;

  return (
    <div className={cn("flex flex-col items-center gap-3", className)}>
      <div className="flex flex-col items-center gap-3 sm:flex-row">
        <Button
          size={size}
          variant={variant === "onDark" ? "inverse" : "default"}
          disabled={!live(detected)}
          asChild={live(detected)}
        >
          {live(detected) ? (
            <a href={href(detected)}>
              <Primary /> {PLATFORMS[detected].label}
            </a>
          ) : (
            <span>
              <Primary /> {PLATFORMS[detected].label}
            </span>
          )}
        </Button>
        <Button
          size={size}
          variant="outline"
          disabled={!live(other)}
          asChild={live(other)}
          className={cn(
            variant === "onDark" &&
              "border-primary-foreground/25 bg-transparent text-primary-foreground hover:bg-primary-foreground/10",
          )}
        >
          {live(other) ? (
            <a href={href(other)}>
              <Secondary /> {PLATFORMS[other].label}
            </a>
          ) : (
            <span>
              <Secondary /> {PLATFORMS[other].label}
            </span>
          )}
        </Button>
      </div>

      <p className={cn("text-xs", muted)}>
        {release.state === "ready" && release.version ? (
          <>
            Version {release.version}
            <span className="mx-1.5 opacity-50">·</span>
          </>
        ) : null}
        {requirement(detected)}
        <span className="mx-1.5 opacity-50">·</span>
        {requirement(other)}
      </p>

      {swapLink ? <p className={cn("text-xs", muted)}>{swapLink}</p> : null}
    </div>
  );
}
