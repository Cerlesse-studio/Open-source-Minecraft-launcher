import { useEffect, useRef } from "react";
import { FolderOpen, Terminal, Trash2 } from "lucide-react";
import { cn } from "cn";
import type { GameStateName } from "../lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { GrassBlock, StatusDot } from "./ui";

export interface LogEntry {
  id: number;
  stream: string;
  line: string;
  at: string;
}

const streamColor: Record<string, string> = {
  stderr: "text-[#ef9b8e]",
  cobble: "text-primary",
  stdout: "text-[#c9d5cc]",
};

export function ConsolePanel({
  logs,
  runtime,
  onClear,
  onOpenFolder,
}: {
  logs: LogEntry[];
  runtime: { status: GameStateName; detail?: string | null; pid?: number | null };
  onClear: () => void;
  onOpenFolder: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    if (stickToBottom.current) {
      body.scrollTop = body.scrollHeight;
    }
  }, [logs]);

  const handleScroll = () => {
    const body = bodyRef.current;
    if (!body) return;
    const distance = body.scrollHeight - body.scrollTop - body.clientHeight;
    stickToBottom.current = distance < 60;
  };

  const stateLabel =
    runtime.status === "running"
      ? "游戏中"
      : runtime.status === "preparing"
        ? "准备中"
        : "空闲";
  const stateTone =
    runtime.status === "running"
      ? "live"
      : runtime.status === "preparing"
        ? "pending"
        : "muted";

  return (
    <Card className="flex h-[360px] min-h-0 flex-col gap-0 overflow-hidden border-border/70 bg-card/60 py-0">
      <div className="flex h-[52px] shrink-0 items-center justify-between gap-3 border-b border-border/60 px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <Terminal className="size-3.5 text-muted-foreground" />
          <span className="text-[13px] font-medium">运行日志</span>
          <Badge
            variant="outline"
            className="h-5 min-w-5 justify-center border-border/70 px-1 font-mono text-[10px] font-normal text-muted-foreground"
          >
            {logs.length}
          </Badge>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="mr-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <StatusDot tone={stateTone} />
            {stateLabel}
          </span>
          <Button
            variant="ghost"
            size="xs"
            className="h-7 gap-1 px-2 text-[10px] font-normal text-muted-foreground hover:text-foreground"
            onClick={onOpenFolder}
          >
            <FolderOpen className="size-3" />
            目录
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-7 text-muted-foreground hover:text-foreground"
            onClick={onClear}
            disabled={logs.length === 0}
            title="清空日志"
            aria-label="清空日志"
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto bg-[#090c0a]/70 py-2 font-mono"
        ref={bodyRef}
        onScroll={handleScroll}
      >
        {logs.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="rounded-lg border border-border/60 bg-background/60 p-2 opacity-80">
              <GrassBlock size={28} />
            </div>
            <div className="space-y-1">
              <p className="text-[11px] text-muted-foreground">
                启动游戏后，Java 和 Minecraft 的输出会显示在这里。
              </p>
              <p className="text-[10px] text-muted-foreground/50">
                日志仅保留在本次会话中
              </p>
            </div>
          </div>
        ) : (
          logs.map((entry) => (
            <div
              className="grid grid-cols-[52px_4px_minmax(0,1fr)] gap-x-2.5 px-4 py-[2px] text-[10px] leading-[18px] hover:bg-white/[0.025]"
              key={entry.id}
            >
              <span className="tabular text-right text-muted-foreground/40">
                {entry.at}
              </span>
              <span
                className={cn(
                  "mt-[7px] size-1 rounded-full",
                  entry.stream === "stderr"
                    ? "bg-[#ef9b8e]"
                    : entry.stream === "cobble"
                      ? "bg-primary"
                      : "bg-muted-foreground/30",
                )}
              />
              <span
                className={cn(
                  "whitespace-pre-wrap break-words",
                  streamColor[entry.stream] ?? "text-[#c9d5cc]",
                )}
              >
                {entry.line || " "}
              </span>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
