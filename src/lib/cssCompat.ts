import type { Plugin } from "vite";

export function chromium108CssCompatPlugin(): Plugin {
  const COLOR_RGB_MAP: Record<string, string> = {
    "--primary": "var(--primary-rgb, 155, 221, 107)",
    "--primary-foreground": "var(--primary-fg-rgb, 11, 20, 8)",
    "--foreground": "var(--foreground-rgb, 233, 239, 230)",
    "--background": "var(--background-rgb, 8, 11, 9)",
    "--card": "var(--card-rgb, 16, 21, 17)",
    "--card-foreground": "var(--foreground-rgb, 233, 239, 230)",
    "--popover": "var(--popover-rgb, 20, 26, 21)",
    "--popover-foreground": "var(--foreground-rgb, 233, 239, 230)",
    "--border": "var(--border-rgb, 38, 49, 42)",
    "--input": "var(--input-rgb, 42, 53, 45)",
    "--ring": "var(--ring-rgb, 155, 221, 107)",
    "--muted": "var(--muted-rgb, 23, 30, 25)",
    "--muted-foreground": "var(--muted-fg-rgb, 147, 163, 149)",
    "--accent": "var(--accent-rgb, 31, 42, 33)",
    "--accent-foreground": "var(--accent-fg-rgb, 240, 245, 236)",
    "--secondary": "var(--secondary-rgb, 27, 35, 29)",
    "--secondary-foreground": "var(--secondary-fg-rgb, 220, 230, 218)",
    "--sidebar": "var(--sidebar-rgb, 12, 16, 13)",
    "--sidebar-foreground": "var(--foreground-rgb, 233, 239, 230)",
    "--sidebar-accent": "var(--sidebar-accent-rgb, 24, 32, 25)",
    "--sidebar-accent-foreground": "var(--accent-fg-rgb, 240, 245, 236)",
    "--sidebar-border": "var(--border-rgb, 38, 49, 42)",
    "--destructive": "224, 115, 99",
    "--destructive-foreground": "255, 255, 255",
    "--success": "52, 211, 153",
    "--color-grass": "var(--primary-rgb, 155, 221, 107)",
    "--color-diamond": "109, 224, 208",
    "--color-gold": "227, 194, 105",
    "--color-ember": "229, 155, 104",
    "--color-pink-500": "246, 51, 154",
    "--color-amber-100": "254, 243, 198",
    "--color-amber-200": "254, 230, 133",
    "--color-amber-300": "255, 210, 54",
    "--color-amber-400": "252, 187, 0",
    "--color-amber-500": "249, 156, 0",
    "--color-amber-600": "221, 116, 0",
    "--color-emerald-400": "0, 210, 148",
    "--color-emerald-500": "0, 187, 127",
    "--color-cyan-400": "0, 210, 239",
    "--color-cyan-500": "0, 183, 215",
    "--color-sky-300": "119, 212, 255",
    "--color-sky-400": "0, 188, 254",
    "--color-sky-500": "0, 166, 244",
    "--color-orange-300": "255, 185, 109",
    "--color-orange-500": "254, 110, 0",
    "--color-rose-400": "255, 100, 130",
    "--color-rose-500": "244, 63, 94",
    "--color-purple-300": "216, 180, 254",
    "--color-purple-500": "168, 85, 247",
    "--color-violet-400": "167, 139, 250",
    "--color-violet-500": "139, 92, 246",
    "--color-slate-400": "148, 163, 184",
    "--color-white": "255, 255, 255",
    "--color-black": "0, 0, 0",
  };

  const VAR_EXPR = /^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/;

  /**
   * 只接受精确的变量名。早先的 includes 匹配会让 `--muted-foreground`
   * 先命中 `--muted`，把前景文字解析成接近黑色的背景色；
   * `--sidebar-accent` 也会先命中 `--sidebar`。精确匹配才能让
   * `/70`、`/80` 这类前景透明度使用正确的 `*-fg-rgb`。
   */
  function lookupRgb(token: string): string | undefined {
    const direct = COLOR_RGB_MAP[token];
    if (direct) return direct;

    // @theme inline 在不同 Tailwind 版本里可能生成 `--color-muted-foreground`。
    if (token.startsWith("--color-")) {
      return COLOR_RGB_MAP[`--${token.slice("--color-".length)}`];
    }

    return undefined;
  }

  function resolveRgba(colorExpr: string, pctStr: string): string | null {
    const alpha = (parseFloat(pctStr) / 100).toFixed(4).replace(/\.?0+$/, "");
    const cleanExpr = colorExpr.trim();

    if (cleanExpr === "currentcolor" || cleanExpr === "currentColor") {
      // rgba() 不接受 currentColor；保留原色比生成非法声明更安全。
      return null;
    }

    const varMatch = cleanExpr.match(VAR_EXPR);
    const token = varMatch ? varMatch[1] : cleanExpr;
    const rgb = lookupRgb(token);
    return rgb ? `rgba(${rgb}, ${alpha})` : null;
  }

  function transformCss(code: string): string {
    // 1. 提取所有 @supports 块内的规则及其映射
    const supportsRe = /@supports \(color:color-mix\(in lab, red, red\)\)\{([^{}]+?\{[^{}]+?\})\}/g;
    const ruleReplacements = new Map<string, string>();

    let match: RegExpExecArray | null;
    while ((match = supportsRe.exec(code)) !== null) {
      const innerRule = match[1];
      const cmMatch = innerRule.match(
        /^([^{}]+)\{([^:]+):color-mix\(in oklab,\s*([^,]+?)\s+([\d.]+)%,\s*transparent\)\}$/
      );
      if (cmMatch) {
        const [, selector, property, colorExpr, pct] = cmMatch;
        const rgbaVal = resolveRgba(colorExpr, pct);
        if (rgbaVal) {
          ruleReplacements.set(`${selector.trim()}|${property.trim()}`, rgbaVal);
        }
      }
    }

    // 2. 彻底剔除纯色 fallback（包括带有逗号的多选择器分组）
    let result = code.replace(
      /([^{}]+)\{([^:]+):var\((--[\w-]+)\)\}/g,
      (fullDecl, selectorsGroup: string, property: string, varName: string) => {
        const propClean = property.trim();
        const selectors = selectorsGroup.split(",").map((s) => s.trim());
        const normalSelectors: string[] = [];
        const replacedRules: string[] = [];

        for (const sel of selectors) {
          const key = `${sel}|${propClean}`;
          if (ruleReplacements.has(key)) {
            replacedRules.push(`${sel}{${propClean}:${ruleReplacements.get(key)}}`);
          } else {
            normalSelectors.push(sel);
          }
        }

        if (replacedRules.length === 0) {
          return fullDecl;
        }

        const parts: string[] = [];
        if (normalSelectors.length > 0) {
          parts.push(`${normalSelectors.join(",")}{${propClean}:var(${varName})}`);
        }
        parts.push(...replacedRules);
        return parts.join("");
      }
    );

    // 3. 彻底移除所有 @supports (color:color-mix(...)) 冗余块
    result = result.replace(/@supports \(color:color-mix\(in lab, red, red\)\)\{([^{}]+?\{[^{}]+?\})\}/g, "");

    return result;
  }

  return {
    name: "vite-plugin-chromium108-css-compat",
    enforce: "post",
    transform(code, id) {
      if (id.endsWith(".css") || id.includes("tailwind") || id.includes(".css?")) {
        return {
          code: transformCss(code),
          map: null,
        };
      }
      return null;
    },
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === "asset" && file.fileName.endsWith(".css") && typeof file.source === "string") {
          file.source = transformCss(file.source);
        }
      }
    },
  };
}
