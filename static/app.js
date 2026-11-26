(() => {
  const state = {
    tab: "board",
    direction: "home_to_dest",
    manualDirSelected: false,
    catalog: null,
    live: null,
    settings: null,
    me: null,
    expandedTrip: null,
    tripDetails: {},
    earlierOpenByDir: { home_to_dest: false, dest_to_home: false },
    lastBoardSig: null,
    sse: null,
    sseConnected: false,
    fetchError: null,
    predictorInited: false,
  };

  const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  const CORRIDOR_COLORS = {
    ST: "#8f5624",
    LW: "#b8293d",
    LE: "#0284c7",
    KI: "#15803d",
    BR: "#1d4ed8",
    MI: "#c2410c",
    RH: "#0e7490",
    UP: "#6d28d9",
  };

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function svgIcon(name, cls = "") {
    const px = cls.split(/\s+/).includes("sm") ? 14 : 16;
    const base = window.__GTPP_ICONS_URL || "/static/icons.svg";
    return `<svg class="ico ${cls}" width="${px}" height="${px}" aria-hidden="true"><use href="${base}#ico-${name}"></use></svg>`;
  }

  function showToast(message, kind = "ok") {
    const container = $("toast-container");
    if (!container) return;
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    const iconName = kind === "err" ? "triangle-alert" : kind === "info" ? "info" : "circle-check";
    const iconCls = kind === "err" ? "sm ico-err" : kind === "info" ? "sm ico-info" : "sm ico-ok";
    el.innerHTML = `${svgIcon(iconName, iconCls)}<span>${escapeHtml(message)}</span>`;
    container.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 3200);
  }

  function openConfirm({ title, body, okLabel = "Confirm" }) {
    return new Promise((resolve) => {
      const modal = $("confirm-modal");
      $("confirm-modal-title").textContent = title;
      $("confirm-modal-body").textContent = body;
      $("confirm-modal-ok").textContent = okLabel;
      modal.classList.remove("hidden");

      const cleanup = (answer) => {
        modal.classList.add("hidden");
        $("confirm-modal-ok").removeEventListener("click", onOk);
        $("confirm-modal-cancel").removeEventListener("click", onCancel);
        $("confirm-modal-close").removeEventListener("click", onCancel);
        modal.removeEventListener("click", onBackdrop);
        document.removeEventListener("keydown", onEsc);
        resolve(answer);
      };
      const onOk = () => cleanup(true);
      const onCancel = () => cleanup(false);
      const onBackdrop = (e) => {
        if (e.target === modal) cleanup(false);
      };
      const onEsc = (e) => {
        if (e.key === "Escape") cleanup(false);
      };

      $("confirm-modal-ok").addEventListener("click", onOk);
      $("confirm-modal-cancel").addEventListener("click", onCancel);
      $("confirm-modal-close").addEventListener("click", onCancel);
      modal.addEventListener("click", onBackdrop);
      document.addEventListener("keydown", onEsc);
    });
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts,
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const txt = await res.text();
        if (txt) {
          try {
            const parsed = JSON.parse(txt);
            msg = parsed.error || txt;
          } catch (_) {
            msg = txt;
          }
        }
      } catch (_) {}
      throw new Error(msg);
    }
    return res.json();
  }

  function fmtTime(iso) {
    if (!iso) return "--:--";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso.slice(11, 16) || iso;
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  }

  function fmtRelative(iso) {
    if (!iso) return "never";
    const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    return `${Math.round(min / 60)}h ago`;
  }

  function nowTorontoHHMM() {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Toronto",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date());
    } catch (_) {
      const d = new Date();
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
  }

  function formatDays(days) {
    const sorted = [...new Set(days || [])].sort((a, b) => a - b);
    const key = sorted.join(",");
    if (key === "0,1,2,3,4") return "Weekdays";
    if (key === "5,6") return "Weekends";
    if (key === "0,1,2,3,4,5,6") return "Every day";
    return sorted.map((d) => DAY_LABELS[d]).filter(Boolean).join(", ");
  }

  function formatCountdown(minsUntil, fallbackIso) {
    if (minsUntil > 0 && minsUntil <= 180) return `in ${minsUntil}m`;
    if (minsUntil === 0) return "NOW";
    if (minsUntil < 0) {
      const absMin = Math.abs(minsUntil);
      if (absMin >= 90) {
        const hrs = Math.floor(absMin / 60);
        const rem = absMin % 60;
        return rem > 0 ? `${hrs}h ${rem}m ago` : `${hrs}h ago`;
      }
      return `${absMin}m ago`;
    }
    return fmtTime(fallbackIso);
  }

  function updateFreshnessUI() {
    const label = $("freshness-label");
    const banner = $("conn-banner");
    const bannerText = $("conn-banner-text");
    const poller = state.live?.poller;

    if (state.fetchError) {
      label.textContent = "Offline";
      banner.className = "conn-banner";
      bannerText.textContent = "Unable to reach server. Showing cached departures.";
      return;
    }

    if (!poller || !poller.last_poll_at) {
      label.textContent = "Connecting...";
      banner.className = "conn-banner hidden";
      return;
    }

    const ageSec = Math.max(0, Math.round((Date.now() - new Date(poller.last_poll_at).getTime()) / 1000));
    label.textContent = `Updated ${fmtRelative(poller.last_poll_at)}`;

    if (!poller.last_poll_ok) {
      banner.className = "conn-banner warn";
      bannerText.textContent = "GOTransit upstream poll error — times may be outdated.";
    } else if (ageSec > 180) {
      banner.className = "conn-banner warn";
      bannerText.textContent = `Feed hasn't refreshed in ${Math.round(ageSec / 60)}m.`;
    } else if (!state.sseConnected && document.visibilityState === "visible") {
      banner.className = "conn-banner hidden";
    } else {
      banner.className = "conn-banner hidden";
    }
  }

  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll(".tab-panel").forEach((el) => el.classList.remove("active"));
    document.querySelectorAll(".nav-btn").forEach((el) => el.classList.remove("active"));
    $(`tab-${tab}`).classList.add("active");
    document.querySelector(`.nav-btn[data-tab="${tab}"]`).classList.add("active");
    if (tab === "analytics") {
      initPredictor();
      loadAnalyticsAndEvents();
    }
    if (tab === "system") loadSystemTab();
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function autoChooseDirection(live) {
    if (state.manualDirSelected) return;
    const elig = live.eligibility || {};
    if (elig.dest_to_home?.active && !elig.home_to_dest?.active) {
      state.direction = "dest_to_home";
    } else if (elig.home_to_dest?.active && !elig.dest_to_home?.active) {
      state.direction = "home_to_dest";
    }
  }

  function corridorDisplayName(code) {
    const c = (state.catalog?.corridors || []).find((x) => x.code === code);
    return c ? c.name : code;
  }

  function isSafetyDisclaimer(msg) {
    const low = String(msg || "").toLowerCase();
    return (
      low.includes("yellow line") ||
      low.includes("text help to") ||
      low.includes("do not cross tracks") ||
      low.includes("trains may move at any time")
    );
  }

  function renderBoard() {
    const live = state.live;
    if (!live) return;

    updateFreshnessUI();

    const route = live.route || {};
    const homeName = live.home_meta?.name || route.home_station;
    const destName = live.dest_meta?.name || route.dest_station;
    const isH2D = state.direction === "home_to_dest";

    const activeCorr = isH2D ? route.home_corridor : route.dest_corridor;
    const lineCode = activeCorr || route.home_corridor || "GO";
    const lineColor = CORRIDOR_COLORS[lineCode] || "#248a3d";
    $("route-card").style.setProperty("--line-color", lineColor);
    $("board-line-code").textContent = lineCode;
    const homeCorrName = corridorDisplayName(route.home_corridor);
    const destCorrName = corridorDisplayName(route.dest_corridor);
    $("board-line-name").textContent =
      route.home_corridor && route.dest_corridor && route.home_corridor !== route.dest_corridor
        ? `${homeCorrName} / ${destCorrName}`
        : `${corridorDisplayName(lineCode)} Line`;

    $("board-from-name").textContent = isH2D ? homeName : destName;
    $("board-to-name").textContent = isH2D ? destName : homeName;
    $("btn-swap-dir").classList.toggle("flipped", !isH2D);

    const elig = (live.eligibility || {})[state.direction] || {};
    const armedBadge = $("alert-armed-badge");
    if (elig.active) {
      armedBadge.className = "pill";
      armedBadge.innerHTML = `${svgIcon("bell-ring", "sm")}<span>Alerts on · ${escapeHtml(elig.reason)}</span>`;
    } else {
      armedBadge.className = "pill muted";
      armedBadge.innerHTML = `${svgIcon("bell-off", "sm")}<span>Outside schedule</span>`;
    }

    const msgsByDir = live.station_messages_by_dir || {};
    const rawMsgs = msgsByDir[state.direction] ?? live.station_messages ?? [];
    const advBox = $("advisories-box");
    if (rawMsgs.length > 0) {
      const operational = rawMsgs.filter((m) => !isSafetyDisclaimer(m));
      const safety = rawMsgs.filter((m) => isSafetyDisclaimer(m));
      const sorted = [...operational, ...safety];
      advBox.classList.remove("hidden");
      if (operational.length > 0) {
        $("advisories-summary").textContent =
          safety.length > 0
            ? `Service Advisories (${operational.length}) · ${safety.length} safety`
            : `Service Advisories (${operational.length})`;
      } else {
        $("advisories-summary").textContent = `Station Safety Notices (${safety.length})`;
      }
      $("advisories-list").innerHTML = sorted
        .map((m) => `<li class="${isSafetyDisclaimer(m) ? "adv-safety" : ""}">${escapeHtml(m)}</li>`)
        .join("");
    } else {
      advBox.classList.add("hidden");
    }

    const nowMs = Date.now();
    const deps = (live.departures || []).filter((d) => d.direction === state.direction);
    const listEl = $("departures-list");

    if (!deps.length) {
      state.lastBoardSig = null;
      listEl.innerHTML = `<div class="empty-state">No departures found for this direction today.</div>`;
      return;
    }

    const enrichDep = (d) => {
      const predMs = new Date(d.predicted_time || d.scheduled_time).getTime();
      const minsUntil = Math.round((predMs - nowMs) / 60000);
      const isPast = minsUntil < -3;
      const delayMin = Math.round((d.delay_sec || 0) / 60);
      const isDelayed = delayMin >= 3;
      const isProceed = (d.info_status || "").toLowerCase().includes("proceed");
      const isUnionOrigin = d.origin_code === "UN";

      const countdownTxt = formatCountdown(minsUntil, d.predicted_time || d.scheduled_time);

      let platHtml = `<div class="plat-badge">Plat —</div>`;
      const pred = d.predicted_platform;
      if (d.platform && d.platform !== "-") {
        if (isProceed) {
          platHtml = `<div class="plat-badge assigned proceed">Plat ${escapeHtml(d.platform)}</div>`;
        } else if (isUnionOrigin) {
          platHtml = `<div class="plat-badge assigned-live">Plat ${escapeHtml(d.platform)}</div>`;
        } else {
          platHtml = `<div class="plat-badge assigned">Plat ${escapeHtml(d.platform)}</div>`;
        }
      } else if (pred && pred.platform) {
        platHtml = `
          <div class="plat-badge predicted" title="${escapeHtml(pred.source_label || "Estimated platform")}">
            <span class="plat-est-main">Est. ${escapeHtml(pred.platform)}</span>
            <span class="plat-est-sub">${pred.confidence_pct}%</span>
          </div>`;
      } else if (d.sch_track && d.sch_track !== "-") {
        platHtml = `<div class="plat-badge hint">Sched ${escapeHtml(d.sch_track)}</div>`;
      }

      let statusPill = `<span class="pill">On Time</span>`;
      if (d.is_cancelled) {
        statusPill = `<span class="pill danger">Cancelled</span>`;
      } else if (isDelayed) {
        statusPill = `<span class="pill warn">+${delayMin}m Late</span>`;
      } else if (isProceed) {
        statusPill = `<span class="pill">Boarding</span>`;
      }

      const isShort =
        d.coach_count != null && d.scheduled_coach_count && d.coach_count < d.scheduled_coach_count;
      const metaBits = [`Train #${escapeHtml(d.trip_number)}`];
      if (d.coach_count != null && !isShort) {
        metaBits.push(`${d.coach_count} cars`);
      }
      if (d.is_express) {
        metaBits.push("Express");
      }
      const metaText = `<span class="train-num">${metaBits.join(' <span class="meta-sep">&middot;</span> ')}</span>`;
      const shortBadge = isShort
        ? `<span class="pill warn">${d.coach_count}/${d.scheduled_coach_count} cars</span>`
        : "";
      const alertIcon = d.eligible_for_alerts
        ? `<span class="ico-ok" title="Alerts active for this departure">${svgIcon("bell", "sm")}</span>`
        : "";

      const isExpanded = state.expandedTrip === d.trip_number;
      const detailHtml = isExpanded ? renderTripDetail(d) : "";

      return {
        d,
        predMs,
        isPast,
        isDelayed,
        isExpanded,
        countdownTxt,
        platHtml,
        statusPill,
        metaText,
        shortBadge,
        alertIcon,
        detailHtml,
      };
    };

    const enriched = deps.map(enrichDep);
    const upcoming = enriched.filter((item) => !item.isPast);
    const earlier = enriched.filter((item) => item.isPast);
    const earlierOpen = Boolean(state.earlierOpenByDir[state.direction]) || earlier.some((item) => item.isExpanded);

    const boardSig = JSON.stringify({
      dir: state.direction,
      exp: state.expandedTrip,
      det: state.expandedTrip ? Boolean(state.tripDetails[state.expandedTrip]) : false,
      err: state.expandedTrip ? state.tripDetails[state.expandedTrip]?.error || null : null,
      items: enriched.map((item) => ({
        t: item.d.trip_number,
        p: item.isPast,
        pl: item.d.platform,
        pr: item.d.predicted_platform?.platform || null,
        prc: item.d.predicted_platform?.confidence_pct || null,
        st: item.d.info_status,
        dl: item.d.delay_sec,
        c: item.d.coach_count,
        sc: item.d.scheduled_coach_count,
        ex: item.d.is_express,
        al: item.d.eligible_for_alerts,
        ca: item.d.is_cancelled,
      })),
    });
    if (boardSig === state.lastBoardSig) {
      tickBoardCountdowns();
      return;
    }
    state.lastBoardSig = boardSig;

    let html = "";

    if (upcoming.length > 0) {
      const hero = upcoming[0];
      const restUpcoming = upcoming.slice(1);

      html += `
        <div class="hero-dep ${hero.isExpanded ? "expanded" : ""}" data-trip="${escapeHtml(hero.d.trip_number)}">
          <button type="button" class="dep-trigger" aria-expanded="${hero.isExpanded ? "true" : "false"}">
            <div class="hero-top">
              <div>
                <div class="hero-kicker">Next departure</div>
                <div class="hero-countdown" data-target-ms="${hero.predMs}">${hero.countdownTxt}</div>
              </div>
              <div class="dep-right">
                ${hero.platHtml}
                ${svgIcon("chevron-down", "sm dep-chevron")}
              </div>
            </div>
            <div class="hero-sub">
              <span class="hero-time ${hero.isDelayed ? "struck" : ""}">${fmtTime(hero.d.scheduled_time)}</span>
              ${hero.isDelayed ? `<span class="hero-pred">${fmtTime(hero.d.predicted_time)}</span>` : ""}
              ${hero.statusPill}
              ${hero.shortBadge}
              ${hero.metaText}
              ${hero.alertIcon}
            </div>
          </button>
          ${hero.detailHtml}
        </div>
      `;

      if (restUpcoming.length > 0) {
        html += `
          <div class="dep-group">
            <div class="dep-group-head">Upcoming</div>
            ${renderDepRows(restUpcoming)}
          </div>
        `;
      }
    } else {
      html += `<div class="empty-state">No remaining departures scheduled today for this direction.</div>`;
    }

    if (earlier.length > 0) {
      html += `
        <details class="earlier-details" ${earlierOpen ? "open" : ""}>
          <summary class="earlier-summary">
            <span>Earlier today (${earlier.length})</span>
            ${svgIcon("chevron-down", "sm adv-chevron")}
          </summary>
          <div class="earlier-body">
            ${renderDepRows(earlier)}
          </div>
        </details>
      `;
    }

    listEl.innerHTML = html;

    const earlierEl = listEl.querySelector(".earlier-details");
    if (earlierEl) {
      earlierEl.addEventListener("toggle", () => {
        state.earlierOpenByDir[state.direction] = earlierEl.open;
      });
    }

    listEl.querySelectorAll("[data-trip] .dep-trigger").forEach((btn) => {
      btn.addEventListener("click", () => {
        const trip = btn.closest("[data-trip]").dataset.trip;
        toggleTripDetail(trip);
      });
    });
  }

  function renderDepRows(items) {
    return items
      .map(
        ({ d, predMs, isPast, isDelayed, isExpanded, countdownTxt, platHtml, statusPill, metaText, shortBadge, alertIcon, detailHtml }) => `
          <div class="dep-row ${isPast ? "past" : ""} ${isExpanded ? "expanded" : ""}" data-trip="${escapeHtml(d.trip_number)}">
            <button type="button" class="dep-trigger" aria-expanded="${isExpanded ? "true" : "false"}">
              <div class="dep-main">
                <div class="dep-times">
                  <span class="dep-sched ${isDelayed ? "struck" : ""}">${fmtTime(d.scheduled_time)}</span>
                  ${isDelayed ? `<span class="dep-pred">${fmtTime(d.predicted_time)}</span>` : ""}
                  <span class="dep-countdown" data-target-ms="${predMs}">${countdownTxt}</span>
                </div>
                <div class="dep-right">
                  ${platHtml}
                  ${svgIcon("chevron-down", "sm dep-chevron")}
                </div>
              </div>
              <div class="dep-sub">
                ${statusPill}
                ${shortBadge}
                ${metaText}
                ${alertIcon}
              </div>
            </button>
            ${detailHtml}
          </div>
        `
      )
      .join("");
  }

  function tickBoardCountdowns() {
    updateFreshnessUI();
    if (state.tab !== "board" || !state.live) return;
    const nowMs = Date.now();
    let bucketChanged = false;
    document.querySelectorAll("[data-target-ms]").forEach((el) => {
      const targetMs = Number(el.dataset.targetMs);
      if (!Number.isFinite(targetMs)) return;
      const minsUntil = Math.round((targetMs - nowMs) / 60000);
      const wasPast = Boolean(el.closest(".earlier-details"));
      if (wasPast !== (minsUntil < -3)) {
        bucketChanged = true;
      }
      el.textContent = formatCountdown(minsUntil, new Date(targetMs).toISOString());
    });
    if (bucketChanged) {
      renderBoard();
    }
  }

  function predictionBasisPhrase(p, tripNum, corridor) {
    const n = p.sample_days || 0;
    const schedMatch =
      p.scheduled_track &&
      p.platform &&
      (p.platform === p.scheduled_track ||
        String(p.scheduled_track)
          .split("&")
          .map((s) => s.trim())
          .includes(String(p.platform).trim()));
    const schedSuffix = schedMatch ? " and today's schedule" : "";
    if (p.source === "exact_trip") {
      const numTxt = tripNum ? ` of train #${tripNum}` : "";
      return `${n} past run${n === 1 ? "" : "s"}${numTxt}${schedSuffix}`;
    }
    if (p.source === "corridor_time") {
      return `${n} nearby ${corridor || "line"} departure${n === 1 ? "" : "s"}${schedSuffix}`;
    }
    if (p.source === "corridor") {
      return `${n} ${corridor || "line"} departure${n === 1 ? "" : "s"}${schedSuffix}`;
    }
    if (p.source === "schedule_hint") {
      return "today's scheduled track (no past runs yet)";
    }
    return "";
  }

  function renderTripDetail(dep) {
    const tripNum = dep.trip_number;
    const det = state.tripDetails[tripNum];
    const pred = dep.predicted_platform;
    const predBasis = pred && pred.platform ? predictionBasisPhrase(pred, tripNum, dep.corridor) : "";
    const predLine =
      pred && pred.platform
        ? `<div class="pill info mb-8"><span>Estimated Track ${escapeHtml(pred.platform)} (${pred.confidence_pct}%)${predBasis ? ` &middot; ${escapeHtml(predBasis)}` : ""}</span></div>`
        : "";

    if (!det) {
      return `<div class="dep-detail">${predLine}<span class="hint mb-0">Loading live stop timeline...</span></div>`;
    }
    if (det.error) {
      return `<div class="dep-detail">${predLine}<span class="hint mb-0">Timeline unavailable: ${escapeHtml(det.error)}</span></div>`;
    }
    const rows = (det.stops || [])
      .map((s) => {
        const ci = s.completeInfo;
        const act = ci ? ci.actDeparture || ci.actArrival || "" : "";
        const track = (ci && ci.actTrack) || s.schTrack || "—";
        const delayS = ci && ci.delaySecond ? Math.round(ci.delaySecond / 60) : 0;
        const timeTxt = act
          ? `${s.schArrival} &rarr; <b>${act}</b>${delayS >= 3 ? ` (+${delayS}m)` : ""}`
          : s.schArrival || s.schDeparture || "--:--";
        return `
          <div class="stop-row ${s.isStopping ? "" : "not-stopping"}">
            <span>${escapeHtml(s.name)}${s.isCancelled ? " (Cancelled)" : ""}</span>
            <span>${timeTxt}</span>
            <span class="train-num">Trk ${escapeHtml(track)}</span>
          </div>
        `;
      })
      .join("");
    const headerMeta = [det.tripName || `Trip ${tripNum}`, det.engineId ? `Loco #${det.engineId}` : ""].filter(Boolean);
    return `
      <div class="dep-detail">
        ${predLine}
        <div class="hint mb-8">${escapeHtml(headerMeta.join(" · "))}</div>
        ${rows}
      </div>
    `;
  }

  async function toggleTripDetail(tripNum) {
    if (state.expandedTrip === tripNum) {
      state.expandedTrip = null;
      renderBoard();
      return;
    }
    state.expandedTrip = tripNum;
    renderBoard();
    try {
      const det = await api(`/api/trip/${encodeURIComponent(tripNum)}`);
      state.tripDetails[tripNum] = det;
    } catch (err) {
      state.tripDetails[tripNum] = { error: err.message };
    }
    if (state.expandedTrip === tripNum) renderBoard();
  }

  function populateStationSelects() {
    if (!state.catalog || !state.settings) return;
    const corridors = state.catalog.corridors || [];
    const route = state.settings.route || {};

    function fillPair(corrSelId, statSelId, selectedCorr, selectedStat) {
      const corrSel = $(corrSelId);
      const statSel = $(statSelId);
      corrSel.innerHTML = corridors
        .map((c) => `<option value="${c.code}">${escapeHtml(c.name)} (${c.code})</option>`)
        .join("");
      corrSel.value = selectedCorr;

      function updateStations(pickCode) {
        const prevCode = statSel.value;
        const c = corridors.find((x) => x.code === corrSel.value) || corridors[0];
        const stops = c ? c.stops : [];
        statSel.innerHTML = stops
          .map((s) => `<option value="${s.code}">${escapeHtml(s.name)} (${s.code})</option>`)
          .join("");
        if (pickCode && stops.some((s) => s.code === pickCode)) {
          statSel.value = pickCode;
        } else if (prevCode && stops.some((s) => s.code === prevCode)) {
          statSel.value = prevCode;
        } else if (statSelId === "sel-dest-stat" && stops.some((s) => s.code === "UN")) {
          statSel.value = "UN";
        }
      }

      updateStations(selectedStat);
      corrSel.onchange = () => updateStations(null);
    }

    fillPair("sel-home-corr", "sel-home-stat", route.home_corridor, route.home_station);
    fillPair("sel-dest-corr", "sel-dest-stat", route.dest_corridor, route.dest_station);
  }

  function routeStationName(code) {
    if (!code) return "";
    const meta = (state.catalog?.stations || {})[code];
    return meta ? meta.name.replace(/\s+GO$/i, "") : code;
  }

  function updateRuleDirectionLabels() {
    const route = state.settings?.route || {};
    const hName = routeStationName(route.home_station) || "Home";
    const dName = routeStationName(route.dest_station) || "Destination";
    const sel = $("rule-dir");
    if (!sel) return;
    sel.options[0].textContent = `${hName} → ${dName}`;
    sel.options[1].textContent = `${dName} → ${hName}`;
    sel.options[2].textContent = "Both Directions";
  }

  function openRuleForm(rule = null) {
    updateRuleDirectionLabels();
    const form = $("rule-form");
    form.classList.remove("hidden");
    if (rule) {
      $("rule-form-title").textContent = "Edit Rule";
      $("rule-edit-id").value = rule.id;
      $("rule-name").value = rule.name || "";
      $("rule-dir").value = rule.direction || "home_to_dest";
      $("rule-start").value = rule.start || "06:30";
      $("rule-end").value = rule.end || "09:30";
      const activeSet = new Set(rule.days || [0, 1, 2, 3, 4]);
      $("rule-days-picker").querySelectorAll(".day-btn").forEach((b) => {
        const on = activeSet.has(Number(b.dataset.day));
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
    } else {
      $("rule-form-title").textContent = "New Rule";
      $("rule-edit-id").value = "";
      $("rule-name").value = "";
      $("rule-dir").value = "home_to_dest";
      $("rule-start").value = "06:30";
      $("rule-end").value = "09:30";
      $("rule-days-picker").querySelectorAll(".day-btn").forEach((b) => {
        const on = Number(b.dataset.day) < 5;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }
    form.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function renderSettings() {
    const s = state.settings;
    if (!s) return;
    populateStationSelects();
    updateRuleDirectionLabels();

    const route = s.route || {};
    const hName = routeStationName(route.home_station) || "Home";
    const dName = routeStationName(route.dest_station) || "Destination";

    const rules = s.rules || [];
    $("rules-list").innerHTML = rules.length
      ? rules
          .map((r) => {
            const daysTxt = formatDays(r.days);
            const dirTxt =
              r.direction === "home_to_dest"
                ? `${hName} &rarr; ${dName}`
                : r.direction === "dest_to_home"
                ? `${dName} &rarr; ${hName}`
                : "Both directions";
            return `
              <div class="rule-item">
                <div>
                  <div class="rule-item-title">
                    <b>${escapeHtml(r.name)}</b>
                    ${r.enabled ? '<span class="pill">Active</span>' : '<span class="pill muted">Paused</span>'}
                  </div>
                  <div class="rule-item-meta">${dirTxt} &middot; ${escapeHtml(r.start)}&ndash;${escapeHtml(r.end)} &middot; ${escapeHtml(daysTxt)}</div>
                </div>
                <div class="btn-row">
                  <button type="button" class="btn-small secondary" data-edit-rule="${escapeHtml(r.id)}" aria-label="Edit rule">${svgIcon("pencil", "sm")}</button>
                  <button type="button" class="btn-small secondary" data-toggle-rule="${escapeHtml(r.id)}">${r.enabled ? "Pause" : "Resume"}</button>
                  <button type="button" class="btn-small secondary" data-del-rule="${escapeHtml(r.id)}" aria-label="Delete rule">${svgIcon("trash-2", "sm")}</button>
                </div>
              </div>
            `;
          })
          .join("")
      : `<div class="hint mb-0" style="padding:12px;">No alert windows configured yet.</div>`;

    $("rules-list").querySelectorAll("[data-edit-rule]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const rule = (state.settings.rules || []).find((r) => r.id === btn.dataset.editRule);
        if (rule) openRuleForm(rule);
      });
    });
    $("rules-list").querySelectorAll("[data-toggle-rule]").forEach((btn) => {
      btn.addEventListener("click", () => toggleRule(btn.dataset.toggleRule));
    });
    $("rules-list").querySelectorAll("[data-del-rule]").forEach((btn) => {
      btn.addEventListener("click", () => deleteRule(btn.dataset.delRule));
    });

    const p = s.alert_prefs || {};
    $("pref-plat-ann").checked = !!p.platform_announced;
    $("pref-plat-chg").checked = !!p.platform_changed;
    $("pref-proceed").checked = !!p.boarding_proceed;
    $("pref-cancelled").checked = !!p.cancelled;
    $("pref-short").checked = !!p.short_train;
    $("pref-delay-min").value = p.delay_threshold_min ?? 3;
    $("pref-delay-step").value = p.delay_change_step_min ?? 3;
    $("pref-lead-min").value = p.lead_window_min ?? 90;

    const ch = s.channels || {};
    $("chan-ntfy-topic").value = ch.ntfy_topic || "";
    $("chan-ntfy-server").value = ch.ntfy_server || "https://ntfy.sh";
    $("chan-webhook").value = ch.webhook_url || "";

    const loc = s.location_state || {};
    const statusEl = $("loc-override-status");
    const isActive = loc.override_direction && loc.expires_at && new Date(loc.expires_at).getTime() > Date.now();
    if (isActive) {
      const dirLabel = loc.override_direction === "dest_to_home" ? `${dName} → ${hName}` : `${hName} → ${dName}`;
      statusEl.className = "pill";
      statusEl.textContent = `Active: ${dirLabel} until ${fmtTime(loc.expires_at)}`;
    } else {
      statusEl.className = "pill muted";
      statusEl.textContent = "No active location override";
    }

    const origin = window.location.origin;
    const tok = encodeURIComponent(loc.webhook_token || "");
    const hooks = [
      { label: `Arrive at ${hName} (arms ${hName} → ${dName} for 2h)`, url: `${origin}/api/location/webhook?token=${tok}&zone=home&ttl_min=120` },
      { label: `Arrive at ${dName} (arms ${dName} → ${hName} for 2h)`, url: `${origin}/api/location/webhook?token=${tok}&zone=dest&ttl_min=120` },
      { label: "Leave Station / Clear (reverts to schedule)", url: `${origin}/api/location/webhook?token=${tok}&zone=clear` },
    ];
    $("shortcut-urls").innerHTML = hooks
      .map(
        (h, i) => `
      <div class="copy-row">
        <div class="copy-row-text"><b>${escapeHtml(h.label)}</b><br/><span class="copy-row-url">${escapeHtml(h.url)}</span></div>
        <button type="button" class="btn-copy" data-copy-idx="${i}" title="Copy URL" aria-label="Copy ${escapeHtml(h.label)}">${svgIcon("copy", "sm")}</button>
      </div>`
      )
      .join("");
    $("shortcut-urls").querySelectorAll(".btn-copy").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const target = hooks[Number(btn.dataset.copyIdx)].url;
        try {
          await navigator.clipboard.writeText(target);
          btn.classList.add("copied");
          btn.innerHTML = svgIcon("check", "sm");
          showToast("Webhook URL copied");
          setTimeout(() => {
            btn.classList.remove("copied");
            btn.innerHTML = svgIcon("copy", "sm");
          }, 1500);
        } catch (_) {
          showToast("Clipboard permission denied", "err");
        }
      });
    });

    updateWebPushUI();
  }

  async function toggleRule(id) {
    try {
      const rules = (state.settings.rules || []).map((r) =>
        r.id === id ? { ...r, enabled: !r.enabled } : r
      );
      state.settings = await api("/api/settings", { method: "PUT", body: JSON.stringify({ rules }) });
      renderSettings();
      refreshLive();
    } catch (err) {
      showToast(err.message, "err");
    }
  }

  async function deleteRule(id) {
    try {
      const rules = (state.settings.rules || []).filter((r) => r.id !== id);
      state.settings = await api("/api/settings", { method: "PUT", body: JSON.stringify({ rules }) });
      renderSettings();
      refreshLive();
      showToast("Rule deleted");
    } catch (err) {
      showToast(err.message, "err");
    }
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = window.atob(base64);
    return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
  }

  async function updateWebPushUI() {
    const msgEl = $("webpush-status-msg");
    const subBtn = $("btn-webpush-sub");
    const unsubBtn = $("btn-webpush-unsub");

    if (!window.isSecureContext) {
      msgEl.innerHTML = `${svgIcon("triangle-alert", "sm ico-warn")} Web Push requires <b>HTTPS</b>. Use <b>ntfy.sh</b> under Backup Channels over HTTP.`;
      subBtn.disabled = true;
      return;
    }
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      msgEl.innerHTML = `${svgIcon("info", "sm ico-info")} On iPhone/iPad, tap <b>Share &rarr; Add to Home Screen</b> first, then open the installed app to enable Web Push.`;
      subBtn.disabled = true;
      return;
    }

    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        msgEl.innerHTML = `${svgIcon("circle-check", "sm ico-ok")} Web Push enabled on this device.`;
        subBtn.classList.add("hidden");
        unsubBtn.classList.remove("hidden");
      } else {
        msgEl.textContent = `Ready (permission: ${Notification.permission}). Tap below to enable alerts.`;
        subBtn.disabled = false;
        subBtn.classList.remove("hidden");
        unsubBtn.classList.add("hidden");
      }
    } catch (err) {
      msgEl.textContent = "Service Worker initializing: " + err.message;
    }
  }

  async function subscribeWebPush() {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        $("webpush-status-msg").textContent = "Notification permission was denied.";
        return;
      }
      const { publicKey } = await api("/api/push/vapid-public-key");
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await api("/api/push/subscribe", { method: "POST", body: JSON.stringify(sub.toJSON()) });
      updateWebPushUI();
      showToast("Web Push enabled");
    } catch (err) {
      $("webpush-status-msg").textContent = "Subscribe failed: " + err.message;
      showToast("Could not enable Web Push", "err");
    }
  }

  async function unsubscribeWebPush() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api("/api/push/unsubscribe", {
          method: "POST",
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      updateWebPushUI();
      showToast("Web Push disabled");
    } catch (err) {
      $("webpush-status-msg").textContent = "Unsubscribe failed: " + err.message;
    }
  }

  // ---- Union Platform Predictor ----
  function initPredictor() {
    if (state.predictorInited || !state.catalog) return;
    state.predictorInited = true;

    const corridors = state.catalog.corridors || [];
    const route = state.settings?.route || {};
    const defCorr = route.dest_station === "UN" ? route.home_corridor : route.dest_corridor;
    const defStat = route.dest_station === "UN" ? route.home_station : route.dest_station;

    const corrSel = $("pred-corridor");
    const statSel = $("pred-station");
    corrSel.innerHTML = corridors
      .map((c) => `<option value="${c.code}">${escapeHtml(c.name)} (${c.code})</option>`)
      .join("");
    if (defCorr && corridors.some((c) => c.code === defCorr)) {
      corrSel.value = defCorr;
    }

    function fillPredStations(pickCode) {
      const c = corridors.find((x) => x.code === corrSel.value) || corridors[0];
      const stops = (c ? c.stops : []).filter((s) => s.code !== "UN");
      statSel.innerHTML = stops
        .map((s) => `<option value="${s.code}">${escapeHtml(s.name)} (${s.code})</option>`)
        .join("");
      if (pickCode && stops.some((s) => s.code === pickCode)) {
        statSel.value = pickCode;
      }
    }

    fillPredStations(defStat);
    $("pred-time").value = nowTorontoHHMM();

    corrSel.addEventListener("change", () => {
      fillPredStations(null);
      loadPrediction({ time: $("pred-time").value });
    });
    statSel.addEventListener("change", () => loadPrediction({ time: $("pred-time").value }));
    $("pred-trip").addEventListener("change", () => {
      loadPrediction({ trip_number: $("pred-trip").value });
    });
    const runSnap = () => {
      const val = $("pred-time").value.trim();
      if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(val)) {
        showToast("Enter time in 24h HH:MM format", "err");
        return;
      }
      const norm = val.length === 4 ? "0" + val : val;
      $("pred-time").value = norm;
      loadPrediction({ time: norm });
    };
    $("btn-pred-snap").addEventListener("click", runSnap);
    $("pred-time").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        runSnap();
      }
    });

    loadPrediction({ time: $("pred-time").value });
  }

  function confidenceTier(pct) {
    if (pct >= 70) return { label: "High confidence", cls: "pill" };
    if (pct >= 40) return { label: "Moderate confidence", cls: "pill info" };
    return { label: "Early estimate", cls: "pill warn" };
  }

  async function loadPrediction({ trip_number = "", time = "" } = {}) {
    const corr = $("pred-corridor").value;
    const stat = $("pred-station").value;
    if (!corr || !stat) return;

    const qs = new URLSearchParams({ corridor: corr, station: stat });
    if (trip_number) qs.set("trip_number", trip_number);
    else if (time) qs.set("time", time);

    const box = $("pred-result");
    box.innerHTML = `<span class="hint mb-0">Checking platform history...</span>`;
    try {
      const res = await api(`/api/predict/platform?${qs.toString()}`);
      const trips = res.available_trips || [];
      const tripSel = $("pred-trip");
      tripSel.innerHTML = trips.length
        ? trips
            .map(
              (t) =>
                `<option value="${escapeHtml(t.number)}">${escapeHtml(t.dep_time)} &middot; #${escapeHtml(t.number)} (${escapeHtml(t.destination)})</option>`
            )
            .join("")
        : `<option value="">No Union departures listed</option>`;

      if (res.matched_trip?.number) {
        tripSel.value = res.matched_trip.number;
      }

      const p = res.prediction || {};
      const snapNote =
        res.snapped_from_time && res.matched_trip && res.snap_diff_min != null && res.snap_diff_min > 0
          ? `<div class="pill info mb-8">${svgIcon("clock", "sm")}<span>Closest train to ${escapeHtml(res.snapped_from_time)}: ${escapeHtml(res.matched_trip.dep_time)} (#${escapeHtml(res.matched_trip.number)})</span></div>`
          : "";

      const platLabel = p.platform ? `Platform ${escapeHtml(p.platform)}` : "No Data Yet";
      const tier = confidenceTier(p.confidence_pct || 0);
      const totalCands = (p.candidates || []).reduce((acc, c) => acc + (c.count || 0), 0);

      const candsHtml =
        totalCands > 0 && (p.candidates || []).length
          ? `<div class="pred-cands">
            ${p.candidates
              .map(
                (c) => `
              <div class="cand-row">
                <b>Plat ${escapeHtml(c.platform)}</b>
                <div class="cand-bar"><div style="width:${Math.min(100, c.pct)}%"></div></div>
                <span>${c.count} of ${totalCands} run${totalCands === 1 ? "" : "s"}</span>
              </div>`
              )
              .join("")}
          </div>`
          : "";

      const basis = predictionBasisPhrase(p, res.matched_trip?.number || trip_number, corr);
      const basisLine = basis
        ? `Prediction based on ${basis}`
        : "No platform history logged for this line yet.";

      const confBadge = p.platform
        ? `<span class="${tier.cls}">${tier.label} &middot; ${p.confidence_pct || 0}%</span>`
        : "";

      box.innerHTML = `
        ${snapNote}
        <div class="pred-hero">
          <div>
            <div class="endpoint-label">Most likely track</div>
            <div class="pred-plat-big">${platLabel}</div>
          </div>
          ${confBadge}
        </div>
        <div class="hint mt-8 mb-0">${escapeHtml(basisLine)}</div>
        ${candsHtml}
      `;
    } catch (err) {
      box.innerHTML = `<span class="hint mb-0">Prediction unavailable: ${escapeHtml(err.message)}</span>`;
    }
  }

  async function loadAnalyticsAndEvents() {
    try {
      const [ana, evResp] = await Promise.all([
        api("/api/analytics?days=30"),
        api(`/api/events?limit=80&type=${encodeURIComponent($("events-filter").value)}`),
      ]);
      const k = ana.kpis || {};
      const sampleCount = k.outcome_sample_count ?? k.total_outcomes ?? 0;
      const sampleNote = sampleCount > 0 && sampleCount < 10 ? " (early sample)" : "";
      $("kpi-context").textContent = `Last ${ana.days || 30} days · ${sampleCount} tracked trips${sampleNote}`;

      const avgDelayTxt = k.avg_delay_min != null ? `${Number(k.avg_delay_min).toFixed(1)}m` : "--";
      const maxDelayTxt = k.max_delay_min != null ? `Worst ${k.max_delay_min}m` : "No delays logged";
      const unionLeadTxt = k.avg_platform_lead_min != null ? `${k.avg_platform_lead_min}m` : "--";
      const schMatchTxt =
        k.sch_track_match_pct != null ? `${k.sch_track_match_pct}% matched sched` : "Union gate announcements";
      const sgTxt =
        k.service_guarantee_hits > 0
          ? `${k.service_guarantee_hits} delay >=15m`
          : "0 delays >=15m";

      $("kpi-grid").innerHTML = `
        <div class="kpi-card">
          <div class="kpi-label">On-Time (&lt;3m)</div>
          <div class="kpi-val">${k.on_time_pct ?? 100}%</div>
          <div class="kpi-note">${sampleCount} trip${sampleCount === 1 ? "" : "s"}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Average Delay</div>
          <div class="kpi-val">${avgDelayTxt}</div>
          <div class="kpi-note">${escapeHtml(maxDelayTxt)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Union Track Lead</div>
          <div class="kpi-val">${unionLeadTxt}</div>
          <div class="kpi-note">${escapeHtml(schMatchTxt)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Short Trains</div>
          <div class="kpi-val">${k.short_train_pct ?? 0}%</div>
          <div class="kpi-note">${escapeHtml(sgTxt)}</div>
        </div>
      `;

      const hourly = ana.hourly_breakdown || [];
      const maxHr = Math.max(5, ...hourly.map((h) => h.avg_delay_min || 0));
      $("hourly-wrap").innerHTML = hourly.length
        ? `<div class="hourly-bars">
            ${hourly
              .map((h) => {
                const pct = Math.min(100, Math.round(((h.avg_delay_min || 0) / maxHr) * 100));
                const tone = h.avg_delay_min >= 7 ? "danger" : h.avg_delay_min >= 3 ? "warn" : "";
                return `
                  <div class="hourly-row">
                    <span class="hourly-hour">${escapeHtml(h.label)}</span>
                    <div class="hourly-track"><div class="hourly-fill ${tone}" style="width:${Math.max(4, pct)}%"></div></div>
                    <span>${h.avg_delay_min}m (${h.samples})</span>
                  </div>
                `;
              })
              .join("")}
          </div>`
        : `<p class="hint mb-0">Hourly delay trends appear once departures are logged.</p>`;

      const drift = ana.prediction_drift || [];
      $("drift-table-wrap").innerHTML = `
        <table class="data-table">
          <thead>
            <tr>
              <th>Before Dep</th>
              <th>Trips</th>
              <th>Avg Error</th>
              <th>Under-Est</th>
              <th>Surprise Late</th>
            </tr>
          </thead>
          <tbody>
            ${drift
              .map(
                (r) => `
              <tr>
                <td><b>${escapeHtml(r.bucket)}</b></td>
                <td>${r.sample_count}</td>
                <td>${r.mean_abs_error_min != null ? Number(r.mean_abs_error_min).toFixed(1) + "m" : "--"}</td>
                <td>${r.mean_underestimation_min != null ? (r.mean_underestimation_min > 0 ? "+" : "") + Number(r.mean_underestimation_min).toFixed(1) + "m" : "--"}</td>
                <td>${r.phantom_ontime_pct != null ? r.phantom_ontime_pct + "%" : "--"}</td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
      `;

      const plats = ana.platform_patterns || [];
      $("platform-table-wrap").innerHTML = plats.length
        ? `<table class="data-table">
            <thead>
              <tr>
                <th>Train</th>
                <th>Track</th>
                <th>Consistency</th>
                <th>Avg Lead</th>
                <th>Sched</th>
              </tr>
            </thead>
            <tbody>
              ${plats
                .map(
                  (p) => `<tr>
                    <td>#${escapeHtml(p.trip_number)}</td>
                    <td><b>${escapeHtml(p.most_common_platform)}</b></td>
                    <td>${p.consistency_pct}% (${p.samples})</td>
                    <td>${p.avg_lead_min != null ? p.avg_lead_min + "m" : "--"}</td>
                    <td>${escapeHtml(p.sch_track || "--")}</td>
                  </tr>`
                )
                .join("")}
            </tbody>
          </table>`
        : `<p class="hint mb-0">Platform patterns accumulate automatically as trains run.</p>`;

      const offs = ana.top_offenders || [];
      $("offenders-table-wrap").innerHTML = offs.length
        ? `<table class="data-table">
            <thead>
              <tr>
                <th>Train</th>
                <th>Runs</th>
                <th>Avg Delay</th>
                <th>Max</th>
                <th>Worst Miss</th>
              </tr>
            </thead>
            <tbody>
              ${offs
                .map(
                  (o) => `<tr>
                    <td>#${escapeHtml(o.trip_number)}</td>
                    <td>${o.runs}</td>
                    <td>${o.avg_delay_min}m</td>
                    <td>${o.max_delay_min}m</td>
                    <td>${o.worst_miss_min != null ? "+" + o.worst_miss_min + "m" : "--"}</td>
                  </tr>`
                )
                .join("")}
            </tbody>
          </table>`
        : `<p class="hint mb-0">Frequent delay rankings populate as trip outcomes are recorded.</p>`;

      const events = evResp.events || [];
      $("events-list").innerHTML = events.length
        ? events
            .map(
              (ev) => `
            <div class="event-row">
              <div class="event-head">
                <span>${escapeHtml(ev.title)}</span>
                <span class="pill ${ev.notified ? "" : "muted"}">${ev.notified ? "Sent" : "Logged"}</span>
              </div>
              <div>${escapeHtml(ev.body)}</div>
              <div class="event-meta">${fmtTime(ev.created_at)} &middot; ${escapeHtml(ev.event_type)}${ev.rule_matched ? " &middot; " + escapeHtml(ev.rule_matched) : ""}</div>
            </div>`
            )
            .join("")
        : `<div class="hint mb-0" style="padding:12px;">No events recorded for your profile yet.</div>`;
    } catch (err) {
      $("kpi-grid").innerHTML = `<div class="empty-state">Unable to load analytics: ${escapeHtml(err.message)}</div>`;
    }
  }

  async function loadSystemTab() {
    const setupUrlEl = $("pwa-setup-url");
    if (setupUrlEl) setupUrlEl.textContent = window.location.origin;

    try {
      const [h, me] = await Promise.all([api("/api/health"), api("/api/me")]);
      state.me = me;
      const u = me.user || {};
      $("profile-name-input").value = u.display_name || "Commuter";
      $("profile-stats").innerHTML = `
        <div class="stat-row"><span>Paired Browsers</span><b>${me.session_count ?? 1}</b></div>
        <div class="stat-row"><span>Push Subscriptions</span><b>${me.counts?.push_subs_count ?? 0}</b></div>
        <div class="stat-row"><span>Alerts Sent (Profile)</span><b>${me.counts?.notified_count ?? 0}</b></div>
      `;

      const obs = h.snapshot_observations ?? h.snapshots_count ?? 0;
      const savedPct = obs > 0 ? Math.max(0, Math.round(100 * (1 - h.snapshots_count / obs))) : 0;
      $("system-stats").innerHTML = `
        <div class="stat-row"><span>Poller Status</span><b>${h.poll_ok ? "Healthy" : "Error: " + escapeHtml(h.last_error || "unknown")}</b></div>
        <div class="stat-row"><span>Last Poll</span><b>${h.last_poll_at ? fmtRelative(h.last_poll_at) : "never"} (${h.last_poll_ms}ms)</b></div>
        <div class="stat-row"><span>Live Departures Cached</span><b>${h.trips_live}</b></div>
        <div class="stat-row"><span>Snapshots Stored</span><b>${h.snapshots_count} (${obs} polls, ${savedPct}% coalesced)</b></div>
        <div class="stat-row"><span>Outcomes Stored</span><b>${h.outcomes_count}</b></div>
        <div class="stat-row"><span>Database Size</span><b>${h.db_size_kb != null ? h.db_size_kb + " KB" : "--"}</b></div>
      `;

      const standalone =
        window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
      const swSupported = "serviceWorker" in navigator;
      const notifSupported = "Notification" in window;
      $("ios-checklist").innerHTML = `
        <li>${window.isSecureContext ? svgIcon("circle-check", "sm ico-ok") : svgIcon("triangle-alert", "sm ico-warn")} <span>HTTPS Connection: <b>${window.isSecureContext ? "Yes" : "No (required for iOS Push)"}</b></span></li>
        <li>${standalone ? svgIcon("circle-check", "sm ico-ok") : svgIcon("info", "sm ico-info")} <span>Home Screen App: <b>${standalone ? "Installed" : "Running in browser tab"}</b></span></li>
        <li>${swSupported ? svgIcon("circle-check", "sm ico-ok") : svgIcon("circle-x", "sm ico-err")} <span>Service Worker: <b>${swSupported ? "Supported" : "Unavailable"}</b></span></li>
        <li>${notifSupported ? svgIcon("circle-check", "sm ico-ok") : svgIcon("info", "sm ico-info")} <span>Web Push API: <b>${notifSupported ? "Ready" : "Requires Home Screen app on iOS"}</b></span></li>
      `;
    } catch (err) {
      $("system-stats").innerHTML = `<div class="hint mb-0">Diagnostics unavailable: ${escapeHtml(err.message)}</div>`;
    }
  }

  async function refreshLive() {
    try {
      const live = await api("/api/live");
      state.fetchError = null;
      state.live = live;
      autoChooseDirection(live);
      renderBoard();
    } catch (err) {
      state.fetchError = err.message || "Network error";
      updateFreshnessUI();
    }
  }

  function connectSSE() {
    if (state.sse) state.sse.close();
    const es = new EventSource("/api/stream");
    es.onopen = () => {
      state.sseConnected = true;
      updateFreshnessUI();
    };
    es.addEventListener("update", () => {
      state.sseConnected = true;
      refreshLive();
    });
    es.onerror = () => {
      state.sseConnected = false;
      updateFreshnessUI();
    };
    state.sse = es;
  }

  async function handleLocate() {
    if (!navigator.geolocation) {
      showToast("Geolocation is unavailable in this browser", "err");
      return;
    }
    const btn = $("btn-locate");
    btn.disabled = true;
    btn.querySelector("span").textContent = "Locating...";
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const res = await api("/api/location/ping", {
            method: "POST",
            body: JSON.stringify({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
          });
          state.direction = res.recommended_direction;
          state.manualDirSelected = true;
          const badge = $("gps-badge");
          badge.classList.remove("hidden");
          badge.innerHTML = res.nearest_station
            ? `${svgIcon("map-pin", "sm")}<span>Near ${escapeHtml(res.nearest_station.name)} (${res.nearest_station.distance_km} km)</span>`
            : `${svgIcon("map-pin", "sm")}<span>Direction updated</span>`;
          renderBoard();
        } catch (err) {
          showToast("Location lookup failed: " + err.message, "err");
        } finally {
          btn.disabled = false;
          btn.querySelector("span").textContent = "Locate";
        }
      },
      (err) => {
        btn.disabled = false;
        btn.querySelector("span").textContent = "Locate";
        showToast("GPS unavailable: " + err.message, "err");
      },
      { enableHighAccuracy: false, timeout: 8000 }
    );
  }

  function formatPushResults(results) {
    const lines = [];
    if (results.web_push) {
      const wp = results.web_push;
      if (wp.status === "ok") {
        lines.push(`Web Push: delivered to ${wp.delivered} device${wp.delivered === 1 ? "" : "s"}.`);
      } else if (wp.status === "no_subscribers") {
        lines.push("Web Push: not enabled on this device yet.");
      } else {
        lines.push(`Web Push: failed (${(wp.errors || []).join(", ") || "error"}).`);
      }
    }
    if (results.ntfy) {
      lines.push(
        results.ntfy.status === "ok"
          ? "ntfy.sh: test sent."
          : `ntfy.sh: ${results.ntfy.detail || results.ntfy.status}.`
      );
    }
    if (results.webhook) {
      lines.push(
        results.webhook.status === "ok"
          ? "Webhook: delivered."
          : `Webhook: ${results.webhook.detail || results.webhook.status}.`
      );
    }
    return lines.length ? lines.join(" ") : "No notification channels configured yet.";
  }

  const GUIDE_STORAGE_KEY = "gtpp_guide_seen_v1";

  function setupHelpGuide() {
    const modal = $("help-modal");
    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

    const pwaEl = $("guide-pwa-copy");
    if (pwaEl) {
      pwaEl.innerHTML = isStandalone
        ? "Already running as an installed Home Screen app &mdash; enable lock-screen alerts under <strong>Alerts &rarr; Push Notifications</strong>."
        : "On iPhone/iPad, open this URL in <strong>Safari</strong>, tap <strong>Share &rarr; Add to Home Screen</strong>, then launch the installed app icon to enable Web Push alerts.";
    }

    const markSeen = () => {
      try {
        localStorage.setItem(GUIDE_STORAGE_KEY, "1");
      } catch (_) {}
    };

    const openGuide = () => {
      modal.classList.remove("hidden");
    };

    const closeGuide = () => {
      modal.classList.add("hidden");
      markSeen();
    };

    $("btn-open-help").addEventListener("click", openGuide);
    $("help-modal-close").addEventListener("click", closeGuide);
    $("help-modal-done").addEventListener("click", closeGuide);
    $("help-modal-cta").addEventListener("click", () => {
      closeGuide();
      switchTab("alerts");
    });
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeGuide();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.classList.contains("hidden")) {
        closeGuide();
      }
    });

    try {
      if (!localStorage.getItem(GUIDE_STORAGE_KEY)) {
        openGuide();
      }
    } catch (_) {}
  }

  async function init() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    setupHelpGuide();

    document.querySelectorAll(".nav-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    $("btn-swap-dir").addEventListener("click", () => {
      state.manualDirSelected = true;
      state.direction = state.direction === "home_to_dest" ? "dest_to_home" : "home_to_dest";
      renderBoard();
    });

    $("btn-locate").addEventListener("click", handleLocate);

    const doPoll = async () => {
      const topIcon = $("btn-poll-top").querySelector("svg");
      topIcon?.classList.add("spinning");
      $("btn-poll-top").disabled = true;
      $("freshness-label").textContent = "Refreshing...";
      try {
        state.live = await api("/api/poll", { method: "POST" });
        state.fetchError = null;
        renderBoard();
        if (state.tab === "system") loadSystemTab();
      } catch (err) {
        state.fetchError = err.message || "Refresh failed";
        updateFreshnessUI();
        showToast("Refresh failed: " + err.message, "err");
      } finally {
        topIcon?.classList.remove("spinning");
        $("btn-poll-top").disabled = false;
      }
    };
    $("btn-poll-top").addEventListener("click", doPoll);
    $("btn-poll-sys").addEventListener("click", doPoll);
    $("btn-conn-retry").addEventListener("click", doPoll);

    $("btn-compact-db").addEventListener("click", async () => {
      const box = $("compact-result");
      box.className = "status-box";
      box.classList.remove("hidden");
      box.textContent = "Compacting and pruning snapshots...";
      try {
        const res = await api("/api/system/compact", { method: "POST" });
        box.classList.add("ok");
        box.textContent = `Done: ${res.rows_before} -> ${res.rows_after} rows (merged ${res.merged_count}, pruned ${res.pruned_old_count} old, DB ${res.db_size_kb} KB).`;
        loadSystemTab();
      } catch (err) {
        box.classList.add("err");
        box.textContent = "Compaction failed: " + err.message;
      }
    });

    $("btn-toggle-advisories").addEventListener("click", () => {
      const list = $("advisories-list");
      const nowHidden = list.classList.toggle("hidden");
      $("btn-toggle-advisories").setAttribute("aria-expanded", nowHidden ? "false" : "true");
    });

    $("btn-save-route").addEventListener("click", async () => {
      const route = {
        home_corridor: $("sel-home-corr").value,
        home_station: $("sel-home-stat").value,
        dest_corridor: $("sel-dest-corr").value,
        dest_station: $("sel-dest-stat").value,
      };
      if (route.home_station === route.dest_station) {
        showToast("Home and destination stations must be different", "err");
        return;
      }
      try {
        state.settings = await api("/api/settings", { method: "PUT", body: JSON.stringify({ route }) });
        renderSettings();
        showToast("Commute route saved");
        doPoll();
      } catch (err) {
        showToast("Failed to save route: " + err.message, "err");
      }
    });

    $("btn-add-rule").addEventListener("click", () => openRuleForm(null));
    $("btn-cancel-rule").addEventListener("click", () => $("rule-form").classList.add("hidden"));
    $("rule-days-picker").querySelectorAll(".day-btn").forEach((b) => {
      b.addEventListener("click", () => {
        const active = b.classList.toggle("active");
        b.setAttribute("aria-pressed", active ? "true" : "false");
      });
    });

    $("rule-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const days = [...$("rule-days-picker").querySelectorAll(".day-btn.active")].map((b) =>
        Number(b.dataset.day)
      );
      const editId = $("rule-edit-id").value.trim();
      const existing = state.settings.rules || [];
      const prevRule = editId ? existing.find((r) => r.id === editId) : null;
      const ruleObj = {
        id: editId || "rule-" + Date.now(),
        name: $("rule-name").value.trim() || "Commute Rule",
        enabled: prevRule ? prevRule.enabled : true,
        direction: $("rule-dir").value,
        start: $("rule-start").value.trim(),
        end: $("rule-end").value.trim(),
        days: days.length ? days : [0, 1, 2, 3, 4],
      };
      const rules = prevRule
        ? existing.map((r) => (r.id === editId ? ruleObj : r))
        : [...existing, ruleObj];
      try {
        state.settings = await api("/api/settings", { method: "PUT", body: JSON.stringify({ rules }) });
        $("rule-form").classList.add("hidden");
        renderSettings();
        refreshLive();
        showToast(prevRule ? "Rule updated" : "Rule added");
      } catch (err) {
        showToast("Failed to save rule: " + err.message, "err");
      }
    });

    $("btn-save-prefs").addEventListener("click", async () => {
      const alert_prefs = {
        platform_announced: $("pref-plat-ann").checked,
        platform_changed: $("pref-plat-chg").checked,
        boarding_proceed: $("pref-proceed").checked,
        cancelled: $("pref-cancelled").checked,
        short_train: $("pref-short").checked,
        delay_threshold_min: Number($("pref-delay-min").value || 3),
        delay_change_step_min: Number($("pref-delay-step").value || 3),
        lead_window_min: Number($("pref-lead-min").value || 90),
      };
      try {
        state.settings = await api("/api/settings", {
          method: "PUT",
          body: JSON.stringify({ alert_prefs }),
        });
        renderSettings();
        refreshLive();
        showToast("Alert triggers saved");
      } catch (err) {
        showToast("Failed to save triggers: " + err.message, "err");
      }
    });

    $("btn-gen-ntfy").addEventListener("click", () => {
      const rand = Math.random().toString(36).slice(2, 10);
      $("chan-ntfy-topic").value = `gotracker-pp-${rand}`;
    });

    $("btn-save-channels").addEventListener("click", async () => {
      const channels = {
        web_push_enabled: true,
        ntfy_topic: $("chan-ntfy-topic").value.trim(),
        ntfy_server: $("chan-ntfy-server").value.trim() || "https://ntfy.sh",
        webhook_url: $("chan-webhook").value.trim(),
      };
      try {
        state.settings = await api("/api/settings", {
          method: "PUT",
          body: JSON.stringify({ channels }),
        });
        renderSettings();
        showToast("Channels saved");
      } catch (err) {
        showToast("Failed to save channels: " + err.message, "err");
      }
    });

    $("btn-test-push").addEventListener("click", async () => {
      const box = $("push-test-result");
      box.className = "status-box";
      box.classList.remove("hidden");
      box.textContent = "Sending test notification...";
      try {
        const res = await api("/api/push/test", { method: "POST" });
        const summary = formatPushResults(res.results || {});
        const anyOk = Object.values(res.results || {}).some((r) => r && r.status === "ok");
        box.classList.add(anyOk ? "ok" : "err");
        box.textContent = summary;
      } catch (err) {
        box.classList.add("err");
        box.textContent = "Test failed: " + err.message;
      }
    });

    $("btn-webpush-sub").addEventListener("click", subscribeWebPush);
    $("btn-webpush-unsub").addEventListener("click", unsubscribeWebPush);

    ["btn-loc-home", "btn-loc-dest", "btn-loc-clear"].forEach((id) => {
      $(id).addEventListener("click", async () => {
        const zone = $(id).dataset.zone;
        const tok = state.settings?.location_state?.webhook_token || "";
        try {
          await api("/api/location/webhook", {
            method: "POST",
            body: JSON.stringify({ token: tok, zone, ttl_min: 120 }),
          });
          state.settings = await api("/api/settings");
          renderSettings();
          refreshLive();
          showToast(zone === "clear" ? "Location override cleared" : "Location override activated");
        } catch (err) {
          showToast(err.message, "err");
        }
      });
    });

    $("btn-save-profile").addEventListener("click", async () => {
      const display_name = $("profile-name-input").value.trim() || "Commuter";
      try {
        const res = await api("/api/me", { method: "PUT", body: JSON.stringify({ display_name }) });
        state.me = { ...state.me, user: res.user };
        loadSystemTab();
        showToast("Display name saved");
      } catch (err) {
        showToast(err.message, "err");
      }
    });

    $("btn-gen-link-code").addEventListener("click", async () => {
      try {
        const res = await api("/api/session/link-code", { method: "POST" });
        const box = $("link-code-display");
        box.className = "status-box ok";
        box.classList.remove("hidden");
        box.innerHTML = `Pairing Code: <code>${escapeHtml(res.code)}</code> (expires at ${fmtTime(res.expires_at)}). Enter this code on your other device.`;
      } catch (err) {
        showToast(err.message, "err");
      }
    });

    $("btn-claim-link-code").addEventListener("click", async () => {
      const code = $("claim-code-input").value.trim().toUpperCase();
      if (!code) {
        showToast("Enter a pairing code first", "err");
        return;
      }
      try {
        const res = await api("/api/session/claim-link", {
          method: "POST",
          body: JSON.stringify({ code }),
        });
        state.me = { user: res.user, session_count: 1 };
        state.settings = res.settings;
        $("claim-code-input").value = "";
        $("link-code-display").classList.add("hidden");
        renderSettings();
        await refreshLive();
        loadSystemTab();
        showToast("Device linked to profile");
      } catch (err) {
        showToast("Link failed: " + err.message, "err");
      }
    });

    $("btn-reset-profile").addEventListener("click", async () => {
      const confirmed = await openConfirm({
        title: "Reset Profile?",
        body: "This creates a brand-new empty profile on this browser and disconnects your saved route, rules, and push notifications here.",
        okLabel: "Reset Profile",
      });
      if (!confirmed) return;
      try {
        const res = await api("/api/session/reset", { method: "POST" });
        state.me = { user: res.user, session_count: 1 };
        state.settings = res.settings;
        $("link-code-display").classList.add("hidden");
        renderSettings();
        await refreshLive();
        loadSystemTab();
        showToast("New profile created");
      } catch (err) {
        showToast(err.message, "err");
      }
    });

    $("events-filter").addEventListener("change", loadAnalyticsAndEvents);

    try {
      const [catalog, settings, me] = await Promise.all([
        api("/api/catalog"),
        api("/api/settings"),
        api("/api/me"),
      ]);
      state.catalog = catalog;
      state.settings = settings;
      state.me = me;
      renderSettings();
    } catch (err) {
      showToast("Failed to load configuration: " + err.message, "err");
    }

    await refreshLive();
    connectSSE();
    setInterval(tickBoardCountdowns, 15000);
  }

  init();
})();
