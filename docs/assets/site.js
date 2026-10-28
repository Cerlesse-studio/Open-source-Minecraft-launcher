/* ==========================================================================
   Open-source-Minecraft-launcher — official site interactions
   ========================================================================== */

(() => {
  "use strict";

  const doc = document;
  const root = doc.documentElement;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ------------------------------------------------------------------------
     Icon sprite
     ---------------------------------------------------------------------- */

  const sprite = `
<svg class="icon-sprite" aria-hidden="true" focusable="false" width="0" height="0" style="position:absolute;overflow:hidden">
  <symbol id="icon-arrow-right" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></symbol>
  <symbol id="icon-arrow-up-right" viewBox="0 0 24 24"><path d="M7 17 17 7M7 7h10v10"/></symbol>
  <symbol id="icon-chevron-right" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></symbol>
  <symbol id="icon-chevron-down" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></symbol>
  <symbol id="icon-download" viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></symbol>
  <symbol id="icon-github" viewBox="0 0 24 24"><path fill="currentColor" d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.1c-3.3.7-4-1.6-4-1.6-.5-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.7 18.3 5 18.3 5c.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3Z"/></symbol>
  <symbol id="icon-menu" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></symbol>
  <symbol id="icon-close" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></symbol>
  <symbol id="icon-check" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></symbol>
  <symbol id="icon-copy" viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></symbol>
  <symbol id="icon-terminal" viewBox="0 0 24 24"><path d="m4 17 6-5-6-5M12 19h8"/></symbol>
  <symbol id="icon-book" viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5V6a2 2 0 0 1 2-2h14v15H6.5A2.5 2.5 0 0 0 4 21.5V19.5Z"/></symbol>
  <symbol id="icon-code" viewBox="0 0 24 24"><path d="m8 6-6 6 6 6M16 6l6 6-6 6"/></symbol>
  <symbol id="icon-layers" viewBox="0 0 24 24"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></symbol>
  <symbol id="icon-package" viewBox="0 0 24 24"><path d="m21 8-9 5-9-5 9-5 9 5Z"/><path d="M3 8v8l9 5 9-5V8M12 13v8"/></symbol>
  <symbol id="icon-shield" viewBox="0 0 24 24"><path d="M12 3 4.5 6v5.5c0 4.8 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.7 7.5-9.5V6L12 3Z"/><path d="m9 12 2 2 4-4"/></symbol>
  <symbol id="icon-cloud" viewBox="0 0 24 24"><path d="M17.5 19H7a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.6 1.5A3.8 3.8 0 0 1 17.5 19Z"/><path d="m9 14 3 3 3-3M12 17v-6"/></symbol>
  <symbol id="icon-users" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/></symbol>
  <symbol id="icon-monitor" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></symbol>
  <symbol id="icon-laptop" viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20M9 16h6"/></symbol>
  <symbol id="icon-cpu" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></symbol>
  <symbol id="icon-palette" viewBox="0 0 24 24"><path d="M12 3a9 9 0 0 0 0 18h1.5a2 2 0 0 0 1.2-3.6 1.8 1.8 0 0 1 1.1-3.2H18a3 3 0 0 0 3-3A9 9 0 0 0 12 3Z"/><circle cx="7.5" cy="10.5" r=".8" fill="currentColor" stroke="none"/><circle cx="10" cy="7" r=".8" fill="currentColor" stroke="none"/><circle cx="14" cy="6.5" r=".8" fill="currentColor" stroke="none"/><circle cx="17" cy="9.5" r=".8" fill="currentColor" stroke="none"/></symbol>
  <symbol id="icon-sparkles" viewBox="0 0 24 24"><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3ZM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z"/></symbol>
  <symbol id="icon-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></symbol>
  <symbol id="icon-warning" viewBox="0 0 24 24"><path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 9v5M12 17h.01"/></symbol>
  <symbol id="icon-lightbulb" viewBox="0 0 24 24"><path d="M9 18h6M10 22h4M8.5 14.5A6 6 0 1 1 15.5 14.5c-.9.7-1.5 1.7-1.5 2.5h-4c0-.8-.6-1.8-1.5-2.5Z"/></symbol>
  <symbol id="icon-zap" viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/></symbol>
  <symbol id="icon-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.8 5.6 3.8 9S14.5 18.5 12 21c-2.5-2.5-3.8-5.6-3.8-9S9.5 5.5 12 3Z"/></symbol>
  <symbol id="icon-windows" viewBox="0 0 24 24"><path d="M3 5.5 10.5 4.5v7H3zM11.5 4.3 21 3v8.5h-9.5zM3 12.5h7.5v7L3 18.5zM11.5 12.5H21V21l-9.5-1.3z"/></symbol>
  <symbol id="icon-chat" viewBox="0 0 24 24"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8Z"/></symbol>
  <symbol id="icon-heart" viewBox="0 0 24 24"><path d="M20.8 5.6a5.5 5.5 0 0 0-7.8 0L12 6.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 22l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z"/></symbol>
  <symbol id="icon-star" viewBox="0 0 24 24"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z"/></symbol>
  <symbol id="icon-refresh" viewBox="0 0 24 24"><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8M3 21v-5h5M21 3v5h-5"/></symbol>
  <symbol id="icon-folder" viewBox="0 0 24 24"><path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z"/></symbol>
  <symbol id="icon-file" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z"/><path d="M14 2v6h6M8 13h8M8 17h6"/></symbol>
  <symbol id="icon-map" viewBox="0 0 24 24"><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15M15 6v15"/></symbol>
  <symbol id="icon-wifi" viewBox="0 0 24 24"><path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5.5 5.5 0 0 1 7 0M12 20h.01M2 9a15 15 0 0 1 20 0"/></symbol>
  <symbol id="icon-lock" viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></symbol>
  <symbol id="icon-server" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/></symbol>
  <symbol id="icon-database" viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></symbol>
  <symbol id="icon-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7L8 5Z"/></symbol>
  <symbol id="icon-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></symbol>
  <symbol id="icon-scale" viewBox="0 0 24 24"><path d="M12 3v18M7 6h10M5 21h14M7 6l-4 8h8L7 6ZM17 6l-4 8h8l-4-8Z"/></symbol>
  <symbol id="icon-link" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/></symbol>
  <symbol id="icon-home" viewBox="0 0 24 24"><path d="m3 11 9-8 9 8v9a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1v-9Z"/></symbol>
</svg>`;

  doc.body.insertAdjacentHTML("afterbegin", sprite);

  /* ------------------------------------------------------------------------
     Header and mobile navigation
     ---------------------------------------------------------------------- */

  const header = doc.querySelector(".site-header");
  const navToggle = doc.querySelector("[data-nav-toggle]");
  const mobileNav = doc.querySelector("[data-mobile-nav]");
  let lastFocused = null;

  const syncHeader = () => {
    if (header) header.classList.toggle("is-scrolled", window.scrollY > 8);
    const top = doc.querySelector("[data-to-top]");
    if (top) top.classList.toggle("is-visible", window.scrollY > 700);
  };

  const setNavIcon = (open) => {
    if (!navToggle) return;
    const use = navToggle.querySelector("use");
    if (use) use.setAttribute("href", open ? "#icon-close" : "#icon-menu");
  };

  const closeNav = () => {
    if (!mobileNav || !navToggle) return;
    mobileNav.classList.remove("is-open");
    navToggle.setAttribute("aria-expanded", "false");
    doc.body.classList.remove("nav-open");
    setNavIcon(false);
    if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
    lastFocused = null;
  };

  const openNav = () => {
    if (!mobileNav || !navToggle) return;
    lastFocused = doc.activeElement;
    mobileNav.classList.add("is-open");
    navToggle.setAttribute("aria-expanded", "true");
    doc.body.classList.add("nav-open");
    setNavIcon(true);
    const first = mobileNav.querySelector("a, button");
    if (first) first.focus();
  };

  if (navToggle && mobileNav) {
    navToggle.addEventListener("click", () => {
      if (mobileNav.classList.contains("is-open")) closeNav();
      else openNav();
    });

    mobileNav.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", closeNav);
    });

    doc.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && mobileNav.classList.contains("is-open")) closeNav();
    });

    const desktop = window.matchMedia("(min-width: 941px)");
    const onChange = (event) => {
      if (event.matches) closeNav();
    };
    if (typeof desktop.addEventListener === "function") desktop.addEventListener("change", onChange);
  }

  /* ------------------------------------------------------------------------
     Scroll reveal
     ---------------------------------------------------------------------- */

  const revealItems = Array.from(doc.querySelectorAll("[data-reveal]"));
  if (revealItems.length) {
    if (reduceMotion || !("IntersectionObserver" in window)) {
      revealItems.forEach((item) => item.classList.add("is-visible"));
    } else {
      revealItems.forEach((item) => item.classList.add("reveal"));
      const revealObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            entry.target.classList.add("is-visible");
            revealObserver.unobserve(entry.target);
          });
        },
        { threshold: 0.1, rootMargin: "0px 0px -40px" },
      );
      revealItems.forEach((item) => revealObserver.observe(item));
    }
  }

  /* ------------------------------------------------------------------------
     Gallery
     ---------------------------------------------------------------------- */

  const gallery = doc.querySelector("[data-gallery]");
  if (gallery) {
    const tabs = Array.from(gallery.querySelectorAll("[data-shot]"));
    const image = gallery.querySelector("[data-gallery-image]");
    const caption = gallery.querySelector("[data-gallery-caption]");
    const link = gallery.querySelector("[data-gallery-link]");
    const frame = gallery.querySelector(".gallery-frame");
    let shotToken = 0;

    const selectShot = (tab) => {
      if (!image) return;
      const src = tab.getAttribute("data-src");
      const alt = tab.getAttribute("data-alt") || "";
      const text = tab.getAttribute("data-caption") || "";
      if (!src) return;

      tabs.forEach((item) => {
        const active = item === tab;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-pressed", active ? "true" : "false");
      });

      frame?.classList.add("is-switching");
      const token = ++shotToken;
      const next = new Image();
      const commit = () => {
        if (token !== shotToken) return;
        image.src = src;
        image.alt = alt;
        if (caption) caption.textContent = text;
        if (link) link.href = src;
        frame?.classList.remove("is-switching");
      };
      next.onload = commit;
      next.onerror = commit;
      next.decoding = "async";
      next.src = src;
    };

    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => selectShot(tab));
      tab.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
        event.preventDefault();
        const direction = event.key === "ArrowRight" ? 1 : -1;
        const nextIndex = (index + direction + tabs.length) % tabs.length;
        tabs[nextIndex].focus();
        selectShot(tabs[nextIndex]);
      });
    });
  }

  /* ------------------------------------------------------------------------
     Docs sidebar active section
     ---------------------------------------------------------------------- */

  const docsNav = doc.querySelector("[data-docs-nav]");
  if (docsNav) {
    const links = Array.from(docsNav.querySelectorAll('a[href^="#"]'));
    const sections = links
      .map((link) => {
        const id = link.getAttribute("href")?.slice(1);
        return id ? doc.getElementById(id) : null;
      })
      .filter(Boolean);

    let ticking = false;

    const updateDocsNav = () => {
      ticking = false;
      const offset = (header?.offsetHeight || 74) + 90;
      let active = sections[0];
      sections.forEach((section) => {
        if (section.getBoundingClientRect().top <= offset) active = section;
      });
      if (!active) return;
      links.forEach((link) => {
        const isActive = link.getAttribute("href") === `#${active.id}`;
        link.classList.toggle("is-active", isActive);
        if (isActive) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      });
    };

    const requestUpdate = () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(updateDocsNav);
    };

    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);
    updateDocsNav();
  }

  /* ------------------------------------------------------------------------
     Copy buttons
     ---------------------------------------------------------------------- */

  const copyText = async (text) => {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const area = doc.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    doc.body.appendChild(area);
    area.select();
    const ok = doc.execCommand("copy");
    area.remove();
    if (!ok) throw new Error("copy failed");
  };

  doc.querySelectorAll(".copy-btn").forEach((button) => {
    button.addEventListener("click", async () => {
      const block = button.closest(".code-block");
      const code = block?.querySelector("code")?.innerText ?? "";
      if (!code) return;
      const original = button.textContent;
      try {
        await copyText(code);
        button.textContent = "已复制";
        button.classList.add("is-copied");
      } catch {
        button.textContent = "复制失败";
      }
      window.setTimeout(() => {
        button.textContent = original;
        button.classList.remove("is-copied");
      }, 1600);
    });
  });

  /* ------------------------------------------------------------------------
     Copy command helpers
     ---------------------------------------------------------------------- */

  doc.querySelectorAll("[data-copy-text]").forEach((button) => {
    button.addEventListener("click", async () => {
      const text = button.getAttribute("data-copy-text") || "";
      if (!text) return;
      const original = button.getAttribute("data-label") || button.textContent;
      try {
        await copyText(text);
        button.textContent = "已复制";
      } catch {
        button.textContent = "复制失败";
      }
      window.setTimeout(() => {
        button.textContent = original;
      }, 1600);
    });
  });

  /* ------------------------------------------------------------------------
     Download page: detect the visitor's OS
     ---------------------------------------------------------------------- */

  const detectOS = () => {
    const platform = `${navigator.userAgentData?.platform || ""} ${navigator.platform || ""} ${navigator.userAgent || ""}`.toLowerCase();
    if (platform.includes("win")) return "windows";
    if (platform.includes("mac")) return "macos";
    if (platform.includes("linux") || platform.includes("x11")) return "linux";
    return "";
  };

  const os = detectOS();
  const platformCards = Array.from(doc.querySelectorAll("[data-os]"));
  if (platformCards.length && os) {
    platformCards.forEach((card) => {
      card.classList.toggle("is-detected", card.getAttribute("data-os") === os);
    });
    const note = doc.querySelector("[data-os-note]");
    if (note) {
      const labels = { windows: "Windows 10 / 11", macos: "macOS", linux: "Linux" };
      note.textContent = `已检测到 ${labels[os] || "当前系统"}`;
    }
  }

  /* ------------------------------------------------------------------------
     Scroll to top
     ---------------------------------------------------------------------- */

  const toTop = doc.createElement("button");
  toTop.type = "button";
  toTop.className = "to-top";
  toTop.setAttribute("data-to-top", "");
  toTop.setAttribute("aria-label", "回到顶部");
  toTop.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-chevron-down"></use></svg>';
  toTop.querySelector("svg")?.style.setProperty("transform", "rotate(180deg)");
  toTop.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  });
  doc.body.appendChild(toTop);

  /* ------------------------------------------------------------------------
     Footer year
     ---------------------------------------------------------------------- */

  doc.querySelectorAll("[data-year]").forEach((el) => {
    el.textContent = String(new Date().getFullYear());
  });

  /* ------------------------------------------------------------------------
     Initial state
     ---------------------------------------------------------------------- */

  syncHeader();
  window.addEventListener("scroll", syncHeader, { passive: true });
  root.classList.add("site-ready");
})();
