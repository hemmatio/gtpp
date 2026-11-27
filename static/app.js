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
    predLoaded: false,
    analyticsLoaded: false,
    eventsLoaded: false,
    systemLoaded: false,
    eventsPage: 1,
    eventsTotalPages: 1,
    eventsReqSeq: 0,
  };

  const EVENTS_PAGE_SIZE = 20;
  const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  function predictorSkeletonHtml() {
    const row = `<div class="cand-row"><b><span class="skel" style="width:56px">&nbsp;</span></b><div class="cand-bar"><div class="skel skel-bar"></div></div><span><span class="skel" style="width:56px">&nbsp;</span></span></div>`;
    return `
      <div class="pred-hero">
        <div>
          <div class="endpoint-label">Most likely track</div>
          <div class="pred-plat-big"><span class="skel skel-lg" style="width:144px">&nbsp;</span></div>
        </div>
        <span class="pill muted skel" style="width:118px">&nbsp;</span>
      </div>
      <div class="hint mt-8 mb-0"><span class="skel" style="width:210px">&nbsp;</span></div>
      <div class="pred-cands">${row}${row}${row}</div>
    `;
  }

  function eventsSkeletonHtml(count = 6) {
    const widths = [
      [154, 210, 168],
      [142, 196, 160],
      [166, 220, 176],
      [148, 204, 164],
      [158, 212, 170],
      [144, 190, 158],
    ];
    return Array.from({ length: count }, (_, idx) => {
      const [w1, w2, w3] = widths[idx % widths.length];
      return `<div class="event-row"><div class="event-head"><span class="skel" style="width:${w1}px">&nbsp;</span><span class="pill muted skel" style="width:54px">&nbsp;</span></div><div><span class="skel" style="width:${w2}px">&nbsp;</span></div><div class="event-meta"><span class="skel" style="width:${w3}px">&nbsp;</span></div></div>`;
    }).join("");
  }

  function renderBoardSkeleton() {
    $("route-card").setAttribute("aria-busy", "true");
    const codeEl = $("board-line-code");
    codeEl.className = "line-badge skel";
    codeEl.setAttribute("aria-hidden", "true");
    codeEl.innerHTML = "&nbsp;";
    $("board-line-name").innerHTML = `<span class="skel" style="width:104px">&nbsp;</span>`;
    const badgeEl = $("alert-armed-badge");
    badgeEl.className = "pill muted skel";
    badgeEl.style.width = "122px";
    badgeEl.innerHTML = "&nbsp;";
    $("board-from-name").innerHTML = `<span class="skel" style="width:120px">&nbsp;</span>`;
    $("board-to-name").innerHTML = `<span class="skel" style="width:120px">&nbsp;</span>`;

    const rowWidths = [116, 108, 120, 104];
    const depRows = rowWidths
      .map(
        (w) => `<div class="dep-row"><div class="dep-trigger"><div class="dep-main"><div class="dep-times"><span class="dep-sched"><span class="skel" style="width:52px">&nbsp;</span></span><span class="dep-countdown"><span class="skel" style="width:44px">&nbsp;</span></span></div><div class="dep-right"><div class="plat-badge skel">&nbsp;</div><span class="ico sm" aria-hidden="true"></span></div></div><div class="dep-sub"><span class="pill muted skel" style="width:66px">&nbsp;</span><span class="train-num"><span class="skel" style="width:${w}px">&nbsp;</span></span></div></div></div>`
      )
      .join("");
    const listEl = $("departures-list");
    listEl.setAttribute("aria-busy", "true");
    listEl.innerHTML = `
      <div class="hero-dep skel-card">
        <div class="dep-trigger">
          <div class="hero-top">
            <div>
              <div class="hero-kicker"><span class="skel" style="width:88px">&nbsp;</span></div>
              <div class="hero-countdown"><span class="skel skel-lg" style="width:116px">&nbsp;</span></div>
            </div>
            <div class="dep-right">
              <div class="plat-badge skel">&nbsp;</div>
              <span class="ico sm" aria-hidden="true"></span>
            </div>
          </div>
          <div class="hero-sub">
            <span class="hero-time"><span class="skel" style="width:48px">&nbsp;</span></span>
            <span class="pill muted skel" style="width:66px">&nbsp;</span>
            <span class="train-num"><span class="skel" style="width:110px">&nbsp;</span></span>
          </div>
        </div>
      </div>
      <div class="dep-group skel-card">
        <div class="dep-group-head"><span class="skel" style="width:68px">&nbsp;</span></div>
        ${depRows}
      </div>
      <div class="earlier-details skel-card">
        <div class="earlier-summary"><span class="skel" style="width:112px">&nbsp;</span><span class="ico sm" aria-hidden="true"></span></div>
      </div>
    `;
  }

  function showBoardOfflineFallback() {
    $("route-card").removeAttribute("aria-busy");
    const codeEl = $("board-line-code");
    codeEl.className = "line-badge";
    codeEl.removeAttribute("aria-hidden");
    codeEl.textContent = "GO";
    $("board-line-name").textContent = "Offline";
    const badgeEl = $("alert-armed-badge");
    badgeEl.style.width = "";
    badgeEl.className = "pill muted";
    badgeEl.textContent = "Unavailable";
    $("board-from-name").textContent = "--";
    $("board-to-name").textContent = "--";
    const listEl = $("departures-list");
    listEl.removeAttribute("aria-busy");
    listEl.innerHTML = `<div class="empty-state">Unable to load live departures. Check connection and tap Retry.</div>`;
  }

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
      if (state.live) {
        label.textContent = "Connecting...";
      }
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
    const routeCard = $("route-card");
    routeCard.removeAttribute("aria-busy");
    routeCard.style.setProperty("--line-color", lineColor);
    const codeEl = $("board-line-code");
    codeEl.className = "line-badge";
    codeEl.removeAttribute("aria-hidden");
    codeEl.textContent = lineCode;
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
    armedBadge.style.width = "";
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
      listEl.removeAttribute("aria-busy");
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

    listEl.removeAttribute("aria-busy");
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
      const stopWidths = [102, 128, 92, 118, 96, 134, 88];
      const stopSkels = stopWidths
        .map(
          (w) => `
          <div class="stop-row">
            <span class="skel" style="width:${w}px">&nbsp;</span>
            <span class="skel" style="width:44px">&nbsp;</span>
            <span class="train-num skel" style="width:40px">&nbsp;</span>
          </div>`
        )
        .join("");
      return `
        <div class="dep-detail" aria-busy="true">
          ${predLine}
          <div class="hint mb-8"><span class="skel" style="width:142px">&nbsp;</span></div>
          ${stopSkels}
        </div>
      `;
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
    const rulesEl = $("rules-list");
    rulesEl.removeAttribute("aria-busy");
    rulesEl.innerHTML = rules.length
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
    const reqSeq = (state.predReqSeq = (state.predReqSeq || 0) + 1);
    if (state.predLoaded) {
      const prevH = box.offsetHeight;
      if (prevH > 0) box.style.minHeight = `${prevH}px`;
      box.setAttribute("aria-busy", "true");
      box.innerHTML = predictorSkeletonHtml();
    }
    try {
      const res = await api(`/api/predict/platform?${qs.toString()}`);
      if (reqSeq !== state.predReqSeq) return;
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
      if (reqSeq !== state.predReqSeq) return;
      box.innerHTML = `<span class="hint mb-0">Prediction unavailable: ${escapeHtml(err.message)}</span>`;
    } finally {
      if (reqSeq === state.predReqSeq) {
        state.predLoaded = true;
        box.removeAttribute("aria-busy");
        box.style.minHeight = "";
      }
    }
  }

  async function loadAnalytics() {
    try {
      const ana = await api("/api/analytics?days=30");
      const k = ana.kpis || {};
      const sampleCount = k.outcome_sample_count ?? k.total_outcomes ?? 0;
      const sampleNote =
        ana.data_source === "snapshots_fallback"
          ? " (snapshot preview)"
          : sampleCount > 0 && sampleCount < 10
          ? " (early sample)"
          : "";
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
                (r) => {
                  const u = r.mean_underestimation_min;
                  const uCls = u != null && u >= 5 ? "text-danger" : u != null && u >= 2 ? "text-warn" : "";
                  const p = r.phantom_ontime_pct;
                  const pCls = p != null && p >= 40 ? "text-danger" : p != null && p >= 20 ? "text-warn" : "";
                  return `
              <tr>
                <td><b>${escapeHtml(r.bucket)}</b></td>
                <td>${r.sample_count}</td>
                <td>${r.mean_abs_error_min != null ? Number(r.mean_abs_error_min).toFixed(1) + "m" : "--"}</td>
                <td class="${uCls}">${u != null ? (u > 0 ? "+" : "") + Number(u).toFixed(1) + "m" : "--"}</td>
                <td class="${pCls}">${p != null ? p + "%" : "--"}</td>
              </tr>`;
                }
              )
              .join("")}
          </tbody>
        </table>
      `;
      ["kpi-grid", "hourly-wrap", "drift-table-wrap"].forEach((id) => $(id)?.removeAttribute("aria-busy"));
      state.analyticsLoaded = true;
    } catch (err) {
      ["kpi-grid", "hourly-wrap", "drift-table-wrap"].forEach((id) => $(id)?.removeAttribute("aria-busy"));
      if (!state.analyticsLoaded) {
        $("kpi-context").textContent = "Last 30 days";
        $("hourly-wrap").innerHTML = `<p class="hint mb-0">Unable to load hourly trends.</p>`;
        $("drift-table-wrap").innerHTML = `<p class="hint mb-0">Unable to load estimate accuracy.</p>`;
      }
      $("kpi-grid").innerHTML = `<div class="empty-state">Unable to load analytics: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderEventsPagination({ page, totalPages, total, offset, count, hasMore }) {
    const nav = $("events-pagination");
    if (!nav) return;
    if (!total || total <= 0) {
      nav.classList.add("hidden");
      $("events-page-select").innerHTML = "";
      $("events-page-summary").textContent = "";
      return;
    }
    nav.classList.remove("hidden");
    const select = $("events-page-select");
    select.innerHTML = Array.from(
      { length: totalPages },
      (_, idx) => `<option value="${idx + 1}">Page ${idx + 1} of ${totalPages}</option>`
    ).join("");
    select.value = String(page);
    select.disabled = totalPages <= 1;

    const startIdx = count > 0 ? offset + 1 : 0;
    const endIdx = offset + count;
    $("events-page-summary").textContent = count > 0 ? `${startIdx}–${endIdx} of ${total}` : `${total} total`;
    $("btn-events-prev").disabled = page <= 1;
    $("btn-events-next").disabled = page >= totalPages || !hasMore;
  }

  async function loadEvents({ resetPage = false, scrollTop = false, showSkeleton = false, _clamped = false } = {}) {
    if (resetPage) state.eventsPage = 1;
    const page = Math.max(1, state.eventsPage || 1);
    const offset = (page - 1) * EVENTS_PAGE_SIZE;
    const evFilter = $("events-filter").value;
    const evParams = new URLSearchParams({
      limit: String(EVENTS_PAGE_SIZE),
      offset: String(offset),
    });
    if (evFilter === "__global__") {
      evParams.set("scope", "global");
    } else if (evFilter) {
      evParams.set("type", evFilter);
    }

    const listEl = $("events-list");
    if (showSkeleton) {
      listEl.setAttribute("aria-busy", "true");
      listEl.innerHTML = eventsSkeletonHtml(6);
      if (scrollTop) listEl.scrollTop = 0;
      if ($("btn-events-prev")) $("btn-events-prev").disabled = true;
      if ($("btn-events-next")) $("btn-events-next").disabled = true;
      if ($("events-page-select")) $("events-page-select").disabled = true;
    }

    const reqSeq = ++state.eventsReqSeq;
    try {
      const evResp = await api(`/api/events?${evParams.toString()}`);
      if (reqSeq !== state.eventsReqSeq) return;

      const events = evResp.events || [];
      const total = Number(evResp.total ?? events.length);
      const totalPages = Math.max(1, Math.ceil(total / EVENTS_PAGE_SIZE));
      if (page > totalPages && total > 0 && !_clamped) {
        state.eventsPage = totalPages;
        return loadEvents({ scrollTop, showSkeleton: false, _clamped: true });
      }
      state.eventsPage = page;
      state.eventsTotalPages = totalPages;
      state.eventsLoaded = true;

      const isGlobalScope = evResp.scope === "global" || $("events-filter").value === "__global__";
      const myUserId = state.me?.user?.id && state.me.user.id !== "guest" ? state.me.user.id : null;
      listEl.removeAttribute("aria-busy");
      listEl.innerHTML = events.length
        ? events
            .map((ev) => {
              const isOwn = Boolean(myUserId && ev.user_id === myUserId);
              const isNet = ev.user_id === "__global__" || (isGlobalScope && !isOwn);
              const pillCls = isNet ? "info" : ev.notified ? "" : "muted";
              const pillLabel = isNet ? "Network" : ev.notified ? "Sent" : "Logged";
              const lineName = ev.corridor ? corridorDisplayName(ev.corridor) : "";
              const metaParts = [
                fmtTime(ev.created_at),
                lineName,
                ev.event_type,
                !isNet && ev.rule_matched ? ev.rule_matched : "",
              ].filter(Boolean);
              return `
            <div class="event-row">
              <div class="event-head">
                <span>${escapeHtml(ev.title)}</span>
                <span class="pill ${pillCls}">${pillLabel}</span>
              </div>
              <div>${escapeHtml(ev.body)}</div>
              <div class="event-meta">${metaParts.map(escapeHtml).join(" &middot; ")}</div>
            </div>`;
            })
            .join("")
        : `<div class="hint mb-0" style="padding:12px;">${
            isGlobalScope
              ? "No global network events recorded yet — platform, boarding, and delay changes across all GO lines appear here live."
              : "No events recorded for your profile yet."
          }</div>`;

      if (scrollTop) {
        listEl.scrollTop = 0;
      }
      renderEventsPagination({
        page,
        totalPages,
        total,
        offset,
        count: events.length,
        hasMore: Boolean(evResp.has_more ?? offset + events.length < total),
      });
    } catch (err) {
      if (reqSeq !== state.eventsReqSeq) return;
      listEl.removeAttribute("aria-busy");
      listEl.innerHTML = `<div class="empty-state">Unable to load events: ${escapeHtml(err.message)}</div>`;
      renderEventsPagination({ page: 1, totalPages: 1, total: 0, offset: 0, count: 0, hasMore: false });
    }
  }

  function loadAnalyticsAndEvents() {
    return Promise.all([loadAnalytics(), loadEvents()]);
  }

  async function loadSystemTab() {
    const setupUrlEl = $("pwa-setup-url");
    if (setupUrlEl) setupUrlEl.textContent = window.location.origin;

    try {
      const [h, me] = await Promise.all([api("/api/health"), api("/api/me")]);
      state.me = me;
      const u = me.user || {};
      $("profile-name-input").value = u.display_name || "Commuter";
      $("profile-stats").removeAttribute("aria-busy");
      $("profile-stats").innerHTML = `
        <div class="stat-row"><span>Paired Browsers</span><b>${me.session_count ?? 1}</b></div>
        <div class="stat-row"><span>Push Subscriptions</span><b>${me.counts?.push_subs_count ?? 0}</b></div>
        <div class="stat-row"><span>Alerts Sent (Profile)</span><b>${me.counts?.notified_count ?? 0}</b></div>
      `;

      const obs = h.snapshot_observations ?? h.snapshots_count ?? 0;
      const savedPct = obs > 0 ? Math.max(0, Math.round(100 * (1 - h.snapshots_count / obs))) : 0;
      $("system-stats").removeAttribute("aria-busy");
      $("system-stats").innerHTML = `
        <div class="stat-row"><span>Poller Status</span><b>${h.poll_ok ? "Healthy" : "Error: " + escapeHtml(h.last_error || "unknown")}</b></div>
        <div class="stat-row"><span>Last Poll</span><b>${h.last_poll_at ? fmtRelative(h.last_poll_at) : "never"} (${h.last_poll_ms}ms)</b></div>
        <div class="stat-row"><span>Live Departures Cached</span><b>${h.trips_live}</b></div>
        <div class="stat-row"><span>Snapshots Stored</span><b>${h.snapshots_count} (${obs} polls, ${savedPct}% saved)</b></div>
        <div class="stat-row"><span>Outcomes Stored</span><b>${h.outcomes_count}</b></div>
        <div class="stat-row"><span>Database Size</span><b>${h.db_size_kb != null ? h.db_size_kb + " KB" : "--"}</b></div>
      `;

      const standalone =
        window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
      const swSupported = "serviceWorker" in navigator;
      const notifSupported = "Notification" in window;
      $("ios-checklist").removeAttribute("aria-busy");
      $("ios-checklist").innerHTML = `
        <li>${window.isSecureContext ? svgIcon("circle-check", "sm ico-ok") : svgIcon("triangle-alert", "sm ico-warn")} <span>HTTPS Connection: <b>${window.isSecureContext ? "Yes" : "No (required for iOS Push)"}</b></span></li>
        <li>${standalone ? svgIcon("circle-check", "sm ico-ok") : svgIcon("info", "sm ico-info")} <span>Home Screen App: <b>${standalone ? "Installed" : "Running in browser tab"}</b></span></li>
        <li>${swSupported ? svgIcon("circle-check", "sm ico-ok") : svgIcon("circle-x", "sm ico-err")} <span>Service Worker: <b>${swSupported ? "Supported" : "Unavailable"}</b></span></li>
        <li>${notifSupported ? svgIcon("circle-check", "sm ico-ok") : svgIcon("info", "sm ico-info")} <span>Web Push API: <b>${notifSupported ? "Ready" : "Requires Home Screen app on iOS"}</b></span></li>
      `;
      state.systemLoaded = true;
    } catch (err) {
      ["profile-stats", "system-stats", "ios-checklist"].forEach((id) => $(id)?.removeAttribute("aria-busy"));
      if (!state.systemLoaded) {
        $("profile-stats").innerHTML = `<div class="hint mb-0">Profile stats unavailable.</div>`;
        $("ios-checklist").innerHTML = `<li class="hint mb-0">Setup checks unavailable.</li>`;
      }
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
      if (!state.live) {
        showBoardOfflineFallback();
      }
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

  const ANALYTICS_HELP = {
    predictor: {
      title: "Union Platform Predictor",
      intro: "Estimates the most likely Union Station boarding track using up to 90 days of recorded departures and today's timetable.",
      items: [
        ["Most Likely Track", "Predicted platform weighted toward exact matches of this train number, falling back to nearby departures on the same GO line or today's scheduled track."],
        ["Confidence Tier", "High (>=70%), Moderate (40-69%), or Early estimate (<40%), combining historical consistency, sample count, and scheduled-track agreement."],
        ["Platform Distribution Bars", "Top candidate tracks historically assigned to this train or time window (shown as X of Y observed runs)."],
        ["Closest Train Snap", "When searching by 24h time, automatically matches the nearest Union departure on your selected GO line and station."],
      ],
    },
    kpis: {
      title: "Service Reliability",
      intro: "Summary metrics across tracked GO departures in the last 30 days.",
      items: [
        ["On-Time (<3m)", "Percentage of tracked departures that left less than 3 minutes (180s) after their scheduled departure time."],
        ["Average Delay & Worst", "Mean lateness across completed trips, with the sub-label showing the single longest delay recorded."],
        ["Union Track Lead", "Average minutes before scheduled departure that Union Station first announces a gate/track, plus how often it matched the scheduled track."],
        ["Short Trains", "Percentage of observed trips running with fewer coaches than scheduled (for example, 10 cars instead of 12)."],
        ["Delays >=15m", "Count of tracked departures delayed 15 minutes or more (GO Transit's Service Guarantee threshold)."],
        ["Snapshot Preview / Early Sample", "Shown when fewer than 10 completed trip outcomes are logged yet or while falling back to latest live snapshots."],
      ],
    },
    hourly: {
      title: "Delays by Hour",
      intro: "Groups tracked departures by scheduled departure hour to spotlight rush-hour congestion.",
      items: [
        ["Bar Length & Thresholds", "Bar widths scale relative to the worst hour (minimum 5m scale). Green = <3m avg, Amber = >=3m, Red = >=7m."],
        ["Avg (trips)", "Mean departure delay in minutes for that hour, followed by the sample count in parentheses."],
      ],
    },
    drift: {
      title: "Departure Estimate Accuracy",
      intro: "Measures how accurate GO Transit's live delay predictions are before trains actually depart.",
      items: [
        ["Before Dep (T-30m to T-5m)", "Snapshot capture windows prior to scheduled departure: T-30m (25-35m), T-15m (12-18m), T-10m (8-12m), and T-5m (3-7m)."],
        ["Trips", "Completed trips that had both a snapshot inside that time window and a recorded actual departure outcome."],
        ["Avg Error", "Mean Absolute Error (|actual - predicted|) in minutes regardless of direction; lower means more accurate feed estimates."],
        ["Under-Est", "Signed average (actual delay minus predicted delay). Positive +Xm means GO under-reported lateness until closer to departure."],
        ["Surprise Late", "Percentage of trips still shown as On Time (<3m late) during that window that ended up leaving 5 or more minutes late."],
      ],
    },
    events: {
      title: "Recent Events",
      intro: "View alerts from your personal commute route or watch live updates across the entire GO Rail network.",
      items: [
        ["All Events (Commute Route)", "Filtered to your active user profile's saved commute route and alert rules."],
        ["All Events (Global Scope)", "Live deduplicated feed across all 7 GO Rail lines and Union platforms (platform assignments, boarding calls, delays, cancellations, and short trains)."],
        ["Sent / Logged / Network", "Sent = alert dispatched by your rule; Logged = route state change recorded while alerts were disarmed; Network = system-wide event outside your saved route."],
        ["Event Types", "Tracks platform announcements, platform switches, boarding ('Proceed'), delay starts/increases, cancellations, short trains, and geofence triggers."],
      ],
    },
  };

  function setupAnalyticsHelp() {
    const modal = $("ana-help-modal");
    const titleEl = $("ana-help-title");
    const introEl = $("ana-help-intro");
    const listEl = $("ana-help-list");
    const toggleAllBtn = $("ana-help-all");
    if (!modal || !titleEl || !introEl || !listEl || !toggleAllBtn) return;

    let currentSection = "kpis";
    let showingAll = false;

    const renderModal = () => {
      if (showingAll) {
        titleEl.textContent = "All Analytics Metrics";
        introEl.textContent = "Reference guide for every calculation shown on the Analytics tab.";
        listEl.innerHTML = Object.values(ANALYTICS_HELP)
          .map(
            (sec) =>
              `<div class="help-group-label">${escapeHtml(sec.title)}</div>` +
              sec.items
                .map(
                  ([term, desc]) =>
                    `<div class="guide-step"><div class="guide-step-head"><span class="guide-step-title">${escapeHtml(term)}</span></div><p>${escapeHtml(desc)}</p></div>`
                )
                .join("")
          )
          .join("");
        toggleAllBtn.textContent = "Back to Section";
      } else {
        const sec = ANALYTICS_HELP[currentSection] || ANALYTICS_HELP.kpis;
        titleEl.textContent = sec.title;
        introEl.textContent = sec.intro;
        listEl.innerHTML = sec.items
          .map(
            ([term, desc]) =>
              `<div class="guide-step"><div class="guide-step-head"><span class="guide-step-title">${escapeHtml(term)}</span></div><p>${escapeHtml(desc)}</p></div>`
          )
          .join("");
        toggleAllBtn.textContent = "All Sections";
      }
      listEl.scrollTop = 0;
    };

    const openHelp = (sectionKey) => {
      currentSection = sectionKey && ANALYTICS_HELP[sectionKey] ? sectionKey : "kpis";
      showingAll = false;
      renderModal();
      modal.classList.remove("hidden");
    };

    const closeHelp = () => modal.classList.add("hidden");

    document.querySelectorAll("[data-ana-help]").forEach((btn) => {
      btn.addEventListener("click", () => openHelp(btn.dataset.anaHelp));
    });
    toggleAllBtn.addEventListener("click", () => {
      showingAll = !showingAll;
      renderModal();
    });
    $("ana-help-close").addEventListener("click", closeHelp);
    $("ana-help-done").addEventListener("click", closeHelp);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeHelp();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.classList.contains("hidden")) {
        closeHelp();
      }
    });
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

  async function forceReloadApp() {
    const btn = $("btn-force-reload");
    const ico = btn?.querySelector("svg");
    if (btn) btn.disabled = true;
    ico?.classList.add("spinning");
    try {
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      if ("serviceWorker" in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) {
          await reg.update().catch(() => {});
          if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
        }
      }
    } catch (_) {}
    window.location.reload();
  }

  async function init() {
    if ("serviceWorker" in navigator) {
      const hadController = Boolean(navigator.serviceWorker.controller);
      let swReloading = false;
      let lastSwCheck = Date.now();
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!hadController || swReloading) return;
        swReloading = true;
        window.location.reload();
      });
      navigator.serviceWorker
        .register("/sw.js", { updateViaCache: "none" })
        .then((reg) => {
          reg.update().catch(() => {});
          document.addEventListener("visibilitychange", () => {
            if (document.visibilityState !== "visible") return;
            const now = Date.now();
            if (now - lastSwCheck < 30000) return;
            lastSwCheck = now;
            reg.update().catch(() => {});
          });
        })
        .catch(() => {});
    }

    setupHelpGuide();
    setupAnalyticsHelp();

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
      if (!state.live) {
        renderBoardSkeleton();
      }
      try {
        state.live = await api("/api/poll", { method: "POST" });
        state.fetchError = null;
        renderBoard();
        if (state.tab === "system") loadSystemTab();
      } catch (err) {
        state.fetchError = err.message || "Refresh failed";
        if (!state.live) {
          showBoardOfflineFallback();
        }
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
    $("btn-force-reload")?.addEventListener("click", forceReloadApp);

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
        state.eventsPage = 1;
        state.analyticsLoaded = false;
        state.eventsLoaded = false;
        state.predLoaded = false;
        state.predictorInited = false;
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

    $("btn-remove-other-devices").addEventListener("click", async () => {
      const confirmed = await openConfirm({
        title: "Remove Other Devices?",
        body: "Disconnects any other paired browsers and removes other/dangling push subscriptions on this profile. Your current device stays signed in and keeps its active notifications.",
        okLabel: "Remove Others",
      });
      if (!confirmed) return;
      try {
        let keepEndpoint = null;
        if ("serviceWorker" in navigator && "PushManager" in window) {
          try {
            const reg = await navigator.serviceWorker.getRegistration();
            const sub = reg ? await reg.pushManager.getSubscription() : null;
            if (sub?.endpoint) keepEndpoint = sub.endpoint;
          } catch (_) {}
        }
        const res = await api("/api/session/remove-other-devices", {
          method: "POST",
          body: JSON.stringify({ keep_endpoint: keepEndpoint }),
        });
        state.me = { ...state.me, session_count: res.session_count, counts: res.counts };
        loadSystemTab();
        updateWebPushUI();
        const sRm = res.sessions_removed || 0;
        const pRm = res.push_subs_removed || 0;
        if (sRm === 0 && pRm === 0) {
          showToast("No other devices found on this profile", "info");
        } else {
          showToast(`Removed ${sRm} session${sRm === 1 ? "" : "s"} and ${pRm} push sub${pRm === 1 ? "" : "s"}`);
        }
      } catch (err) {
        showToast("Failed to remove devices: " + err.message, "err");
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
        state.eventsPage = 1;
        state.analyticsLoaded = false;
        state.eventsLoaded = false;
        state.predLoaded = false;
        state.predictorInited = false;
        state.systemLoaded = false;
        $("link-code-display").classList.add("hidden");
        renderSettings();
        await refreshLive();
        loadSystemTab();
        showToast("New profile created");
      } catch (err) {
        showToast(err.message, "err");
      }
    });

    $("events-filter").addEventListener("change", () => loadEvents({ resetPage: true, scrollTop: true, showSkeleton: true }));
    $("btn-events-prev").addEventListener("click", () => {
      if (state.eventsPage > 1) {
        state.eventsPage -= 1;
        loadEvents({ scrollTop: true, showSkeleton: true });
      }
    });
    $("btn-events-next").addEventListener("click", () => {
      if (state.eventsPage < state.eventsTotalPages) {
        state.eventsPage += 1;
        loadEvents({ scrollTop: true, showSkeleton: true });
      }
    });
    $("events-page-select").addEventListener("change", (e) => {
      state.eventsPage = Math.max(1, Number(e.target.value) || 1);
      loadEvents({ scrollTop: true, showSkeleton: true });
    });

    try {
      const [catalog, me] = await Promise.all([api("/api/catalog"), api("/api/me")]);
      const settings = await api("/api/settings");
      state.catalog = catalog;
      state.me = me;
      state.settings = settings;
      renderSettings();
    } catch (err) {
      $("rules-list").removeAttribute("aria-busy");
      if (!state.settings) {
        $("rules-list").innerHTML = `<div class="hint mb-0" style="padding:12px;">Unable to load alert rules.</div>`;
        updateWebPushUI();
      }
      showToast("Failed to load configuration: " + err.message, "err");
    }

    await refreshLive();
    connectSSE();
    setInterval(tickBoardCountdowns, 15000);
  }

  init();
})();
