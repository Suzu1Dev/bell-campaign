import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AudioLines, ChevronDown, GitPullRequest, Highlighter, Share2, Sun } from "lucide-react";
import { suiteHandoffUrl, type SuiteHandoffTarget, type SuiteLinks } from "../../shared/suite";

const TARGET_SPECS: Array<{
  id: SuiteHandoffTarget;
  label: string;
  icon: typeof Sun;
}> = [
  { id: "explain", label: "在 BELL Explain 拆解", icon: AudioLines },
  { id: "reader", label: "在 Web Reader 閱讀", icon: Highlighter },
  { id: "personal", label: "送到 BELL Personal", icon: Sun },
  { id: "pr", label: "送到 BELL PR", icon: GitPullRequest },
];

export interface ResolvedHandoffTarget {
  id: SuiteHandoffTarget;
  label: string;
  href: string;
  icon: typeof Sun;
}

export function suiteHandoffTargets(
  links: SuiteLinks,
  payload: { text: string; title?: string; url?: string; back: string },
  currentHostname = "",
): ResolvedHandoffTarget[] {
  const items: ResolvedHandoffTarget[] = [];
  for (const spec of TARGET_SPECS) {
    const href = suiteHandoffUrl(
      spec.id,
      {
        origin: links[spec.id],
        text: payload.text,
        title: payload.title,
        url: payload.url,
        back: payload.back,
      },
      currentHostname,
    );
    if (href) {
      items.push({ id: spec.id, label: spec.label, href, icon: spec.icon });
    }
  }
  return items;
}

export default function SuiteHandoffMenu({
  links,
  text,
  title,
  url,
  back,
  compact = false,
  className = "",
}: {
  links: SuiteLinks;
  text: string;
  title?: string;
  url?: string;
  back: string;
  compact?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [flip, setFlip] = useState({ up: false, left: false });
  const menuId = useId();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const hostname = typeof window !== "undefined" ? window.location.hostname : "";
  const targets = useMemo(
    () => suiteHandoffTargets(links, { text, title, url, back }, hostname),
    [links, text, title, url, back, hostname],
  );

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    // Intercept Escape in window capture before Radix DismissableLayer's document capture closes parent Dialog.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;

    const tRect = trigger.getBoundingClientRect();
    const mRect = menu.getBoundingClientRect();
    const dialogBounds = trigger.closest(".dialog-content")?.getBoundingClientRect();
    const bounds = dialogBounds ?? {
      top: 8,
      bottom: window.innerHeight - 8,
      left: 8,
      right: window.innerWidth - 8,
    };

    const up = tRect.bottom + mRect.height + 6 > bounds.bottom - 8 && tRect.top - mRect.height - 6 >= bounds.top + 8;
    const left = tRect.right - mRect.width < bounds.left + 8;
    setFlip((prev) => (prev.up === up && prev.left === left ? prev : { up, left }));

    const first = menu.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
  }, [open]);

  if (targets.length === 0) return null;

  function onMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(idx + 1) % items.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(idx - 1 + items.length) % items.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  }

  return (
    <div ref={wrapRef} className={`suite-handoff-wrap ${className}`.trim()}>
      <button
        ref={triggerRef}
        type="button"
        className={`btn btn-sm suite-handoff-trigger ${compact ? "is-compact" : ""}`.trim()}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <Share2 size={12} aria-hidden="true" />
        <span>傳送到 Suite</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          className={`suite-handoff-popover ${flip.up ? "is-up" : ""} ${flip.left ? "is-left" : ""}`.trim()}
          onKeyDown={onMenuKeyDown}
        >
          {targets.map((item) => {
            const Icon = item.icon;
            return (
              <a
                key={item.id}
                role="menuitem"
                href={item.href}
                className={`suite-handoff-item is-${item.id}`}
                onClick={() => setOpen(false)}
              >
                <span className={`suite-handoff-dot is-${item.id}`} aria-hidden="true">
                  <Icon size={13} />
                </span>
                <span>{item.label}</span>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
