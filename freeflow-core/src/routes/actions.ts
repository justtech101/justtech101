import { Router } from "express";
import { verifyAction, type ActionKind } from "../core/actions.js";
import type { Deps } from "../core/deps.js";
import { prettyPhone } from "../core/phone.js";
import { getLead, logEvent } from "../core/store.js";
import { pauseLead, resetLead } from "../flows/controls.js";

const LABEL: Record<ActionKind, string> = {
  sent: "Mark this text as sent",
  pause: "Pause automation on this lead (I'll handle it myself)",
  reset: "Reset this lead and restart follow-up",
};

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
:root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--accent:#1a73e8}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#eee;--muted:#aaa;--accent:#8ab4f8}}
body{background:var(--bg);color:var(--fg);font:17px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px;max-width:520px}
p{color:var(--muted)}button{font:inherit;padding:14px 20px;border:0;border-radius:10px;background:var(--accent);color:#fff;width:100%}
</style></head><body>${body}</body></html>`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * One-tap links from owner emails. GET shows a confirm button and POST does the
 * work, so email link scanners that pre-fetch links can't trigger anything.
 */
export function actionRoutes(deps: Deps): Router {
  const r = Router();

  r.get("/a/:token", async (req, res) => {
    const p = verifyAction(deps.env.ACTION_SECRET, req.params.token, deps.clock());
    if (!p) return void res.status(404).send(page("Link expired", "<h2>This link has expired or is invalid.</h2>"));
    const lead = await getLead(deps.db, p.lead);
    if (!lead) return void res.status(404).send(page("Not found", "<h2>Lead not found.</h2>"));
    res.send(page(LABEL[p.do], `<h2>${esc(LABEL[p.do])}</h2><p>${esc(lead.name ?? "")} ${esc(prettyPhone(lead.phone))}</p>
<form method="post"><button type="submit">Confirm</button></form>`));
  });

  r.post("/a/:token", async (req, res) => {
    const p = verifyAction(deps.env.ACTION_SECRET, req.params.token, deps.clock());
    if (!p) return void res.status(404).send(page("Link expired", "<h2>This link has expired or is invalid.</h2>"));
    const lead = await getLead(deps.db, p.lead);
    if (!lead) return void res.status(404).send(page("Not found", "<h2>Lead not found.</h2>"));
    const now = deps.clock();
    let done = "";
    if (p.do === "sent" && p.message) {
      await deps.db.query(`UPDATE messages SET status = 'sent' WHERE id = $1 AND lead_id = $2 AND status = 'drafted'`, [p.message, lead.id]);
      await logEvent(deps.db, lead.id, "owner_sent", `message ${p.message} sent by owner from Google Voice`, now);
      done = "Marked as sent.";
    } else if (p.do === "pause") {
      await pauseLead(deps, lead, "owner email link");
      done = "Paused — this lead is yours. No more drafts or follow-ups for it.";
    } else if (p.do === "reset") {
      await resetLead(deps, lead, "owner email link");
      done = "Reset — follow-up restarted.";
    }
    res.send(page("Done", `<h2>${esc(done)}</h2><p>${esc(lead.name ?? "")} ${esc(prettyPhone(lead.phone))}</p>`));
  });

  return r;
}
