/**
 * The panel's look, drawn from the host's theme variables so it follows
 * DorkOS's light and dark themes. The host's colors are HSL channel triples
 * (`--muted: 0 0% 96%`), so each is read as `hsl(var(--name))`.
 *
 * One stylesheet, every class under `.rm`, so nothing leaks into the host.
 * It is a stylesheet rather than inline styles for the parts inline styles
 * can't do: focus rings, two-line clamps, and 44px targets on touch screens.
 * Nothing moves: there are no transitions or animations, so reduced motion
 * needs nothing of its own.
 *
 * @module @dorkos/roadmap/extension/ui/styles
 */

/** The panel's stylesheet. */
export const CSS = `
.rm{color:hsl(var(--foreground));font-size:13px;line-height:1.45;padding:12px 14px 28px;overflow-wrap:anywhere;max-width:100%}
.rm *{box-sizing:border-box}
.rm h2,.rm h3,.rm h4,.rm p,.rm ul,.rm dl,.rm dd{margin:0}
.rm ul{padding:0;list-style:none}
.rm-h1{font-size:15px;font-weight:600}
.rm-muted{color:hsl(var(--muted-foreground))}
.rm-small{font-size:12px}
.rm-nowrap{white-space:nowrap;flex:none}
.rm-faint{color:hsl(var(--muted-foreground));opacity:.75}
.rm-red{color:hsl(var(--status-error))}
.rm-row{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px}
.rm-between{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.rm-section{margin-top:18px}
.rm-section-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:13px;font-weight:600;margin-bottom:6px}
.rm-count{font-size:12px;font-weight:500;color:hsl(var(--muted-foreground))}
.rm-badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:999px;font-size:11px;font-weight:600;background:hsl(var(--muted));color:hsl(var(--muted-foreground))}
.rm-badge[data-brand]{background:hsl(var(--brand) / .16);color:hsl(var(--brand-text));font-weight:700}
.rm-card{position:relative;border:1px solid hsl(var(--border));background:hsl(var(--card));border-radius:8px;padding:9px 10px;margin-top:6px}
.rm-card[data-new]{background:hsl(var(--brand) / .08);border-color:hsl(var(--brand) / .35)}
.rm-title{font-weight:500;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rm-chip{display:inline-block;font-size:10px;font-weight:500;letter-spacing:.04em;text-transform:uppercase;border-radius:4px;padding:0 5px;border:1px solid hsl(var(--border));background:transparent;color:hsl(var(--muted-foreground))}
.rm-chip[data-must]{font-weight:800;color:hsl(var(--foreground))}
.rm-ask{color:hsl(var(--brand-text))}
.rm-chevron{flex:none}
.rm-chevron[data-open]{transform:rotate(90deg)}
.rm-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin-top:6px;font-size:12px;color:hsl(var(--muted-foreground))}
.rm-btn{font:inherit;font-size:12px;line-height:1.2;white-space:nowrap;flex:none;border:1px solid hsl(var(--border));background:hsl(var(--background));color:inherit;border-radius:6px;padding:5px 10px;min-height:28px;cursor:pointer}
.rm-btn[data-solid]{background:hsl(var(--foreground));color:hsl(var(--background));border-color:hsl(var(--foreground))}
.rm-link{display:inline-flex;align-items:center;min-height:24px;font:inherit;font-size:12px;background:none;border:0;padding:0;color:inherit;font-weight:500;text-decoration:underline;text-decoration-color:hsl(var(--muted-foreground) / .5);text-underline-offset:2px;cursor:pointer}
.rm-cardbtn{min-height:24px;font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;text-align:left;cursor:pointer;width:100%;display:block}
.rm-icon-btn{font:inherit;font-size:16px;line-height:1;color:hsl(var(--foreground) / .8);background:none;border:0;border-radius:6px;min-width:28px;min-height:28px;cursor:pointer;flex:none}
.rm-icon-btn:hover,.rm-icon-btn:focus-visible,.rm-icon-btn[aria-expanded=true]{background:hsl(var(--muted));color:hsl(var(--foreground))}
.rm-btn:focus-visible,.rm-link:focus-visible,.rm-cardbtn:focus-visible,.rm-icon-btn:focus-visible,.rm-menu-item:focus-visible{outline:2px solid hsl(var(--ring));outline-offset:2px}
.rm-dim{opacity:.55}
.rm-banner{display:flex;gap:8px;align-items:flex-start;justify-content:space-between;border:1px solid hsl(var(--border));background:hsl(var(--muted));border-radius:8px;padding:8px 10px;margin-top:10px;font-size:12px}
.rm-pill{position:sticky;top:6px;z-index:2;display:flex;align-items:center;gap:8px;width:fit-content;max-width:100%;margin:0 auto 8px;border-radius:999px;background:hsl(var(--foreground));color:hsl(var(--background));padding:4px 4px 4px 12px;font-size:12px}
.rm-pill .rm-btn{border-radius:999px;min-height:24px;padding:3px 10px}
.rm-feed li{padding:7px 0;border-bottom:1px solid hsl(var(--border) / .6)}
.rm-feed li:last-child{border-bottom:0}
.rm-menu{position:absolute;right:6px;top:34px;z-index:3;min-width:180px;background:hsl(var(--card));border:1px solid hsl(var(--border));border-radius:8px;padding:4px;box-shadow:0 6px 18px rgb(0 0 0 / .14)}
.rm-menu-item{font:inherit;font-size:13px;color:inherit;background:none;border:0;border-radius:6px;padding:6px 8px;width:100%;text-align:left;cursor:pointer}
.rm-menu-item:hover{background:hsl(var(--muted))}
.rm-details{margin-top:8px;padding-top:8px;border-top:1px solid hsl(var(--border) / .6);display:grid;gap:8px}
.rm-fields{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;font-size:12px}
.rm-fields dt{color:hsl(var(--muted-foreground))}
.rm-links{display:flex;flex-wrap:wrap;gap:6px}
.rm-linkchip{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;border:1px solid hsl(var(--border));border-radius:4px;padding:1px 6px;color:inherit;text-decoration:none}
.rm-empty{text-align:center;padding:28px 8px}
.rm-empty .rm-row{justify-content:center;margin-top:12px}
@media (pointer:coarse){.rm-btn,.rm-link,.rm-icon-btn,.rm-menu-item{min-height:44px;min-width:44px}}
`;
