import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export type Notify = (
  tone: "success" | "error" | "info",
  title: string,
  detail?: string,
) => void;

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyButton({
  value,
  label = "复制",
  onNotify,
  className,
}: {
  value: string;
  label?: string;
  onNotify: Notify;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      className={cn("h-6 gap-1 px-1.5 text-[10px]", className)}
      disabled={!value}
      onClick={() => {
        void copyText(value).then((ok) => {
          setCopied(ok);
          if (ok) window.setTimeout(() => setCopied(false), 1600);
          else onNotify("error", "复制失败", "请手动选中内容复制。");
        });
      }}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? "已复制" : label}
    </Button>
  );
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <Label className="mb-1.5 block text-[11px] font-medium text-muted-foreground">
      {children}
    </Label>
  );
}

/** A titled card, so every room panel shares the same border and header. */
export function Panel({
  title,
  icon,
  action,
  children,
  className,
  bodyClassName,
}: {
  title: string;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("flex flex-col rounded-xl border border-border/70 bg-card/55", className)}>
      <header className="flex min-h-9 items-center gap-2 border-b border-border/60 px-4 py-2.5">
        {icon}
        <span className="flex-1 text-[12px] font-medium">{title}</span>
        {action}
      </header>
      <div className={cn("flex-1", bodyClassName)}>{children}</div>
    </section>
  );
}

export function RoomLogPanel({ logs }: { logs: string[] }) {
  return (
    <details className="group overflow-hidden rounded-xl border border-border/70 bg-card/45">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
        日志
        <Badge
          variant="outline"
          className="h-4 px-1 font-mono text-[9px] font-normal text-muted-foreground"
        >
          {logs.length}
        </Badge>
        <span className="ml-auto text-[9.5px] text-muted-foreground/50 group-open:hidden">
          排障用
        </span>
      </summary>
      <div className="max-h-52 space-y-1 overflow-y-auto border-t border-border/50 bg-background/40 px-4 py-2.5 font-mono text-[10px] leading-4">
        {logs.length === 0 ? (
          <p className="text-muted-foreground/60">暂无日志</p>
        ) : (
          logs.map((line, index) => (
            <p
              key={`${index}-${line.slice(0, 12)}`}
              className={cn(
                "break-words whitespace-pre-wrap",
                line.includes("[stderr]") ? "text-gold/80" : "text-muted-foreground",
              )}
            >
              {line}
            </p>
          ))
        )}
      </div>
    </details>
  );
}
