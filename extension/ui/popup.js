/**
 * Popup controller.
 *
 * Renders, from persisted storage only (never from worker memory):
 *   1. the Library Report with exact counts;
 *   2. read-only, filtered bookmark lists behind every clickable report line.
 *
 * Filtering is done against the persisted records snapshot, so an exact
 * match between a report number and the items shown is guaranteed. Opening a
 * bookmark wants an active tab, which is why the extension requests
 * activeTab at install (permission is only exercised when the user interacts
 * with a list item).
 */
(function (root) {
  'use strict';
  const C = root.BRConstants;
  const { KEYS, PHASE, METRIC, COPY } = C;

  const els = {
    title: document.getElementById('app-title'),
    scanBtn: document.getElementById('scan-btn'),
    backupBtn: document.getElementById('backup-btn'),
    status: document.getElementById('status'),
    linkCheck: document.getElementById('link-check'),
    report: document.getElementById('report'),
    listPanel: document.getElementById('list-panel'),
    listTitle: document.getElementById('list-title'),
    listClose: document.getElementById('list-close'),
    listCount: document.getElementById('list-count'),
    listItems: document.getElementById('list-items'),
    listCleanup: document.getElementById('list-cleanup'),
    cleanupRemoveBtn: document.getElementById('cleanup-remove-btn'),
    listSel: document.getElementById('list-sel'),
    trashBtn: document.getElementById('trash-btn'),
    trashPanel: document.getElementById('trash-panel'),
    trashTitle: document.getElementById('trash-title'),
    trashBack: document.getElementById('trash-back'),
    trashNote: document.getElementById('trash-note'),
    trashRestoreBtn: document.getElementById('trash-restore-btn'),
    trashUndoBtn: document.getElementById('trash-undo-btn'),
    trashPurgeBtn: document.getElementById('trash-purge-btn'),
    trashItems: document.getElementById('trash-items'),
    confirmPanel: document.getElementById('confirm-panel'),
    confirmTitle: document.getElementById('confirm-title'),
    confirmExplain: document.getElementById('confirm-explain'),
    confirmItems: document.getElementById('confirm-items'),
    confirmCancel: document.getElementById('confirm-cancel'),
    confirmOk: document.getElementById('confirm-ok'),
    empty: document.getElementById('empty'),
    emptyText: document.getElementById('empty-text'),
    footerNote: document.getElementById('footer-note')
  };

  // Static, COPY-driven chrome. No user-visible text lives in the markup.
  document.title = COPY.pageTitle;
  els.title.textContent = COPY.appName;
  els.scanBtn.textContent = COPY.scanNow;
  els.backupBtn.textContent = COPY.backupButton;
  els.backupBtn.title = COPY.backupDescription;
  els.listClose.textContent = COPY.backButton;
  els.emptyText.textContent = COPY.emptyState;
  els.footerNote.textContent = COPY.footerNote;
  els.cleanupRemoveBtn.textContent = COPY.cleanupRemoveSelected;
  els.trashBtn.textContent = COPY.trashSection;
  els.trashBtn.title = 'Open ' + COPY.trashSection;
  els.trashBack.textContent = COPY.backButton;
  els.trashRestoreBtn.textContent = COPY.trashRestoreSelected;
  els.trashUndoBtn.textContent = COPY.trashUndoLast;
  els.trashPurgeBtn.textContent = COPY.trashPurgeCta;
  els.confirmCancel.textContent = COPY.cleanupCancel;

  let snapshot = { checkpoint: null, report: null, records: null, linkReport: null, linkCheckpoint: null };

  // State remembered while the popup is open (not scan state — this is UI
  // view state only).
  let activeList = null;

  // ---- Cleanup view state -----------------------------------------------------
  // The selectable items currently shown in a cleanup-capable list (duplicate
  // or confirmed-dead-link result view), plus the user's checkbox selections
  // (NOT preselected — the user decides). Once a move completes we clear this.
  let selectableItems = [];
  let selection = Object.create(null); // selectableId -> true
  let trashStatus = null;              // persisted trash snapshot for the Trash view
  let trashRestoreSelection = Object.create(null);
  let confirmAction = null;            // 'move' | 'purge' (drives the confirm dialog)

  // Whether a scan-now request is pending. Guards the Scan now button so a
  // run of rapid clicks cannot issue a burst of scan-now messages (each of
  // which would otherwise restart the scan from scratch). Combined with the
  // controller's SCANNING-phase dedup this fully breaks the repeated-scan loop.
  let scanRequestPending = false;

  function setScanButtonEnabled(enabled) {
    els.scanBtn.disabled = !enabled;
    els.scanBtn.classList.toggle('br-scan-btn-disabled', !enabled);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function show(selector) {
    // linkCheck is toggled independently (renderLinkCheck handles it) so the
    // opt-in action stays available while the report/empty states are shown.
    ['status', 'report', 'listPanel', 'empty', 'trashPanel', 'confirmPanel'].forEach((key) => {
      els[key].hidden = key !== selector;
    });
    els.linkCheck.hidden = selector === 'listPanel';
  }

  function renderProgress(cp) {
    if (!cp || cp.phase !== PHASE.SCANNING) { return; }
    els.status.hidden = false;
    els.status.textContent = COPY.progressLine(cp.processedCount, cp.totalCount);
    show('status');
  }

  function renderReport() {
    const report = snapshot.report;
    if (!report || typeof report[METRIC.TOTAL] !== 'number') {
      els.empty.hidden = false;
      els.listPanel.hidden = true;
      els.report.hidden = true;
      els.status.hidden = true;
      return;
    }
    show('report');
    els.report.textContent = '';
    els.status.textContent = COPY.scanDone;
    els.status.hidden = false;

    const headline = el('p', 'br-report-headline', COPY.libraryLine(report[METRIC.TOTAL], report[METRIC.LIBRARY_AGE_YEARS]));
    els.report.appendChild(headline);

    // Duration instrumentation (exact raw ms from persisted report data,
    // formatted neutrally) surfaced next to the Library Report.
    if (typeof report[METRIC.DURATION_MS] === 'number') {
      els.report.appendChild(el('p', 'br-scan-duration', COPY.scanDurationLine(report[METRIC.TOTAL], report[METRIC.DURATION_MS])));
    }

    const rows = [
      { key: 'duplicates', count: report[METRIC.DUPLICATES], label: COPY.duplicatesLine(report[METRIC.DUPLICATES]), cta: COPY.duplicatesCta },
      { key: 'emptyFolders', count: report[METRIC.EMPTY_FOLDERS], label: COPY.emptyFoldersLine(report[METRIC.EMPTY_FOLDERS]), cta: COPY.emptyFoldersCta },
      { key: 'sameNameMerge', count: report[METRIC.SAME_NAME_MERGE], label: COPY.sameNameMergeLine(report[METRIC.SAME_NAME_MERGE]), cta: COPY.sameNameMergeCta },
      { key: 'newFolder', count: report[METRIC.NEW_FOLDER], label: COPY.newFolderLine(report[METRIC.NEW_FOLDER]), cta: COPY.newFolderCta },
      { key: 'stale', count: report[METRIC.STALE_OVER_2_YEARS], label: COPY.staleLine(report[METRIC.STALE_OVER_2_YEARS]), cta: COPY.staleCta },
      { key: 'noRecordedOpening', count: report[METRIC.NO_RECORDED_OPENING], label: COPY.noRecordedOpeningLine(report[METRIC.NO_RECORDED_OPENING]), cta: COPY.noRecordedOpeningCta }
    ];

    rows.forEach((row) => {
      const r = el('div', 'br-metric-row');
      r.dataset.key = row.key;
      r.appendChild(el('span', 'br-metric-label', row.label));
      const link = el('span', 'br-metric-link', row.cta);
      r.appendChild(link);
      r.addEventListener('click', () => openList(row.key, row.count));
      els.report.appendChild(r);
    });

    // Provenance note: how much of the library actually carries a recorded
    // opening, so the open-history counts above are read as coverage rather
    // than as a verdict on every bookmark.
    if (typeof report[METRIC.OPEN_HISTORY] === 'number') {
      els.report.appendChild(el('p', 'br-open-history',
        COPY.openHistoryLine(report[METRIC.OPEN_HISTORY], report[METRIC.TOTAL], report[METRIC.OPEN_COVERAGE])));
    }

    const topics = el('p', 'br-topics');
    topics.appendChild(el('strong', null, COPY.topicsHeader));
    const items = (report[METRIC.TOP_CATEGORIES] || []).map((t) => t.name + ' (' + t.count + ')');
    topics.appendChild(document.createTextNode(items.join(COPY.topicsSeparator)));
    els.report.appendChild(topics);

    if (report[METRIC.OLDEST] && report[METRIC.OLDEST].moniker) {
      els.report.appendChild(el('p', 'br-oldest', COPY.oldestLine(report[METRIC.OLDEST].moniker)));
    }

    // The opt-in link-check section (permission-gated, never automatic).
    renderLinkCheck();
  }

  function buildList(records, key) {
    const list = [];
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (key === 'newFolder') {
        if ((r.folderPath || []).some((f) => C.NEW_FOLDER_RE.test(f))) { list.push(r); }
      } else if (key === 'stale') {
        if (root.BRReport.isStaleOverYears(r, snapshot.report[METRIC.GENERATED_AT])) { list.push(r); }
      } else if (key === 'noRecordedOpening') {
        if (!root.BRReport.hasRecordedOpening(r)) { list.push(r); }
      }
    }
    return list;
  }

  /**
   * Render a read-only list whose items come from the persisted report's
   * detection detail (empty folders, same-name merge candidates, or duplicate
   * groups) rather than from the records array, plus per-item status lines.
   */
  function renderFoldList(items, renderItem) {
    els.listItems.textContent = '';
    items.forEach((item) => {
      const li = el('li');
      const line = el('span', 'br-detect-line', renderItem(item) || '');
      li.appendChild(line);
      els.listItems.appendChild(li);
    });
  }

  function renderLinkResultList(key) {
    const records = snapshot.records || [];
    const items = [];
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (typeof r.linkStatus !== 'string' || r.linkStatus === C.LINK_STATUS_UNCHECKED) { continue; }
      if (key === 'reachable' && r.linkStatus === C.LINK_STATUS_REACHABLE) { items.push(r); }
      else if (key === 'unreachable' && r.linkStatus === C.LINK_STATUS_UNREACHABLE) { items.push(r); }
      else if (key === 'couldNotCheck' && r.linkStatus === C.LINK_STATUS_COULD_NOT_CHECK) { items.push(r); }
    }
    renderFoldList(items, (r) => r.title || r.url);
    return items.length;
  }

  // ---- Cleanup selection + dry-run confirmation --------------------------------

  // Build the selectable item set from the persisted records filtered by a
  // predicate. Only records the pure trash module considers eligible are ever
  // offered; `could_not_check` and soft-deleted records are never selectable.
  function selectableFromRecords(predicate, kind) {
    const out = [];
    const records = snapshot.records || [];
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (typeof r.deletedAt === 'number' && r.deletedAt > 0) { continue; }
      if (predicate(r) && r.url) { out.push({ id: r.id, title: r.title, url: r.url, kind: kind }); }
    }
    return out;
  }

  // Render a cleanup-capable list with a checkbox per item (NOT preselected)
  // and a "Move selected" action whose selected count updates live and is
  // announced to screen readers.
  function renderCleanupSelectionList(items, key) {
    selectableItems = items || [];
    selection = Object.create(null);
    els.listItems.textContent = '';
    els.listCleanup.hidden = false;

    items.forEach((it) => {
      const li = el('li');
      const label = el('label', 'br-cleanup-item');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'br-cleanup-check';
      box.value = it.id;
      box.setAttribute('aria-label', 'Select to move: ' + (it.title || it.url));
      box.addEventListener('change', () => {
        if (box.checked) { selection[it.id] = true; } else { delete selection[it.id]; }
        // Keep BOTH the screen-reader announce ("3 selected") and the action
        // button ("Move 3 to Salvage Trash") in sync with the checked set. The
        // action would otherwise stay disabled at "Move 0" even after rows are
        // checked — the button is only enabled by updateCleanupButton().
        updateSelectionAnnounce();
        updateCleanupButton();
      });
      const text = el('span', 'br-cleanup-label', (it.title || it.url) + (it.url ? ' \u2014 ' + it.url : ''));
      label.appendChild(box);
      label.appendChild(text);
      li.appendChild(label);
      els.listItems.appendChild(li);
    });

    els.cleanupRemoveBtn.disabled = true;
    updateSelectionAnnounce();
    updateCleanupButton();
  }

  function selectedCount() { return Object.keys(selection).length; }

  function selectedItems() {
    return selectableItems.filter((it) => selection[it.id] === true);
  }

  function updateSelectionAnnounce() {
    const n = selectedCount();
    els.listSel.textContent = n + ' selected';
  }

  function updateCleanupButton() {
    const n = selectedCount();
    els.cleanupRemoveBtn.disabled = n === 0;
    els.cleanupRemoveBtn.textContent = COPY.cleanupSelectedCta(n);
    els.cleanupRemoveBtn.setAttribute('aria-label', COPY.cleanupRemoveSelected + ' (' + n + ')');
  }

  // Open the itemized dry-run preview for the current selection. If the backup
  // gate is still pending, the preview routes the user through a forced backup
  // export first (nothing moves until a real download initiated).
  function openCleanupConfirmation() {
    const items = selectedItems();
    if (!items.length) { setStatus(COPY.cleanupNothingSelected); return; }
    chrome.runtime.sendMessage({ type: 'trash-preview', items }, (res) => {
      if (!res || !res.ok) { setStatus(COPY.cleanupMoveFailed); return; }
      const dry = res.dryRun || { count: 0, duplicateCount: 0, deadLinkCount: 0, items: [] };
      if (res.gateRequired) {
        openConfirm({
          title: COPY.cleanupBackupRequired,
          explain: COPY.cleanupBackupNow,
          dryRun: dry,
          confirmLabel: COPY.cleanupBackupNow,
          onConfirm: () => backupThenRecord(dry)
        });
        return;
      }
      openConfirm({
        title: COPY.cleanupDryRunTitle(dry.count),
        explain: COPY.cleanupDryRunExplain,
        dryRun: dry,
        confirmLabel: COPY.cleanupConfirmMove,
        onConfirm: () => performMove(dry)
      });
    });
  }

  function openConfirm(opts) {
    confirmAction = opts.onConfirm;
    els.confirmTitle.textContent = opts.title;
    const counts = [];
    if (opts.dryRun && opts.dryRun.duplicateCount > 0) { counts.push(COPY.cleanupDryRunDuplicates(opts.dryRun.duplicateCount)); }
    if (opts.dryRun && opts.dryRun.deadLinkCount > 0) { counts.push(COPY.cleanupDryRunDeadLinks(opts.dryRun.deadLinkCount)); }
    els.confirmExplain.textContent = opts.explain + (counts.length ? ' (' + counts.join(', ') + ')' : '');
    els.confirmItems.textContent = '';
    (opts.dryRun.items || []).forEach((it) => {
      els.confirmItems.appendChild(el('li', 'br-confirm-item', (it.title || it.url) + (it.kind ? ' \u2014 ' + kindLabel(it.kind) : '')));
    });
    els.confirmOk.textContent = opts.confirmLabel;
    els.confirmPanel.hidden = false;
    els.confirmOk.disabled = false;
    els.confirmOk.focus();
  }

  function kindLabel(kind) {
    return kind === 'dead-link' ? 'confirmed dead link' : 'exact duplicate';
  }

  function setStatus(text) {
    els.status.hidden = false;
    els.status.textContent = text;
  }

  // Perform the actual safe move to the Salvage Trash folder (never deletes).
  //
  // A durable move outcome is the ONLY thing that reports "Moved N to Salvage
  // Trash". The worker re-derives every requested item against the persisted
  // records (server-side eligibility), so a response can be `ok` AND
  // `movedCount === 0` when nothing was actually eligible (items already moved,
  // soft-deleted, or reset by a rescan). In that case the popup must NOT claim a
  // successful move — it must say nothing moved, refresh the record-backed list,
  // and let the refreshed selectable view reflect current eligibility (an item
  // that was moved on a prior request now carries `deletedAt` and should leave
  // the selectable view). The selection is rebuilt from the fresh records by the
  // redraw, so it is NOT preserved across the action.
  function performMove(dryRun) {
    const items = selectedItems();
    els.confirmOk.disabled = true;
    els.confirmOk.textContent = '...';
    chrome.runtime.sendMessage({ type: 'cleanup-move', items }, (res) => {
      els.confirmPanel.hidden = true;
      if (!res || !res.ok) { setStatus(COPY.cleanupMoveFailed); return; }
      if (res.gateRequired) {
        // Gate is still unresolved — refresh nothing; keep the selection so the
        // user can retry after the backup flow completes.
        setStatus(COPY.cleanupBackupRequired);
        return;
      }
      const moved = res.movedCount || 0;
      if (moved <= 0) {
        // Nothing was actually moved (all requested ids were refused/ineligible),
        // or the move did not durably land. Surface that instead of a false
        // success, then reload the record-backed list. The redraw rebuilds the
        // selection rows from the fresh records, so any item that DID leave
        // (deletedAt set on a prior in-flight request) is removed and the prior
        // in-page selection is reset (not preserved across the redraw).
        clearListRows();
        setStatus(COPY.cleanupMoveRefused);
        loadSnapshot().then(() => redrawActiveList());
        return;
      }
      // Durable success: clear the selection, hide the action bar, and re-render
      // from the freshly-persisted records so the just-moved items (now carrying
      // `deletedAt`) are removed from the current list and Trash reflects them.
      selectableItems = [];
      selection = Object.create(null);
      els.listCleanup.hidden = true;
      setStatus(COPY.cleanupMoveDone(moved));
      clearListRows();
      loadSnapshot().then(() => redrawActiveList());
    });
    // `dryRun` is only used to size the confirm dialog; the move is keyed off the
    // live in-page selection, so nothing else is needed here.
  }

  // Clear the currently rendered list rows. Used after any cleanup action so a
  // stale set of checkbox rows never remains visible once the underlying records
  // changed (they would otherwise linger as "still there" after a move).
  function clearListRows() {
    els.listItems.textContent = '';
  }

  // Re-render the currently-open list from the freshly-loaded snapshot. If the
  // user was viewing a cleanup-capable list, rebuild its selection rows with the
  // (now updated) records; otherwise fall back to the report view. No copy of the
  // old records is kept, so this always reflects the durable storage state.
  function redrawActiveList() {
    if (!activeList) { renderOrEmpty(); return; }
    // Re-open the same key against the fresh snapshot. openList is idempotent for
    // state that reads records/report lists (and skips the confirm flow), so it
    // cleanly rebuilds the matching rows from current data.
    openList(activeList, 0);
  }

  function cleanupSelectionAfterAction() {
    selectableItems = [];
    selection = Object.create(null);
    els.listCleanup.hidden = true;
    // Reset the displayed selection/action state too, so a later read-only list
    // never shows a stale announce ("N selected") or "Move N" action from the
    // cleared selection. Reuse the same updaters that keep the live checkbox
    // changes in sync so all three stay consistent.
    updateSelectionAnnounce();
    updateCleanupButton();
  }

  // Forced backup gate flow: run the existing complete export, and ONLY after
  // the download actually started record the gate via the worker. Until
  // `cleanup-record-backup-done` resolves, bulk moves stay gated.
  function backupThenRecord(dryRun) {
    els.status.hidden = false;
    els.status.textContent = COPY.scanStarting;
    chrome.runtime.sendMessage({ type: 'backup-export' }, (res) => {
      if (!res || !res.ok || !res.json) {
        els.status.textContent = COPY.backupFailed;
        return;
      }
      const blob = new Blob([res.json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = res.fileName || COPY.backupFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      queueMicrotask(() => { try { URL.revokeObjectURL(url); } catch (e) {} });
      // The download has initiated synchronously; now record the gate.
      chrome.runtime.sendMessage({ type: 'cleanup-record-backup-done' }, (rec) => {
        els.status.hidden = true;
        if (!rec || !rec.ok) { els.status.hidden = false; els.status.textContent = COPY.cleanupMoveFailed; return; }
        setStatus(COPY.cleanupGateCleared);
        // Re-open the confirmation now that the gate is clear.
        openCleanupConfirmation();
      });
    });
  }

  // ---- Trash view (restore / undo / eligible purge) ---------------------------
  function openTrash() {
    activeList = null;
    els.report.hidden = true;
    els.empty.hidden = true;
    els.listPanel.hidden = true;
    els.status.hidden = false;
    els.status.textContent = '';
    loadTrash();
  }

  function loadTrash() {
    chrome.runtime.sendMessage({ type: 'trash-status' }, (res) => {
      if (!res || !res.ok) { els.status.hidden = false; els.status.textContent = ''; els.trashPanel.hidden = true; return; }
      trashStatus = res;
      trashRestoreSelection = Object.create(null);
      els.trashPanel.hidden = false;
      renderTrash();
    });
  }

  function renderTrash() {
    const entries = (trashStatus && trashStatus.trash) || [];
    const active = entries.filter((e) => !e.restoredAt);
    els.trashNote.textContent = trashStatus && trashStatus.gateRequired ? COPY.cleanupBackupRequired : COPY.trashBackupNote;
    els.trashItems.textContent = '';
    if (!active.length) {
      els.trashItems.appendChild(el('li', 'br-trash-empty', COPY.trashEmpty));
    }
    active.forEach((e) => {
      const li = el('li');
      const label = el('label', 'br-trash-item');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'br-trash-check';
      box.value = e.id;
      box.setAttribute('aria-label', 'Select to restore: ' + (e.title || e.url));
      box.addEventListener('change', () => {
        if (box.checked) { trashRestoreSelection[e.id] = true; } else { delete trashRestoreSelection[e.id]; }
        refreshTrashButtons(active);
      });
      label.appendChild(box);
      const kind = e.kind;
      label.appendChild(el('span', 'br-trash-label', (e.title || e.url) + (kind ? ' \u2014 ' + kindLabel(kind) : '')));
      li.appendChild(label);
      els.trashItems.appendChild(li);
    });
    refreshTrashButtons(active);
    renderPurgeEligible();
  }

  function refreshTrashButtons(active) {
    const n = Object.keys(trashRestoreSelection).length;
    els.trashRestoreBtn.disabled = n === 0;
    els.trashRestoreBtn.setAttribute('aria-label', COPY.trashRestoreSelected + ' (' + n + ')');
    (trashStatus && trashStatus.lastBatch && trashStatus.lastBatch.entries && trashStatus.lastBatch.entries.length
      ? (els.trashUndoBtn.disabled = false) : (els.trashUndoBtn.disabled = true));
  }

  function renderPurgeEligible() {
    const eligible = (trashStatus && trashStatus.purgeEligibleIds) || [];
    const n = eligible.length;
    els.trashPurgeBtn.disabled = n === 0;
    els.trashPurgeBtn.textContent = n ? COPY.trashPurgeEligible(n) : COPY.trashNoEligible;
  }

  function trashRestoreSelected() {
    const ids = Object.keys(trashRestoreSelection);
    if (!ids.length) { setStatus(COPY.trashNothingSelected); return; }
    setStatus(COPY.trashRestoreSelected);
    chrome.runtime.sendMessage({ type: 'trash-restore', ids }, (res) => {
      if (!res || !res.ok) { setStatus(COPY.cleanupMoveFailed); return; }
      setStatus(COPY.trashRestoreDone(res.restoredCount || 0));
      loadTrash();
      loadSnapshot();
    });
  }

  function trashUndoLast() {
    setStatus(COPY.trashUndoLast);
    chrome.runtime.sendMessage({ type: 'trash-undo' }, (res) => {
      if (!res || !res.ok) { setStatus(COPY.cleanupMoveFailed); return; }
      setStatus(res.message === 'nothing-to-undo' ? COPY.trashUndoNothing : COPY.trashRestoreDone(res.restoredCount || 0));
      loadTrash();
      loadSnapshot();
    });
  }

  function trashPurge() {
    const eligible = (trashStatus && trashStatus.purgeEligibleIds) || [];
    if (!eligible.length) { setStatus(COPY.trashNoEligible); return; }
    // First explicit confirmation dialog listing exactly what will be removed.
    const dryP = {
      count: eligible.length,
      items: (trashStatus.trash || []).filter((e) => eligible.indexOf(String(e.id)) !== -1)
        .map((e) => ({ id: e.id, title: e.title, url: e.url, kind: e.kind }))
    };
    openConfirm({
      title: COPY.trashPurgeConfirmTitle(eligible.length),
      explain: COPY.trashPurgeExplain,
      dryRun: dryP,
      confirmLabel: COPY.trashPurgeConfirm,
      onConfirm: () => trashPurgeConfirmed()
    });
  }

  function trashPurgeConfirmed() {
    const eligible = (trashStatus && trashStatus.purgeEligibleIds) || [];
    els.confirmOk.disabled = true;
    els.confirmOk.textContent = '...';
    // Second confirmation is implied by this separate explicit call with a
    // 'confirmed' sentinel the worker requires.
    chrome.runtime.sendMessage({ type: 'trash-purge', ids: eligible, confirmed: 'confirmed' }, (res) => {
      els.confirmPanel.hidden = true;
      if (!res || !res.ok) {
        setStatus(COPY.cleanupMoveFailed);
        loadTrash();
        return;
      }
      if (res.refusedCount > 0) { setStatus(COPY.trashPurgeDone(res.purgedCount || 0) + ' ' + COPY.trashPurgeRefused); }
      else { setStatus(COPY.trashPurgeDone(res.purgedCount || 0)); }
      loadTrash();
      loadSnapshot();
    });
  }

  function openList(key, count) {
    activeList = key;
    show('listPanel');
    els.report.hidden = true;
    els.listTitle.textContent = COPY.appName + ' \u2014 ' + COPY.openList;

    if (key === 'emptyFolders') {
      // Read-only folder findings — never selectable for cleanup. Clear any
      // cleanup selection/state left by an earlier cleanup-capable list this
      // popup session so a stale "Move 0 to Salvage Trash" action bar never
      // renders over the read-only folders as a broken/empty view.
      cleanupSelectionAfterAction();
      const items = (snapshot.report[METRIC.EMPTY_FOLDERS_LIST] || []);
      els.listCount.textContent = COPY.listCountLine(items.length);
      renderFoldList(items, (f) => (f.path || []).join(' / ') || f.title);
      return;
    }
    if (key === 'sameNameMerge') {
      // Read-only merge candidates — never selectable for cleanup. Clear any
      // stale cleanup selection/state before rendering (same rationale as the
      // empty-folders / reachable / could-not-check read-only lists).
      cleanupSelectionAfterAction();
      const items = (snapshot.report[METRIC.SAME_NAME_MERGE_LIST] || []);
      els.listCount.textContent = COPY.listCountLine(items.length);
      renderFoldList(items, (g) => {
        const where = (g.parentPath || []).join(' / ');
        return 'Merge candidates named "' + (g.displayName || g.name) + '"' + (where ? ' under ' + where : '');
      });
      return;
    }
    if (key === 'duplicates') {
      // Derive the CURRENT duplicate copies from the persisted RECORDS via the
      // shared cleanup module's computeDuplicateGroups (which excludes soft-deleted
      // entries), NOT from the historical report's DUPLICATE_GROUPS_LIST snapshot.
      // A report is written once at scan completion and is never regenerated on a
      // durable Trash move, so after moving N copies the persisted list would still
      // render the stale pre-move rows. Deriving from records means the just-moved
      // copies (now carrying `deletedAt`) immediately leave the active list and only
      // current eligible copies are selectable — consistent with the record-derived
      // unreachable route. The report is never mutated or regenerated for the UI;
      // report[METRIC.DUPLICATES] still reflects the scan-time count.
      const groups = root.BRCleanup.computeDuplicateGroups(snapshot.records || []).groups;
      const selectable = root.BRTrash.selectableDuplicates(groups);
      els.listCount.textContent = COPY.listCountLine(selectable.length);
      renderCleanupSelectionList(selectable, 'duplicates');
      return;
    }
    if (key === 'unreachable') {
      // Confirmed dead links only — this list is the exact selectable set of
      // records whose persisted linkStatus is `unreachable`. Items are NOT
      // preselected; `could_not_check` / anything else is never listed here.
      const items = selectableFromRecords(function (r) { return r.linkStatus === C.LINK_STATUS_UNREACHABLE; }, 'dead-link');
      els.listCount.textContent = COPY.listCountLine(items.length);
      renderCleanupSelectionList(items, 'unreachable');
      return;
    }
    if (key === 'reachable' || key === 'couldNotCheck') {
      const items = [];
      for (let i = 0; i < (snapshot.records || []).length; i++) {
        const r = snapshot.records[i];
        // Skip soft-deleted records (they were moved to trash and are no longer a
        // live link result), matching the countLinkResults summary so the number on
        // the summary line always equals the number of rows this list shows.
        if (typeof r.deletedAt === 'number' && r.deletedAt > 0) { continue; }
        const wantReach = key === 'reachable';
        if ((wantReach ? r.linkStatus === C.LINK_STATUS_REACHABLE : r.linkStatus === C.LINK_STATUS_COULD_NOT_CHECK)) { items.push(r); }
      }
      // Read-only informational lists only — never selectable for cleanup. Clear
      // any cleanup selection/state left by an earlier cleanup-capable list in this
      // popup session so a stale "Move 0 to Salvage Trash" action bar never renders
      // over the read-only records as a broken/empty view.
      cleanupSelectionAfterAction();
      renderFoldList(items, (r) => r.title || r.url);
      els.listCount.textContent = COPY.listCountLine(items.length);
      return;
    }

    const records = snapshot.records || [];
    const list = buildList(records, key);
    els.listCount.textContent = COPY.listCountLine(list.length);
    els.listItems.textContent = '';
    list.forEach((r) => {
      const li = el('li');
      const openable = root.BRNormalize.isOpenableUrl(r.url);
      const a = el('a', null, r.title || r.url);
      a.href = '#';
      if (openable) {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          // Only http/https are ever opened; non-web schemes (javascript:,
          // data:, file:, chrome:, etc.) in the imported tree are never
          // handed to chrome.tabs.create. The record itself stays read-only.
          chrome.tabs.create({ url: r.url });
        });
      } else {
        // Not a web target: render as inert text so it is visible but cannot
        // trigger a tab open. Keep the record untouched.
        a.classList.add('br-list-inert');
        a.removeAttribute('href');
      }
      li.appendChild(a);
      li.appendChild(el('span', 'br-list-url', r.url));
      els.listItems.appendChild(li);
    });
  }

  function loadSnapshot() {
    return new Promise((resolve) => {
      chrome.storage.local.get([KEYS.CHECKPOINT, KEYS.REPORT, KEYS.RECORDS, KEYS.LINK_REPORT, KEYS.LINK_CHECKPOINT], (res) => {
        snapshot.checkpoint = res[KEYS.CHECKPOINT] || null;
        snapshot.report = res[KEYS.REPORT] || null;
        snapshot.linkReport = res[KEYS.LINK_REPORT] || null;
        snapshot.linkCheckpoint = res[KEYS.LINK_CHECKPOINT] || null;
        snapshot.records = (res[KEYS.RECORDS] || []);
        resolve();
      });
    });
  }

  // ---- Backup export (always available, never gated) --------------------------
  function exportBackup() {
    els.status.hidden = false;
    els.status.textContent = COPY.scanStarting;
    chrome.runtime.sendMessage({ type: 'backup-export' }, (res) => {
      els.status.hidden = true;
      if (!res || !res.ok || !res.json) {
        els.status.hidden = false;
        els.status.textContent = COPY.backupFailed;
        return;
      }
      const blob = new Blob([res.json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = res.fileName || COPY.backupFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // The download has been initiated synchronously by click(); revoking the
      // blob URL in a microtask is safe here and avoids a timer entirely.
      queueMicrotask(() => URL.revokeObjectURL(url));
      els.status.hidden = false;
      els.status.textContent = COPY.backupReady;
    });
  }

  // ---- Dead-link check (opt-in, permission-gated) -----------------------------
  // Transient in-session hint that a check was just initiated. It bridges the
  // synchronous gap before the link controller's first durable checkpoint
  // write; from then on the running state is driven by the persisted
  // `snapshot.linkCheckpoint` via storage events, so the same state survives a
  // popup reopen mid-check. Kept strictly as a hint — it never enters storage.
  let linkCheckActive = false;

  /**
   * Count the current three-state link results DIRECTLY from the persisted
   * records — the single source of truth the click-through lists are derived
   * from. This keeps the "N confirmed dead / reachable / could not be checked"
   * summary always equal to the items that a click actually opens, even when the
   * historical `LINK_REPORT` (persisted at the last check completion) has gone
   * stale because a fresh rescan rebuilt the records (clearing every status) or
   * because moved items carried `deletedAt`. Soft-deleted records are excluded,
   * exactly matching the selectable/read-only lists, so the number shown is
   * never higher than the number of actionable rows.
   *
   * @param {Array<object>} records persisted bookmark records
   * @returns {{reachable:number, unreachable:number, couldNotCheck:number}}
   */
  function countLinkResults(records) {
    const counts = { reachable: 0, unreachable: 0, couldNotCheck: 0 };
    for (let i = 0; i < (records || []).length; i++) {
      const r = records[i];
      if (typeof r.deletedAt === 'number' && r.deletedAt > 0) { continue; }
      const s = r.linkStatus;
      if (s === C.LINK_STATUS_REACHABLE) { counts.reachable += 1; }
      else if (s === C.LINK_STATUS_UNREACHABLE) { counts.unreachable += 1; }
      else if (s === C.LINK_STATUS_COULD_NOT_CHECK) { counts.couldNotCheck += 1; }
    }
    return counts;
  }

  // Render the dead-link section in exactly ONE mutually-exclusive state,
  // resolved from the persisted snapshot by the pure linkCheckViewState helper
  // (idle -> running -> completed). Running never coexists with the
  // "not checked yet" copy, and always shows truthful progress from the
  // persisted link checkpoint.
  function renderLinkCheck() {
    els.linkCheck.hidden = false;
    els.linkCheck.textContent = '';
    const block = el('div', 'br-linkcheck-block');

    block.appendChild(el('div', 'br-linkcheck-title', COPY.linkCheckSection));

    const view = root.BRLinkUI.linkCheckViewState({
      report: snapshot.report,
      linkReport: snapshot.linkReport,
      linkCheckpoint: snapshot.linkCheckpoint,
      active: linkCheckActive
    });

    if (view.state === 'running') {
      // Show truthful in-flight progress from the persisted checkpoint, plus
      // the running notice. No button, no "not checked yet" copy.
      if (view.progress) {
        block.appendChild(el('p', 'br-linkcheck-progress',
          COPY.linkCheckProgressLine(view.progress.processed, view.progress.total)));
      }
      block.appendChild(el('p', 'br-linkcheck-running', COPY.linkCheckRunning));
    } else if (view.state === 'completed') {
      // Three-state result summary over a completed run. The counts are derived
      // DIRECTLY from the current persisted records (countLinkResults), never
      // from the historical `linkReport`, so the number on every line always
      // equals the number of items the opening click actually lists. A stale
      // `linkReport` (e.g. a completed rescan rebuilt the records with fresh
      // `unchecked` statuses, or moved items carried `deletedAt`) can therefore
      // never show "385 confirmed dead" above a zero-item list. The report's
      // immutable metadata (duration) is still read for display.
      const lr = snapshot.linkReport;
      if (lr && typeof lr.durationMs === 'number') {
        block.appendChild(el('p', 'br-linkcheck-duration', COPY.linkCheckDurationLine(lr.checked, lr.durationMs)));
      }
      const live = countLinkResults(snapshot.records || []);
      const reached = el('div', 'br-linkcheck-lines');
      reached.appendChild(el('span', 'br-linkcheck-link br-linkcheck-click', COPY.linkCheckReachableLine(live.reachable)));
      reached.appendChild(el('span', 'br-linkcheck-link br-linkcheck-click', COPY.linkCheckUnreachableLine(live.unreachable)));
      reached.appendChild(el('span', 'br-linkcheck-link br-linkcheck-click', COPY.linkCheckCouldNotCheckLine(live.couldNotCheck)));
      // Make each line a read-only list opener for the matching group.
      reached.childNodes.forEach((node, idx) => {
        node.addEventListener('click', () => {
          const k = idx === 0 ? 'reachable' : idx === 1 ? 'unreachable' : 'couldNotCheck';
          openList(k, 0);
        });
      });
      block.appendChild(reached);
    } else {
      // idle: nothing has run yet — no results, no false "running" copy.
      block.appendChild(el('p', 'br-linkcheck-explain', COPY.linkCheckNotRun));
    }

    // Idle and completed both expose the opt-in action; running never does.
    // The button label/copy doubles as the recheck entry point after a run.
    if (view.canCheck) {
      const btn = el('button', 'br-linkcheck-btn', COPY.linkCheckButton);
      btn.type = 'button';
      btn.disabled = !view.haveLibrary;
      if (!view.haveLibrary) { btn.title = COPY.linkCheckExplain; }
      btn.addEventListener('click', () => startLinkCheck());
      block.appendChild(el('p', 'br-linkcheck-explain', COPY.linkCheckExplain));
      block.appendChild(btn);
    }

    els.linkCheck.appendChild(block);
  }

  function startLinkCheck() {
    chrome.permissions.contains({ origins: ['<all_urls>'] }, (granted) => {
      if (granted) {
        runLinkCheck();
        return;
      }
      els.linkCheck.textContent = '';
      els.linkCheck.appendChild(el('p', 'br-linkcheck-explain', COPY.linkCheckExplain));
      els.linkCheck.appendChild(el('p', 'br-linkcheck-running', COPY.linkCheckGranting));
      // Permission must be granted before any bookmark URL is fetched.
      chrome.permissions.request({ origins: ['<all_urls>'] }, (grantedNow) => {
        if (grantedNow) {
          runLinkCheck();
        } else {
          // Re-render the opt-in action (so the user can try again) and keep
          // the neutral explanation that access was not granted.
          renderLinkCheck();
          const block = els.linkCheck.firstChild;
          const note = el('p', 'br-linkcheck-explain', COPY.linkCheckNeedsAccess);
          if (block) { block.insertBefore(note, block.firstChild); }
          else { els.linkCheck.appendChild(note); }
        }
      });
    });
  }

  function runLinkCheck() {
    linkCheckActive = true;
    renderLinkCheck();
    chrome.runtime.sendMessage({ type: 'check-links' }, (res) => {
      linkCheckActive = false;
      if (!res || !res.ok) {
        renderLinkCheck();
        return;
      }
      renderLinkCheck();
    });
  }

  function requestScan() {
    // Ignore a click while a scan is already running or a request is in flight —
    // a rapid second click must not queue another full rescan.
    if (scanRequestPending) { return; }
    if (snapshot.checkpoint && snapshot.checkpoint.phase === PHASE.SCANNING) { return; }
    scanRequestPending = true;
    setScanButtonEnabled(false);
    els.status.hidden = false;
    els.status.textContent = COPY.scanStarting;
    chrome.runtime.sendMessage({ type: 'scan-now' }, (res) => {
      scanRequestPending = false;
      // Re-evaluate button state after the request completes. If the worker
      // rejected the request ({ok:false} or no response), re-enable Scan now
      // immediately and show an actionable failure message so the user can
      // retry. On success the button stays disabled only if the persisted
      // phase is genuinely SCANNING; a storage-event update will re-enable
      // it once the scan reaches DONE/FAILED. This prevents the button from
      // getting stuck disabled when the request fails before any storage
      // write occurs.
      if (!res || res.ok === false) {
        setScanButtonEnabled(true);
        els.status.hidden = false;
        els.status.textContent = COPY.scanFailed;
        return;
      }
      // Success: determine the authoritative phase. When the worker skipped
      // (already scanning), the response carries the authoritative phase from
      // the controller's own checkpoint read — prefer it over the popup's
      // stale snapshot which may pre-date the scan start. For a non-skipped
      // response the scan just started so phase is SCANNING; fall back to the
      // persisted snapshot only when the response omits phase (legacy path).
      var phase = (res && res.phase) || (snapshot.checkpoint && snapshot.checkpoint.phase);
      setScanButtonEnabled(phase !== PHASE.SCANNING);
    });
  }

  /**
   * Re-read the persisted scan snapshot and re-render. Progress always comes
   * from storage (never from worker memory). Driven by
   * chrome.storage.onChanged instead of a timer.
   */
  function refreshFromStorage() {
    chrome.storage.local.get([KEYS.CHECKPOINT, KEYS.REPORT, KEYS.RECORDS, KEYS.LINK_REPORT, KEYS.LINK_CHECKPOINT], (res) => {
      const cp = res[KEYS.CHECKPOINT] || null;
      const report = res[KEYS.REPORT] || null;
      const linkReport = res[KEYS.LINK_REPORT] || null;
      const linkCheckpoint = res[KEYS.LINK_CHECKPOINT] || null;
      const records = (res[KEYS.RECORDS] || []);
      const dataChanged =
        JSON.stringify(cp) !== JSON.stringify(snapshot.checkpoint) ||
        JSON.stringify(report) !== JSON.stringify(snapshot.report) ||
        JSON.stringify(linkReport) !== JSON.stringify(snapshot.linkReport) ||
        JSON.stringify(linkCheckpoint) !== JSON.stringify(snapshot.linkCheckpoint) ||
        JSON.stringify(records) !== JSON.stringify(snapshot.records);
      snapshot.checkpoint = cp;
      snapshot.report = report;
      snapshot.linkReport = linkReport;
      snapshot.linkCheckpoint = linkCheckpoint;
      snapshot.records = records;
      // The Scan now button is only idle-able while no scan is running: it is
      // disabled during SCANNING (and while a request is pending) and re-enabled
      // the moment the scan reaches DONE, FAILED, or after any set of changes
      // clears it.
      if (!scanRequestPending) {
        setScanButtonEnabled(!(cp && cp.phase === PHASE.SCANNING));
      }
      if (dataChanged && !activeList) {
        renderOrEmpty();
      } else if (dataChanged) {
        renderLinkCheck();
      }
    });
  }

  function onStorageChanged(changes, areaName) {
    if (areaName !== 'local') { return; }
    const relevant = KEYS.CHECKPOINT in changes || KEYS.REPORT in changes ||
      KEYS.RECORDS in changes || KEYS.LINK_REPORT in changes || KEYS.LINK_CHECKPOINT in changes;
    if (relevant) {
      refreshFromStorage();
    }
  }

  chrome.storage.onChanged.addListener(onStorageChanged);

  function renderOrEmpty() {
    if (activeList) { return; }
    const report = snapshot.report;
    if (!report || typeof report[METRIC.TOTAL] !== 'number') {
      // No scan yet: show empty guidance, or progress, or failure. The
      // link-check section stays visible (and explains it needs a scan) so the
      // opt-in is never hidden.
      const cp = snapshot.checkpoint;
      renderLinkCheck();
      if (cp && cp.phase === PHASE.SCANNING) {
        renderProgress(cp);
      } else if (cp && cp.phase === PHASE.FAILED) {
        els.empty.hidden = false;
        els.report.hidden = true;
        els.listPanel.hidden = true;
        els.status.hidden = false;
        els.status.textContent = COPY.scanFailed;
      } else {
        els.empty.hidden = false;
        els.report.hidden = true;
        els.listPanel.hidden = true;
        els.status.hidden = true;
      }
      return;
    }
    renderReport();
  }

  els.scanBtn.addEventListener('click', requestScan);
  els.backupBtn.addEventListener('click', exportBackup);
  els.listClose.addEventListener('click', () => { activeList = null; renderOrEmpty(); });
  els.cleanupRemoveBtn.addEventListener('click', openCleanupConfirmation);
  els.trashBtn.addEventListener('click', openTrash);
  els.trashBack.addEventListener('click', () => { activeList = null; els.trashPanel.hidden = true; renderOrEmpty(); });
  els.trashRestoreBtn.addEventListener('click', trashRestoreSelected);
  els.trashUndoBtn.addEventListener('click', trashUndoLast);
  els.trashPurgeBtn.addEventListener('click', trashPurge);
  els.confirmCancel.addEventListener('click', () => { els.confirmPanel.hidden = true; });
  els.confirmOk.addEventListener('click', () => {
    // Keyboard accessible: Enter/Space on the focused OK button triggers this.
    const fn = confirmAction;
    if (typeof fn === 'function') { fn(); }
  });

  function init() {
    loadSnapshot().then(() => {
      const cp = snapshot.checkpoint;
      // Seed the button's initial enabled state from the persisted checkpoint so
      // opening the popup mid-scan shows Scan now as disabled (prevents a
      // fresh-click restart until the running scan settles). A FAILED scan keeps
      // the button enabled so the user can retry.
      setScanButtonEnabled(!(cp && cp.phase === PHASE.SCANNING));
      if (cp && cp.phase === PHASE.SCANNING) {
        renderProgress(cp);
        renderLinkCheck();
      } else {
        renderOrEmpty();
      }
    });
  }

  init();

  // The popup document owns its listeners. Removing them on unload keeps any
  // reuse of the open popup context tidy (no timers to leak here).
  window.addEventListener('unload', () => {
    chrome.storage.onChanged.removeListener(onStorageChanged);
  });
})(typeof self !== 'undefined' ? self : globalThis);
