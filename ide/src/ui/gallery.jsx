import { useState } from "react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./components/card.jsx";
import { Button } from "./components/button.jsx";
import { Badge } from "./components/badge.jsx";
import { Separator } from "./components/separator.jsx";
import { Input } from "./components/input.jsx";
import { Switch } from "./components/switch.jsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/tabs.jsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/tooltip.jsx";
import {
  Dialog, DialogClose, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "./components/dialog.jsx";

/**
 * 组件长廊 —— 第一个岛，故意选一个"新增面”而不是改造现有对话框。
 *
 * 它的作用是让配色决定可以**看着**做：所有 shadcn 组件都在这里，用的是项目自己的 token，
 * 切深浅色时跟着变。判断"这套组件搭我的配色好不好看"，看这一屏就够了，不用先改 22 个
 * 现有对话框。
 */
function Row({ title, hint, children }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function Gallery() {
  const [on, setOn] = useState(true);

  return (
    <div className="flex max-h-[calc(var(--eh,100vh)*0.78)] flex-col gap-6 overflow-auto p-1">
      <Row title="Button" hint="六个变体 · 四个尺寸">
        <Button>Default</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Destructive</Button>
        <Button variant="link">Link</Button>
        <Button size="sm" variant="outline">sm</Button>
        <Button size="lg" variant="outline">lg</Button>
        <Button disabled>Disabled</Button>
      </Row>

      <Separator />

      <Row title="Badge">
        <Badge>Default</Badge>
        <Badge variant="secondary">Secondary</Badge>
        <Badge variant="outline">Outline</Badge>
        <Badge variant="destructive">Destructive</Badge>
      </Row>

      <Separator />

      <Row title="Input / Switch">
        <Input placeholder="Search files…" className="max-w-[220px]" />
        <Input placeholder="Disabled" disabled className="max-w-[160px]" />
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={on} onCheckedChange={setOn} />
          {on ? "On" : "Off"}
        </label>
      </Row>

      <Separator />

      <Row title="Tooltip / Dialog" hint="Radix 行为：焦点捕获、Esc、portal">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline">Hover me</Button>
          </TooltipTrigger>
          <TooltipContent>Real Radix tooltip</TooltipContent>
        </Tooltip>

        <Dialog>
          <DialogTrigger asChild>
            <Button>Open dialog</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Real shadcn dialog</DialogTitle>
              <DialogDescription>
                焦点被捕获在对话框内，Esc 关闭，关闭后焦点回到触发按钮 —— 这些是 Radix
                给的，纯 CSS 层做不到。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
              <DialogClose asChild><Button>Confirm</Button></DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Row>

      <Separator />

      <Row title="Tabs">
        <Tabs defaultValue="a" className="w-full">
          <TabsList>
            <TabsTrigger value="a">Editor</TabsTrigger>
            <TabsTrigger value="b">Terminal</TabsTrigger>
            <TabsTrigger value="c">Problems</TabsTrigger>
          </TabsList>
          <TabsContent value="a" className="pt-3 text-sm text-muted-foreground">Editor panel</TabsContent>
          <TabsContent value="b" className="pt-3 text-sm text-muted-foreground">Terminal panel</TabsContent>
          <TabsContent value="c" className="pt-3 text-sm text-muted-foreground">Problems panel</TabsContent>
        </Tabs>
      </Row>

      <Separator />

      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Card</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Workspace</CardTitle>
              <CardDescription>卡片背景是 --panel-2，边框是 --line，深浅色自动跟随。</CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              没有新配色：每个语义槽都指向项目已有的 token。
            </CardContent>
            <CardFooter className="gap-2">
              <Button size="sm">Open</Button>
              <Button size="sm" variant="outline">Details</Button>
            </CardFooter>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Compression <Badge variant="secondary">5M</Badge>
              </CardTitle>
              <CardDescription>前缀稳定分段，成本只随新增内容增长。</CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Cards + components 是这次的重点，配色一个都没动。
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
