// Background jobs: research batches, mailbox sync, daily drafts/follow-ups, auto-send, daily summary.
import { getBool, getNum, getSetting, setSetting } from '../lib/settings.js';
import { runResearch, isRunning } from './research.js';
import { syncMailbox } from './replies.js';
import { autoSendTick, generateDrafts, generateFollowups, runAutopilot, zonedNow, zonedClock } from './outreach.js';
import { saveDailySummary } from './reports.js';
import * as imap from '../integrations/imap.js';
import * as engine from './engine.js';
import { importFolder } from './discovery.js';
import { trackJob } from './jobs.js';

const autopilotJob = () => trackJob('autopilot', "Autopilot: preparing today's emails", {}, (ctx) => runAutopilot({ onProgress: ctx.progress }).then((r) => ({ ...r, summary: `${r.approved} email(s) approved to send · ${r.aiWritten} written by AI` })));

let timer = null;
const busy = new Set();

async function guarded(name, fn) {
  if (busy.has(name)) return;
  busy.add(name);
  try { await fn(); } catch (e) { console.error(`[scheduler] ${name}:`, e.message); } finally { busy.delete(name); }
}

const minutesSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 60000 : Infinity);

export async function tick() {
  const autopilot = getBool('autopilot_enabled');
  const engineOn = getBool('engine_enabled');
  // Lead engine: one search at a time, paced (see engine.tick)
  if (engineOn) guarded('engine', () => engine.tick());
  // Watched leads folder: new or changed CSV files are imported automatically
  if (getBool('watch_leads_folder') && minutesSince(getSetting('last_folder_check')) >= 10) {
    setSetting('last_folder_check', new Date().toISOString());
    guarded('folder', async () => { const r = importFolder(); if (r.files.length) await trackJob('import', 'Leads folder import', {}, async () => r); });
  }
  // Research batches (never sends email). With the engine on, research keeps up every 5 minutes.
  const researchEvery = engineOn ? Math.min(5, getNum('research_interval_minutes')) : getNum('research_interval_minutes');
  if ((getBool('research_auto_enabled') || autopilot || engineOn) && !isRunning() && minutesSince(getSetting('last_research_run')) >= researchEvery) {
    setSetting('last_research_run', new Date().toISOString());
    guarded('research', () => runResearch());
  }
  // Mailbox sync (Sent + Inbox)
  if (imap.isConfigured() && minutesSince(getSetting('imap_last_sync')) >= getNum('imap_sync_minutes')) {
    guarded('imap', () => trackJob('mailbox', 'Syncing Hostinger mailbox', {}, async () => { const r = await syncMailbox(); return { ...r, summary: `${r.replies || 0} replies, ${r.bounces || 0} bounces, ${r.optOuts || 0} opt-outs` }; }));
  }
  // Once per day (in the recipients' timezone): drafts + follow-ups + summary.
  // Autopilot also writes them with AI and approves them; otherwise they wait for you.
  // Once per recipients' day (send timezone), an hour before the send window opens.
  const dayKey = zonedClock().key;
  if (getSetting('last_daily_jobs') !== dayKey && zonedNow().hour >= Math.max(0, getNum('send_window_start') - 1)) {
    setSetting('last_daily_jobs', dayKey);
    guarded('daily', async () => {
      if (autopilot) { if (!busy.has('autopilot')) await autopilotJob(); }
      else {
        if (getBool('auto_draft_enabled')) generateDrafts();
        generateFollowups();
      }
      saveDailySummary();
    });
  }
  // Autopilot top-up: research finishes during the day, so newly READY leads can still go out today.
  if (autopilot && !busy.has('daily') && minutesSince(getSetting('last_autopilot_topup')) >= 60) {
    setSetting('last_autopilot_topup', new Date().toISOString());
    guarded('autopilot', () => autopilotJob());
  }
  // Auto-send approved messages, one per tick, respecting window/quota/spacing.
  guarded('send', () => autoSendTick());
}

export function startScheduler() {
  if (timer) return;
  timer = setInterval(() => { tick(); }, 60_000);
  setTimeout(() => tick(), 5000);
  console.log('[scheduler] started (60s tick)');
}

export function stopScheduler() {
  clearInterval(timer);
  timer = null;
}
