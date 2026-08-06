// ─── Diagnostics dialog ("things aren't loading") ─────────────────────────────
// Role: renders and drives the Diagnostics dialog. Pre-renders one row per
//       DIAG_CHECKS entry in a pending state (so the user sees the full check
//       list immediately), then fills each row in as runDiagnostics' onResult
//       callback streams results in — rows settle individually, not all at
//       once. Lazy chunk: loaded only on File > Diagnostics… (see
//       ui-menubar.ts) so the probe catalogue and its dependency graph (state,
//       constants, live-staleness, wildfire/nws-staleness) stay out of the
//       initial bundle, matching the draw-chunk.ts pattern.
// Deps: diagnostics.js (DIAG_CHECKS/runDiagnostics/buildDiagReport/DIAG_ENV),
//       diag-log.js (getDiagLog — the recorded-errors section, which is what
//       explains the File-menu dot wired in ui.ts),
//       utils/utils.js (escapeHtml — detail strings carry URLs and raw error
//       text). Dialog chrome (#diagnosticsDialog, close button, backdrop
//       click) lives in index.html / ui.ts; this module only ever touches
//       #diagBody and the footer's Copy report button.
// Collapsible groups reuse the single document-delegated .collapse-btn
// listener wired once in ui.ts (wireCollapseToggles) — this module emits
// matching [data-collapsible]/.collapse-btn/.collapsible-content markup and,
// once a run finishes, toggles the same `collapsed` class directly. It never
// registers its own click handler for that.

import {
  DIAG_CHECKS, DIAG_ENV, GROUP_TITLES, GROUP_ORDER, runDiagnostics, buildDiagReport,
} from '../diagnostics.js';
import type { DiagResult, DiagStatus } from '../diagnostics.js';
import { escapeHtml } from '../utils/utils.js';
import { getDiagLog } from '../diag-log.js';

const STATUS_GLYPH: Record<DiagStatus, string> = { ok: '✓', fail: '✕', warn: '!', skip: '–' };

const resultsById = new Map<string, DiagResult>();

export function openDiagnostics(): void {
  const dialog = document.getElementById('diagnosticsDialog') as HTMLDialogElement | null;
  if (!dialog) return;

  resultsById.clear();
  renderPending(dialog);
  wireCopyButton(dialog);
  dialog.showModal();
  void runAndFill(dialog);
}

function renderPending(dialog: HTMLDialogElement): void {
  const body = dialog.querySelector('#diagBody');
  if (!body) return;

  const envNote = DIAG_ENV === 'dev'
    ? `<p class="credits-disclaimer diag-env-note">Running in <strong>dev</strong> — layer-host probes resolve to
        localhost rather than the production data host, so results legitimately differ from production.</p>`
    : '';

  const groups = GROUP_ORDER.map(group => {
    const checks = DIAG_CHECKS.filter(c => c.group === group);
    if (!checks.length) return '';
    const rows = checks.map(c => renderRow(c.id, c.label)).join('');
    return `
      <div class="layer-section" data-collapsible data-diag-group="${group}">
        <div class="section-title"><button class="collapse-btn" type="button" aria-label="Toggle section" aria-expanded="true">▾</button> ${GROUP_TITLES[group]}</div>
        <div class="collapsible-content diag-rows">${rows}</div>
      </div>`;
  }).join('');

  body.innerHTML = `
    <p class="credits-disclaimer">A browser cannot tell a blocked request from a host being down from a CORS
      rejection — every result below is only what the browser observed, never proof of a firewall block.</p>
    ${envNote}
    ${groups}
    ${renderRecordedErrors()}
    <div class="layer-section collapsed" data-collapsible id="diagReportSection">
      <div class="section-title"><button class="collapse-btn" type="button" aria-label="Toggle section" aria-expanded="false">▸</button> Report text</div>
      <div class="collapsible-content"><textarea class="diag-report-text" id="diagReportText" readonly></textarea></div>
    </div>
  `;

  const copyBtn = dialog.querySelector<HTMLButtonElement>('#diagCopyReport');
  if (copyBtn) copyBtn.textContent = 'Copy report';
}

// What the map actually reported this session, as opposed to what the probes
// find right now. This is the section that explains the File-menu dot, and it
// names the specific layer that failed — the answer to "some layers are
// missing and I can't tell which".
function renderRecordedErrors(): string {
  const log = getDiagLog();
  const rows = log.length
    ? log.map(e => `
        <div class="diag-row">
          <span class="diag-icon diag-icon--fail" aria-hidden="true">✕</span>
          <div>
            <div class="diag-row-label">${escapeHtml(new Date(e.ts).toLocaleTimeString())} · ${escapeHtml(e.source)}</div>
            <div class="diag-row-detail">${escapeHtml(e.detail)}</div>
          </div>
        </div>`).join('')
    : `<div class="diag-row"><span class="diag-icon diag-icon--ok" aria-hidden="true">✓</span>
         <div><div class="diag-row-detail">Nothing failed since this page was opened.</div></div></div>`;

  return `
    <div class="layer-section${log.length ? '' : ' collapsed'}" data-collapsible>
      <div class="section-title"><button class="collapse-btn" type="button" aria-label="Toggle section" aria-expanded="${log.length ? 'true' : 'false'}">${log.length ? '▾' : '▸'}</button> What this session reported (${log.length})</div>
      <div class="collapsible-content diag-rows">${rows}</div>
    </div>`;
}

// Always pending: runAndFill patches each row's icon and detail in place as
// results stream back.
function renderRow(id: string, label: string): string {
  return `
    <div class="diag-row" data-diag-row="${id}">
      <span class="diag-icon diag-icon--pending" aria-hidden="true">…</span>
      <div>
        <div class="diag-row-label">${label}</div>
        <div class="diag-row-detail">checking…</div>
      </div>
    </div>`;
}

async function runAndFill(dialog: HTMLDialogElement): Promise<void> {
  const results = await runDiagnostics(result => {
    resultsById.set(result.id, result);
    const row = dialog.querySelector(`[data-diag-row="${CSS.escape(result.id)}"]`);
    if (!row) return;
    const icon = row.querySelector('.diag-icon');
    const detailEl = row.querySelector('.diag-row-detail');
    if (icon) {
      icon.className = `diag-icon diag-icon--${result.status}`;
      icon.textContent = STATUS_GLYPH[result.status];
    }
    if (detailEl) detailEl.textContent = result.detail;
  });

  // Now that every check has settled, collapse the groups that turned out
  // entirely ok/skip — groups holding a fail or a warn stay open so the
  // problem is visible without an extra click.
  for (const group of GROUP_ORDER) {
    const checks = DIAG_CHECKS.filter(c => c.group === group);
    if (!checks.length) continue;
    const allQuiet = checks.every(c => {
      const s = resultsById.get(c.id)?.status;
      return s === 'ok' || s === 'skip';
    });
    if (!allQuiet) continue;
    const section = dialog.querySelector(`[data-diag-group="${group}"]`);
    const btn = section?.querySelector<HTMLElement>('.collapse-btn');
    if (section && btn) {
      section.classList.add('collapsed');
      btn.setAttribute('aria-expanded', 'false');
      btn.textContent = '▸';
    }
  }

  // Fill the (collapsed) report section now that there is something to show.
  // Rendering it unconditionally means the report is always reachable, so the
  // Copy button is a convenience rather than the only way out — and the user
  // can read what they are about to send before they send it.
  const area = dialog.querySelector<HTMLTextAreaElement>('#diagReportText');
  if (area) area.value = buildDiagReport(results);
}

// Assigned rather than addEventListener'd so re-opening the dialog cannot stack
// duplicate handlers.
function wireCopyButton(dialog: HTMLDialogElement): void {
  const btn = dialog.querySelector<HTMLButtonElement>('#diagCopyReport');
  if (!btn) return;
  btn.onclick = async () => {
    const report = buildDiagReport(Array.from(resultsById.values()));
    const flash = (msg: string) => {
      const prev = btn.textContent;
      btn.textContent = msg;
      window.setTimeout(() => { btn.textContent = prev; }, 1500);
    };
    // A locked-down browser can withhold the clipboard API entirely, and this
    // panel's audience is the one most likely to meet that — so on failure open
    // the report section and select it, ready for Ctrl+C. A missing
    // navigator.clipboard throws here too, and lands in the same branch.
    try {
      await navigator.clipboard.writeText(report);
      flash('Copied');
    } catch {
      revealReport(dialog, report);
      flash('Select and copy');
    }
  };
}

function revealReport(dialog: HTMLDialogElement, report: string): void {
  const section = dialog.querySelector('#diagReportSection');
  const area = dialog.querySelector<HTMLTextAreaElement>('#diagReportText');
  if (!section || !area) return;
  section.classList.remove('collapsed');
  const btn = section.querySelector<HTMLElement>('.collapse-btn');
  if (btn) { btn.setAttribute('aria-expanded', 'true'); btn.textContent = '▾'; }
  area.value = report;
  area.select();
}
