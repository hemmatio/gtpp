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
    sse: null,
    predictorInited: false,
  };

  const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  const METRIC_DEFS = {
    snapshots: {
      group: "Overview KPIs",
      title: "Snapshots Logged",
      body: "Stored snapshot state intervals. Unchanged consecutive polls are automatically merged into a single [captured_at, last_seen_at] interval with a sample count to save disk space without losing any timeline resolution.",
    },
    outcomes: {
      group: "Overview KPIs",
      title: "Ground-Truth Outcomes",
      body: "Number of completed train stops where GOTracker++ captured actual departure/arrival times and actual track numbers from trip telemetry.",
    },
    avg_delay: {
      group: "Overview KPIs",
      title: "Average Delay",
      body: "Mean lateness in minutes across logged runs (actual or latest departure time minus scheduled departure time).",
    },
    on_time: {
      group: "Overview KPIs",
      title: "On-Time Rate (<3m)",
      body: "Percentage of tracked runs that departed less than 3 minutes (180 seconds) after their scheduled departure time (GO's minor-delay threshold).",
    },
    platform_lead: {
      group: "Overview KPIs",
      title: "Avg Platform Lead Time",
      body: "Average number of minutes before scheduled departure that a train's boarding platform first switches from '-' to an announced track number.",
    },
    short_train: {
      group: "Overview KPIs",
      title: "Short-Train Rate",
      body: "Percentage of observed trips running with fewer coaches than scheduled (for example, 10 cars instead of 12).",
    },
    service_guarantee: {
      group: "Overview KPIs",
      title: "Service Guarantee (>=15m)",
      body: "Count of tracked trips delayed by 15 minutes or more, which generally qualify for GO Transit's Service Guarantee fare refund.",
    },
    notifications: {
      group: "Overview KPIs",
      title: "Your Notifications",
      body: "Total alert notifications dispatched to your active profile's channels (Web Push, ntfy, or custom webhook).",
    },
    lead_time: {
      group: "Misleading Estimations (Prediction Drift)",
      title: "Lead Time Buckets (T-Nm)",
      body: "How many minutes before scheduled departure the live GOTracker estimate was recorded: T-30m (25-35m prior), T-15m (12-18m prior), T-10m (8-12m prior), and T-5m (3-7m prior).",
    },
    samples: {
      group: "Misleading Estimations (Prediction Drift)",
      title: "Samples",
      body: "Number of completed trips that had both a snapshot captured inside this T-Nm window and a verified ground-truth actual outcome.",
    },
    mae: {
      group: "Misleading Estimations (Prediction Drift)",
      title: "MAE (Mean Absolute Error)",
      body: "Average absolute difference in minutes between what GOTracker predicted at T-Nm and the actual departure delay. Lower MAE means more accurate estimates.",
    },
    under_est: {
      group: "Misleading Estimations (Prediction Drift)",
      title: "Under-Est (Underestimation Bias)",
      body: "Average (Actual Delay minus Predicted Delay) in minutes. Positive values (e.g. +4.2m) mean GOTracker systematically under-reported delays until closer to departure.",
    },
    phantom_ontime: {
      group: "Misleading Estimations (Prediction Drift)",
      title: "Phantom On-Time %",
      body: "Percentage of trips that GOTracker still showed as On Time (<3m late) at T-Nm, yet ended up departing 5 or more minutes late.",
    },
    common_plat: {
      group: "Platform Patterns & Predictor",
      title: "Common Plat (Most Common Platform)",
      body: "The boarding track most frequently assigned to this train number across logged service days.",
    },
    consistency: {
      group: "Platform Patterns & Predictor",
      title: "Consistency %",
      body: "Percentage of logged runs where this train departed from its most common platform, followed by total runs with an announced platform in parentheses.",
    },
    sched_trk: {
      group: "Platform Patterns & Predictor",
      title: "Sched Trk (Scheduled Track)",
      body: "Internal planned track from GO's daily trip schedule (/Schedule/Today/Trip). Often visible before Union's public departure board posts a platform, though subject to operational swaps.",
    },
    confidence: {
      group: "Platform Patterns & Predictor",
      title: "Prediction Confidence %",
      body: "Sample-size-adjusted confidence for the predicted platform. Combines historical platform consistency with Bayesian shrinkage (so 1/1 day isn't falsely 100%), plus a +8% boost if it matches today's internal scheduled track.",
    },
    runs: {
      group: "Worst Delays & Misses",
      title: "Runs",
      body: "Total number of service days tracked for this train number in the selected lookback window.",
    },
    max_delay: {
      group: "Worst Delays & Misses",
      title: "Max Delay",
      body: "Worst single recorded departure delay in minutes for this train number.",
    },
    worst_miss: {
      group: "Worst Delays & Misses",
      title: "Worst Miss",
      body: "Largest gap in minutes where actual delay exceeded GOTracker's earlier live prediction for this train.",
    },
  };

  function $(id) {
    return document.getElementById(id);
  }

  function svgIcon(name, cls = "") {
    const px = cls.split(/\s+/).includes("sm") ? 14 : 16;
    const base = window.__GTPP_ICONS_URL || "/static/icons.svg";
    return `<svg class="ico ${cls}" width="${px}" height="${px}" aria-hidden="true"><use href="${base}#ico-${name}"></use></svg>`;
  }

  function tipBtn(key) {
    const def = METRIC_DEFS[key];
    const label = def ? def.title : key;
    return `<button type="button" class="tip-btn" data-tip="${key}" aria-label="Explain ${escapeHtml(label)}">${svgIcon("circle-help", "sm")}</button>`;
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts,
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(txt || `HTTP ${res.status}`);
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
    const scroller = document.querySelector(".main-content");
    if (scroller) scroller.scrollTop = 0;
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

  function renderBoard() {
    const live = state.live;
    if (!live) return;

    const dot = $("sse-dot");
    const poller = live.poller || {};
    dot.className = "brand-dot " + (poller.last_poll_ok ? "live" : "err");
    $("freshness-label").textContent = poller.last_poll_at
      ? `Updated ${fmtRelative(poller.last_poll_at)} (${poller.last_poll_ms || 0}ms)`
      : "Polling...";

    const homeName = live.home_meta?.name || live.route.home_station;
    const destName = live.dest_meta?.name || live.route.dest_station;
    const isH2D = state.direction === "home_to_dest";
    $("board-from-name").textContent = isH2D ? homeName : destName;
    $("board-to-name").textContent = isH2D ? destName : homeName;
    $("btn-swap-dir").classList.toggle("flipped", !isH2D);

    const elig = (live.eligibility || {})[state.direction] || {};
    const armedBadge = $("alert-armed-badge");
    if (elig.active) {
      armedBadge.className = "pill";
      armedBadge.innerHTML = `${svgIcon("bell-ring", "sm")}<span>Alerts Armed (${escapeHtml(elig.reason)})</span>`;
    } else {
      armedBadge.className = "pill muted";
      armedBadge.innerHTML = `${svgIcon("bell-off", "sm")}<span>Outside Alert Window</span>`;
    }

    const msgsByDir = live.station_messages_by_dir || {};
    const msgs = msgsByDir[state.direction] ?? live.station_messages ?? [];
    const advBox = $("advisories-box");
    if (msgs.length > 0) {
      advBox.classList.remove("hidden");
      $("advisories-count").textContent = String(msgs.length);
      $("advisories-list").innerHTML = msgs.map((m) => `<li>${escapeHtml(m)}</li>`).join("");
    } else {
      advBox.classList.add("hidden");
    }

    const nowMs = Date.now();
    const deps = (live.departures || []).filter((d) => d.direction === state.direction);
    const listEl = $("departures-list");

    if (!deps.length) {
      listEl.innerHTML = `<div class="empty-state">No upcoming trains found for this direction right now.</div>`;
      return;
    }

    const enrichDep = (d) => {
      const predMs = new Date(d.predicted_time || d.scheduled_time).getTime();
      const minsUntil = Math.round((predMs - nowMs) / 60000);
      const isPast = minsUntil < -3;
      const delayMin = Math.round((d.delay_sec || 0) / 60);
      const isDelayed = delayMin >= 3;

      let countdownTxt = "";
      if (minsUntil > 0 && minsUntil <= 180) countdownTxt = `in ${minsUntil}m`;
      else if (minsUntil === 0) countdownTxt = "NOW";
      else if (minsUntil < 0) countdownTxt = `${Math.abs(minsUntil)}m ago`;

      let platHtml = `<div class="plat-badge">Plat -</div>`;
      const pred = d.predicted_platform;
      if (d.platform && d.platform !== "-") {
        const proceedCls = (d.info_status || "").toLowerCase().includes("proceed") ? " proceed" : "";
        platHtml = `<div class="plat-badge assigned${proceedCls}">Plat ${escapeHtml(d.platform)}</div>`;
      } else if (pred && pred.platform) {
        platHtml = `
          <div class="plat-badge predicted" title="${escapeHtml(pred.source_label || "Predicted platform")}">
            <span class="plat-est-main">${svgIcon("sparkles", "sm")}<span>Est. ${escapeHtml(pred.platform)}</span></span>
            <span class="plat-est-sub">${pred.confidence_pct}% conf</span>
          </div>`;
      } else if (d.sch_track && d.sch_track !== "-") {
        platHtml = `<div class="plat-badge hint">Sched ${escapeHtml(d.sch_track)}</div>`;
      }

      let statusPill = `<span class="pill">On Time</span>`;
      if (d.is_cancelled) {
        statusPill = `<span class="pill danger">CANCELLED</span>`;
      } else if (isDelayed) {
        statusPill = `<span class="pill warn">+${delayMin}m Late</span>`;
      } else if ((d.info_status || "").toLowerCase().includes("proceed")) {
        statusPill = `<span class="pill">Proceed</span>`;
      }

      const coachBadge =
        d.coach_count != null
          ? d.scheduled_coach_count && d.coach_count < d.scheduled_coach_count
            ? `<span class="pill warn">${d.coach_count}/${d.scheduled_coach_count} cars</span>`
            : `<span class="pill muted">${d.coach_count} cars</span>`
          : "";

      const expressBadge = d.is_express ? `<span class="pill info">Express</span>` : "";
      const isExpanded = state.expandedTrip === d.trip_number;
      const detailHtml = isExpanded ? renderTripDetail(d) : "";

      return {
        d,
        isPast,
        isDelayed,
        countdownTxt,
        platHtml,
        statusPill,
        coachBadge,
        expressBadge,
        detailHtml,
      };
    };

    const enriched = deps.map(enrichDep);
    const firstUpcomingIdx = enriched.findIndex((item) => !item.isPast);
    const heroIdx = firstUpcomingIdx >= 0 ? firstUpcomingIdx : 0;
    const hero = enriched[heroIdx];
    const rest = enriched.filter((_, idx) => idx !== heroIdx);

    const heroHtml = `
      <div class="hero-dep ${hero.isPast ? "past" : ""}" data-trip="${escapeHtml(hero.d.trip_number)}">
        <div class="hero-top">
          <div>
            <div class="hero-kicker">Next train</div>
            <div class="hero-countdown">${hero.countdownTxt || fmtTime(hero.d.predicted_time || hero.d.scheduled_time)}</div>
          </div>
          <div class="dep-right">${hero.platHtml}</div>
        </div>
        <div class="hero-sub">
          <span class="hero-time ${hero.isDelayed ? "struck" : ""}">${fmtTime(hero.d.scheduled_time)}</span>
          ${hero.isDelayed ? `<span class="hero-pred">${fmtTime(hero.d.predicted_time)}</span>` : ""}
          <span>Train #${escapeHtml(hero.d.trip_number)}</span>
          ${hero.statusPill}
          ${hero.coachBadge}
          ${hero.expressBadge}
          ${hero.d.eligible_for_alerts ? `<span class="pill muted">${svgIcon("bell", "sm")}</span>` : ""}
        </div>
        ${hero.detailHtml}
      </div>
    `;

    const restRowsHtml = rest
      .map(
        ({ d, isPast, isDelayed, countdownTxt, platHtml, statusPill, coachBadge, expressBadge, detailHtml }) => `
          <div class="dep-row ${isPast ? "past" : ""}" data-trip="${escapeHtml(d.trip_number)}">
            <div class="dep-main">
              <div>
                <div class="dep-times">
                  <span class="dep-sched ${isDelayed ? "struck" : ""}">${fmtTime(d.scheduled_time)}</span>
                  ${isDelayed ? `<span class="dep-pred">${fmtTime(d.predicted_time)}</span>` : ""}
                  <span class="dep-countdown">${countdownTxt}</span>
                </div>
              </div>
              <div class="dep-right">${platHtml}</div>
            </div>
            <div class="dep-sub">
              <span>Train #${escapeHtml(d.trip_number)}</span>
              ${statusPill}
              ${coachBadge}
              ${expressBadge}
              ${d.eligible_for_alerts ? `<span class="pill muted">${svgIcon("bell", "sm")}</span>` : ""}
            </div>
            ${detailHtml}
          </div>
        `
      )
      .join("");

    const restHtml = rest.length
      ? `
        <div class="dep-group">
          <div class="dep-group-head">Upcoming</div>
          ${restRowsHtml}
        </div>
      `
      : "";

    listEl.innerHTML = heroHtml + restHtml;

    listEl.querySelectorAll("[data-trip]").forEach((card) => {
      card.addEventListener("click", () => toggleTripDetail(card.dataset.trip));
    });
  }

  function renderTripDetail(dep) {
    const tripNum = dep.trip_number;
    const det = state.tripDetails[tripNum];
    const pred = dep.predicted_platform;
    const predLine =
      pred && pred.platform
        ? `<div class="pill info" style="margin-bottom:8px;">${svgIcon("sparkles", "sm")}<span>Predicted Platform ${escapeHtml(pred.platform)} (${pred.confidence_pct}% conf) - ${escapeHtml(pred.source_label)}</span></div>`
        : "";

    if (!det) {
      return `<div class="dep-detail">${predLine}<span class="hint">Loading live stop timeline...</span></div>`;
    }
    if (det.error) {
      return `<div class="dep-detail">${predLine}<span class="hint">Timeline unavailable: ${escapeHtml(det.error)}</span></div>`;
    }
    const rows = (det.stops || [])
      .map((s) => {
        const ci = s.completeInfo;
        const act = ci ? ci.actDeparture || ci.actArrival || "" : "";
        const track = (ci && ci.actTrack) || s.schTrack || "-";
        const delayS = ci && ci.delaySecond ? Math.round(ci.delaySecond / 60) : 0;
        const timeTxt = act
          ? `${s.schArrival} to <b>${act}</b>${delayS >= 3 ? ` (+${delayS}m)` : ""}`
          : s.schArrival || s.schDeparture || "--:--";
        return `
          <div class="stop-row ${s.isStopping ? "" : "not-stopping"}">
            <span>${escapeHtml(s.name)}${s.isCancelled ? " (Cancelled)" : ""}</span>
            <span>${timeTxt}</span>
            <span class="muted">Trk ${escapeHtml(track)}</span>
          </div>
        `;
      })
      .join("");
    return `
      <div class="dep-detail">
        ${predLine}
        <div class="hint" style="margin-bottom:6px;">
          ${escapeHtml(det.tripName || "Trip " + tripNum)} ${det.engineId ? " | Loco #" + escapeHtml(det.engineId) : ""}
        </div>
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
        const c = corridors.find((x) => x.code === corrSel.value) || corridors[0];
        const stops = c ? c.stops : [];
        statSel.innerHTML = stops
          .map((s) => `<option value="${s.code}">${escapeHtml(s.name)} (${s.code})</option>`)
          .join("");
        if (pickCode && stops.some((s) => s.code === pickCode)) {
          statSel.value = pickCode;
        }
      }

      updateStations(selectedStat);
      corrSel.onchange = () => updateStations(null);
    }

    fillPair("sel-home-corr", "sel-home-stat", route.home_corridor, route.home_station);
    fillPair("sel-dest-corr", "sel-dest-stat", route.dest_corridor, route.dest_station);
  }

  function renderProfileBadges() {
    if (!state.me?.user) return;
    const u = state.me.user;
    $("alerts-profile-name").textContent = u.display_name || "Commuter";
    $("alerts-profile-id").textContent = `${u.id.slice(0, 12)} (${u.auth_provider})`;
  }

  function renderSettings() {
    const s = state.settings;
    if (!s) return;
    renderProfileBadges();
    populateStationSelects();

    const rules = s.rules || [];
    $("rules-list").innerHTML = rules.length
      ? rules
          .map((r) => {
            const daysTxt = (r.days || []).map((d) => DAY_LABELS[d]).join(", ");
            const dirTxt =
              r.direction === "home_to_dest"
                ? "Home to Dest"
                : r.direction === "dest_to_home"
                ? "Dest to Home"
                : "Both";
            return `
              <div class="rule-item">
                <div>
                  <div><b>${escapeHtml(r.name)}</b> ${r.enabled ? '<span class="pill">ON</span>' : '<span class="pill muted">OFF</span>'}</div>
                  <div class="hint" style="margin:2px 0 0;">${dirTxt} | ${r.start}-${r.end} | ${daysTxt}</div>
                </div>
                <div class="btn-row">
                  <button class="btn-small secondary" data-toggle-rule="${r.id}">${r.enabled ? "Pause" : "Enable"}</button>
                  <button class="btn-small secondary" data-del-rule="${r.id}" aria-label="Delete rule">${svgIcon("trash-2", "sm")}</button>
                </div>
              </div>
            `;
          })
          .join("")
      : `<div class="hint">No time rules configured yet.</div>`;

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
      statusEl.className = "pill";
      statusEl.textContent = `Active: ${loc.zone} (${loc.override_direction}) until ${fmtTime(loc.expires_at)}`;
    } else {
      statusEl.className = "pill muted";
      statusEl.textContent = "No active location override";
    }

    const origin = window.location.origin;
    const tok = encodeURIComponent(loc.webhook_token || "");
    const hooks = [
      { label: "Arrive Home", url: `${origin}/api/location/webhook?token=${tok}&zone=home&ttl_min=120` },
      { label: "Arrive Union/Dest", url: `${origin}/api/location/webhook?token=${tok}&zone=dest&ttl_min=120` },
      { label: "Clear Override", url: `${origin}/api/location/webhook?token=${tok}&zone=clear` },
    ];
    $("shortcut-urls").innerHTML = hooks
      .map(
        (h, i) => `
      <div class="copy-row">
        <div class="copy-row-text"><b>${h.label}:</b><br/><span>${escapeHtml(h.url)}</span></div>
        <button type="button" class="btn-copy" data-copy-idx="${i}" title="Copy URL">${svgIcon("copy", "sm")}</button>
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
          setTimeout(() => {
            btn.classList.remove("copied");
            btn.innerHTML = svgIcon("copy", "sm");
          }, 1500);
        } catch (_) {}
      });
    });

    updateWebPushUI();
  }

  async function toggleRule(id) {
    const rules = (state.settings.rules || []).map((r) =>
      r.id === id ? { ...r, enabled: !r.enabled } : r
    );
    state.settings = await api("/api/settings", { method: "PUT", body: JSON.stringify({ rules }) });
    renderSettings();
    refreshLive();
  }

  async function deleteRule(id) {
    const rules = (state.settings.rules || []).filter((r) => r.id !== id);
    state.settings = await api("/api/settings", { method: "PUT", body: JSON.stringify({ rules }) });
    renderSettings();
    refreshLive();
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
      msgEl.innerHTML = `${svgIcon("triangle-alert", "sm ico-warn")} Web Push requires <b>HTTPS</b> (currently on plain HTTP). Use <b>ntfy.sh</b> below right now.`;
      subBtn.disabled = true;
      return;
    }
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      msgEl.innerHTML = `${svgIcon("info", "sm ico-info")} On iPhone/iPad, tap <b>Share &rarr; Add to Home Screen</b> first, then open the installed icon to enable Web Push.`;
      subBtn.disabled = true;
      return;
    }

    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        msgEl.innerHTML = `${svgIcon("circle-check", "sm ico-ok")} Subscribed to Web Push on this device.`;
        subBtn.classList.add("hidden");
        unsubBtn.classList.remove("hidden");
      } else {
        msgEl.textContent = `Ready (Permission: ${Notification.permission}). Tap below to subscribe.`;
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
    } catch (err) {
      $("webpush-status-msg").textContent = "Subscribe failed: " + err.message;
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

    const now = new Date();
    $("pred-time").value = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    corrSel.addEventListener("change", () => {
      fillPredStations(null);
      loadPrediction({ time: $("pred-time").value });
    });
    statSel.addEventListener("change", () => loadPrediction({ time: $("pred-time").value }));
    $("pred-trip").addEventListener("change", () => {
      loadPrediction({ trip_number: $("pred-trip").value });
    });
    $("btn-pred-snap").addEventListener("click", () => {
      loadPrediction({ time: $("pred-time").value });
    });

    loadPrediction({ time: $("pred-time").value });
  }

  async function loadPrediction({ trip_number = "", time = "" } = {}) {
    const corr = $("pred-corridor").value;
    const stat = $("pred-station").value;
    if (!corr || !stat) return;

    const qs = new URLSearchParams({ corridor: corr, station: stat });
    if (trip_number) qs.set("trip_number", trip_number);
    else if (time) qs.set("time", time);

    const box = $("pred-result");
    box.innerHTML = `<span class="hint">Analyzing historical platform logs...</span>`;
    try {
      const res = await api(`/api/predict/platform?${qs.toString()}`);
      const trips = res.available_trips || [];
      const tripSel = $("pred-trip");
      tripSel.innerHTML = trips.length
        ? trips
            .map(
              (t) =>
                `<option value="${escapeHtml(t.number)}">${escapeHtml(t.dep_time)} - #${escapeHtml(t.number)} (${escapeHtml(t.destination)})</option>`
            )
            .join("")
        : `<option value="">No Union departures listed</option>`;

      if (res.matched_trip?.number) {
        tripSel.value = res.matched_trip.number;
      }

      const p = res.prediction || {};
      const snapNote =
        res.snapped_from_time && res.matched_trip && res.snap_diff_min != null && res.snap_diff_min > 0
          ? `<div class="pill info" style="margin-bottom:8px;">${svgIcon("clock", "sm")}<span>Snapped ${escapeHtml(res.snapped_from_time)} to ${escapeHtml(res.matched_trip.dep_time)} (#${escapeHtml(res.matched_trip.number)}, ${res.snap_diff_min}m diff)</span></div>`
          : "";

      const platLabel = p.platform ? `Platform ${escapeHtml(p.platform)}` : "No Data Yet";
      const candsHtml = (p.candidates || []).length
        ? `<div class="pred-cands">
            ${p.candidates
              .map(
                (c) => `
              <div class="cand-row">
                <b>Plat ${escapeHtml(c.platform)}</b>
                <div class="cand-bar"><div style="width:${Math.min(100, c.pct)}%"></div></div>
                <span>${c.pct}% (${c.count})</span>
              </div>`
              )
              .join("")}
          </div>`
        : "";

      const metaBits = [
        p.source_label || "",
        p.scheduled_track ? `Sched Trk ${p.scheduled_track}` : "",
        p.avg_lead_min != null ? `Avg Lead ${p.avg_lead_min}m` : "",
      ].filter(Boolean);

      box.innerHTML = `
        ${snapNote}
        <div class="pred-hero">
          <div>
            <div class="endpoint-label">Predicted track</div>
            <div class="pred-plat-big">${platLabel}</div>
          </div>
          <div class="pred-conf-wrap">
            <div class="pred-conf-num">${p.confidence_pct || 0}% conf</div>
            <div class="conf-bar-track"><div class="conf-bar-fill" style="width:${p.confidence_pct || 0}%"></div></div>
          </div>
        </div>
        <div class="hint" style="margin-top:8px; margin-bottom:0;">${escapeHtml(metaBits.join(" | "))}</div>
        ${candsHtml}
      `;
    } catch (err) {
      box.innerHTML = `<span class="hint">Prediction error: ${escapeHtml(err.message)}</span>`;
    }
  }

  async function loadAnalyticsAndEvents() {
    try {
      const [ana, evResp] = await Promise.all([
        api("/api/analytics?days=30"),
        api(`/api/events?limit=80&type=${encodeURIComponent($("events-filter").value)}`),
      ]);
      const k = ana.kpis || {};
      $("kpi-grid").innerHTML = `
        <div class="kpi-card"><div class="kpi-label"><span>Snapshots Logged</span>${tipBtn("snapshots")}</div><div class="kpi-val">${k.total_snapshots ?? 0}</div></div>
        <div class="kpi-card"><div class="kpi-label"><span>Ground-Truth Outcomes</span>${tipBtn("outcomes")}</div><div class="kpi-val">${k.total_outcomes ?? 0}</div></div>
        <div class="kpi-card"><div class="kpi-label"><span>Avg Delay</span>${tipBtn("avg_delay")}</div><div class="kpi-val">${k.avg_delay_min ?? 0}m</div></div>
        <div class="kpi-card"><div class="kpi-label"><span>On-Time (&lt;3m)</span>${tipBtn("on_time")}</div><div class="kpi-val">${k.on_time_pct ?? 100}%</div></div>
        <div class="kpi-card"><div class="kpi-label"><span>Avg Platform Lead</span>${tipBtn("platform_lead")}</div><div class="kpi-val">${k.avg_platform_lead_min != null ? k.avg_platform_lead_min + "m" : "--"}</div></div>
        <div class="kpi-card"><div class="kpi-label"><span>Short-Train Rate</span>${tipBtn("short_train")}</div><div class="kpi-val">${k.short_train_pct ?? 0}%</div></div>
        <div class="kpi-card"><div class="kpi-label"><span>Service Guarantee (&ge;15m)</span>${tipBtn("service_guarantee")}</div><div class="kpi-val">${k.service_guarantee_hits ?? 0}</div></div>
        <div class="kpi-card"><div class="kpi-label"><span>Your Notifications</span>${tipBtn("notifications")}</div><div class="kpi-val">${k.notifications_sent ?? 0}</div></div>
      `;

      const drift = ana.prediction_drift || [];
      $("drift-table-wrap").innerHTML = `
        <table class="data-table">
          <thead>
            <tr>
              <th><span class="th-tip">Lead Time ${tipBtn("lead_time")}</span></th>
              <th><span class="th-tip">Samples ${tipBtn("samples")}</span></th>
              <th><span class="th-tip">MAE ${tipBtn("mae")}</span></th>
              <th><span class="th-tip">Under-Est ${tipBtn("under_est")}</span></th>
              <th><span class="th-tip">Phantom On-Time ${tipBtn("phantom_ontime")}</span></th>
            </tr>
          </thead>
          <tbody>
            ${drift
              .map(
                (r) => `
              <tr>
                <td><b>${r.bucket}</b></td>
                <td>${r.sample_count}</td>
                <td>${r.mean_abs_error_min != null ? r.mean_abs_error_min + "m" : "--"}</td>
                <td>${r.mean_underestimation_min != null ? (r.mean_underestimation_min > 0 ? "+" : "") + r.mean_underestimation_min + "m" : "--"}</td>
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
                <th><span class="th-tip">Common Plat ${tipBtn("common_plat")}</span></th>
                <th><span class="th-tip">Consistency ${tipBtn("consistency")}</span></th>
                <th><span class="th-tip">Avg Lead ${tipBtn("platform_lead")}</span></th>
                <th><span class="th-tip">Sched Trk ${tipBtn("sched_trk")}</span></th>
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
        : `<p class="hint">Platform history accumulates automatically as trains run.</p>`;

      const offs = ana.top_offenders || [];
      $("offenders-table-wrap").innerHTML = offs.length
        ? `<table class="data-table">
            <thead>
              <tr>
                <th>Train</th>
                <th><span class="th-tip">Runs ${tipBtn("runs")}</span></th>
                <th><span class="th-tip">Avg Delay ${tipBtn("avg_delay")}</span></th>
                <th><span class="th-tip">Max ${tipBtn("max_delay")}</span></th>
                <th><span class="th-tip">Worst Miss ${tipBtn("worst_miss")}</span></th>
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
        : `<p class="hint">Delay offender rankings will populate as snapshots &amp; outcomes are logged.</p>`;

      const events = evResp.events || [];
      $("events-list").innerHTML = events.length
        ? events
            .map(
              (ev) => `
            <div class="event-row">
              <div class="event-head">
                <span>${escapeHtml(ev.title)}</span>
                <span class="pill ${ev.notified ? "" : "muted"}">${ev.notified ? "Notified" : "Logged"}</span>
              </div>
              <div>${escapeHtml(ev.body)}</div>
              <div class="event-meta">${fmtTime(ev.created_at)} | ${escapeHtml(ev.event_type)}${ev.rule_matched ? " | " + escapeHtml(ev.rule_matched) : ""}</div>
            </div>`
            )
            .join("")
        : `<p class="hint">No events recorded for your profile yet.</p>`;
    } catch (err) {
      $("kpi-grid").innerHTML = `<div class="empty-state">Error loading analytics: ${escapeHtml(err.message)}</div>`;
    }
  }

  // ---- Tooltip & Metrics Guide Controller ----
  function setupTooltips() {
    const floatEl = $("tooltip-float");
    const isDesktopHover = window.matchMedia("(hover: hover) and (pointer: fine)");

    function showFloat(btn) {
      const def = METRIC_DEFS[btn.dataset.tip];
      if (!def) return;
      $("tooltip-float-title").textContent = def.title;
      $("tooltip-float-body").textContent = def.body;
      floatEl.classList.remove("hidden");

      const rect = btn.getBoundingClientRect();
      const fw = floatEl.offsetWidth || 260;
      const fh = floatEl.offsetHeight || 90;
      let left = rect.left + rect.width / 2 - fw / 2;
      left = Math.max(10, Math.min(window.innerWidth - fw - 10, left));
      let top = rect.top - fh - 8;
      if (top < 10) top = rect.bottom + 8;
      floatEl.style.left = `${left}px`;
      floatEl.style.top = `${top}px`;
    }

    function hideFloat() {
      floatEl.classList.add("hidden");
    }

    function openTipModal(key) {
      const def = METRIC_DEFS[key];
      if (!def) return;
      hideFloat();
      $("tip-modal-title").textContent = def.title;
      $("tip-modal-body").textContent = def.body;
      $("tip-modal").classList.remove("hidden");
    }

    document.addEventListener("mouseover", (e) => {
      if (!isDesktopHover.matches) return;
      const btn = e.target.closest(".tip-btn");
      if (btn) showFloat(btn);
    });
    document.addEventListener("mouseout", (e) => {
      if (e.target.closest(".tip-btn")) hideFloat();
    });
    document.addEventListener("click", (e) => {
      const btn = e.target.closest(".tip-btn");
      if (btn) {
        e.stopPropagation();
        openTipModal(btn.dataset.tip);
      }
    });

    $("tip-modal-close").addEventListener("click", () => $("tip-modal").classList.add("hidden"));
    $("tip-modal").addEventListener("click", (e) => {
      if (e.target === $("tip-modal")) $("tip-modal").classList.add("hidden");
    });

    $("btn-open-glossary").addEventListener("click", () => {
      const groups = {};
      Object.values(METRIC_DEFS).forEach((d) => {
        groups[d.group] = groups[d.group] || [];
        groups[d.group].push(d);
      });
      $("glossary-content").innerHTML = Object.entries(groups)
        .map(
          ([gName, items]) => `
          <div class="glossary-group-title">${escapeHtml(gName)}</div>
          ${items
            .map(
              (it) => `<div class="glossary-item"><b>${escapeHtml(it.title)}</b><p>${escapeHtml(it.body)}</p></div>`
            )
            .join("")}`
        )
        .join("");
      $("glossary-modal").classList.remove("hidden");
    });

    $("glossary-close").addEventListener("click", () => $("glossary-modal").classList.add("hidden"));
    $("glossary-modal").addEventListener("click", (e) => {
      if (e.target === $("glossary-modal")) $("glossary-modal").classList.add("hidden");
    });
  }

  // ---- Interactive Spotlight Coachmark Tour ----
  const TUTORIAL_STORAGE_KEY = "gtpp_tutorial_seen_v1";

  function setupTutorial() {
    let stepIdx = 0;
    let isOpen = false;
    let rafPending = false;

    function buildSteps() {
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent || "") || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

      let pushHtml = "";
      if (isStandalone) {
        pushHtml = `
          <div class="tut-callout ok">
            ${svgIcon("circle-check", "sm ico-ok")}
            <span><b>Already Installed!</b> Tap <b>Enable Web Push</b> right above, then tap <b>Send Test</b>.</span>
          </div>`;
      } else if (isIOS) {
        pushHtml = `
          <div class="tut-callout">
            ${svgIcon("info", "sm ico-info")}
            <span>On iPhone, open this URL in <b>Safari</b> &rarr; tap <b>Share</b> ${svgIcon("share", "sm")} &rarr; <b>Add to Home Screen</b>, then open the installed icon and tap <b>Enable Web Push</b> above.</span>
          </div>`;
      } else {
        pushHtml = `
          <div class="tut-callout">
            ${svgIcon("info", "sm ico-info")}
            <span>Tap <b>Enable Web Push</b> above (or add to Home Screen from iOS Safari for iPhone lock-screen alerts), then tap <b>Send Test</b>.</span>
          </div>`;
      }

      return [
        {
          tab: "board",
          selector: ".route-card",
          icon: "train-front",
          title: "Live Route & Direction",
          lead: "Try swapping direction or detecting your station",
          html: `
            <ul class="tut-list">
              <li><span class="tut-num">1</span><span>Tap ${svgIcon("arrow-left-right", "sm")} inside this highlighted card anytime to switch directions.</span></li>
              <li><span class="tut-num">2</span><span>Tap <b>Locate</b> in the top bar to auto-pick the direction closest to your phone GPS.</span></li>
            </ul>`,
        },
        {
          tab: "board",
          selector: "#departures-list",
          icon: "sparkles",
          title: "Departures & Platform Estimates",
          lead: "Auto-updated every 20-45s in the background",
          html: `
            <ul class="tut-list">
              <li><span class="tut-num">1</span><span>Dashed <b>Est.</b> badges predict Union boarding platforms + confidence % before official tracks post.</span></li>
              <li><span class="tut-num">2</span><span>Tap any train card to expand live stop-by-stop actuals, scheduled tracks, and locomotive IDs.</span></li>
            </ul>`,
        },
        {
          tab: "alerts",
          selector: "#card-route",
          icon: "map-pin",
          title: "Choose Your Commute Route",
          lead: "Saved privately to your browser cookie profile",
          html: `
            <ul class="tut-list">
              <li><span class="tut-num">1</span><span>Pick your <b>Home Line &amp; Station</b> and <b>Destination Line &amp; Station</b> above, then tap <b>Save Route</b>.</span></li>
              <li><span class="tut-num">2</span><span>Need the same profile on Safari + Home Screen or Laptop? Pair them in <b>System &rarr; Link Another Device</b>.</span></li>
            </ul>`,
        },
        {
          tab: "alerts",
          selector: "#card-rules",
          icon: "bell-ring",
          title: "Set Your Alert Schedule",
          lead: "Control exact hours and directions for alerts",
          html: `
            <ul class="tut-list">
              <li><span class="tut-num">1</span><span>Edit existing weekday rules or tap <b>+ Add Rule</b> to choose active days, start/end hours, and direction.</span></li>
              <li><span class="tut-num">2</span><span>Alerts only fire for matching windows (delays, platform announcements/changes, boarding, short trains).</span></li>
            </ul>`,
        },
        {
          tab: "alerts",
          selector: "#card-notifications",
          icon: "smartphone",
          title: "Add to Home Screen & Push",
          lead: isStandalone ? "Installed PWA ready for Web Push" : (isIOS ? "iPhone Web Push setup" : "Enable browser push alerts"),
          html: pushHtml,
        },
        {
          tab: "analytics",
          selector: "#predictor-card",
          icon: "chart-column",
          title: "Platform Predictor & Analytics",
          lead: "Forecast tracks and audit misleading estimates",
          html: `
            <ul class="tut-list">
              <li><span class="tut-num">1</span><span>Pick a Union departure (or snap any time) above to predict its boarding platform from historical logs.</span></li>
              <li><span class="tut-num">2</span><span>Scroll down for <b>Misleading Estimations</b>, and tap any ${svgIcon("circle-help", "sm")} icon or <b>Metrics Guide</b> for explanations.</span></li>
            </ul>`,
        },
      ];
    }

    function markSeen() {
      try {
        localStorage.setItem(TUTORIAL_STORAGE_KEY, "1");
      } catch (_) {}
    }

    function positionSpotlight() {
      if (!isOpen) return;
      const steps = buildSteps();
      const st = steps[stepIdx];
      const target = st ? document.querySelector(st.selector) : null;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const card = $("tour-card");
      const ring = $("tour-ring");
      const mTop = $("tour-mask-top");
      const mBot = $("tour-mask-bottom");
      const mLeft = $("tour-mask-left");
      const mRight = $("tour-mask-right");

      if (!target) {
        mTop.style.cssText = "top:0;left:0;width:100vw;height:100vh;";
        mBot.style.cssText = "width:0;height:0;";
        mLeft.style.cssText = "width:0;height:0;";
        mRight.style.cssText = "width:0;height:0;";
        ring.classList.add("hidden");
        card.style.top = `${Math.max(16, Math.round((vh - card.offsetHeight) / 2))}px`;
        return;
      }

      ring.classList.remove("hidden");
      const r = target.getBoundingClientRect();
      const topBar = document.querySelector(".top-bar");
      const minTop = topBar ? Math.round(topBar.getBoundingClientRect().bottom) : 0;
      const pad = 8;
      const top = Math.max(minTop, Math.round(r.top - pad));
      const left = Math.max(0, Math.round(r.left - pad));
      const right = Math.min(vw, Math.round(r.right + pad));
      // Cap cutout height so tall sections still leave room for the docked coachmark card
      const maxBot = Math.min(vh - 12, Math.round(top + Math.max(140, vh * 0.46)));
      const bottom = Math.max(top + 40, Math.min(vh, Math.round(r.bottom + pad), maxBot));
      const w = Math.max(0, right - left);
      const h = Math.max(0, bottom - top);

      mTop.style.cssText = `top:0px;left:0px;width:${vw}px;height:${top}px;`;
      mBot.style.cssText = `top:${bottom}px;left:0px;width:${vw}px;height:${Math.max(0, vh - bottom)}px;`;
      mLeft.style.cssText = `top:${top}px;left:0px;width:${left}px;height:${h}px;`;
      mRight.style.cssText = `top:${top}px;left:${right}px;width:${Math.max(0, vw - right)}px;height:${h}px;`;

      ring.style.top = `${top}px`;
      ring.style.left = `${left}px`;
      ring.style.width = `${w}px`;
      ring.style.height = `${h}px`;

      const cardH = card.offsetHeight || 220;
      let cardTop;
      if (vh - bottom >= cardH + 14) {
        cardTop = bottom + 12;
      } else if (top >= cardH + 14) {
        cardTop = top - cardH - 12;
      } else {
        cardTop = Math.max(12, vh - cardH - 12);
      }
      card.style.top = `${Math.round(cardTop)}px`;
    }

    function schedulePosition() {
      if (!isOpen || rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        positionSpotlight();
      });
    }

    function renderStep(shouldScroll = true) {
      const steps = buildSteps();
      const total = steps.length;
      if (stepIdx < 0) stepIdx = 0;
      if (stepIdx >= total) stepIdx = total - 1;
      const st = steps[stepIdx];

      if (state.tab !== st.tab) {
        switchTab(st.tab);
      }

      $("tut-step-label").textContent = `Step ${stepIdx + 1} of ${total}`;
      $("tut-dots").innerHTML = steps
        .map(
          (_, i) =>
            `<button type="button" class="tut-dot ${i === stepIdx ? "active" : i < stepIdx ? "done" : ""}" data-tut-idx="${i}" aria-label="Go to step ${i + 1}"></button>`
        )
        .join("");
      $("tut-dots")
        .querySelectorAll(".tut-dot")
        .forEach((dot) => {
          dot.addEventListener("click", () => {
            stepIdx = Number(dot.dataset.tutIdx);
            renderStep(true);
          });
        });

      $("tut-body").innerHTML = `
        <div class="tut-hero">
          <div class="tut-hero-icon">${svgIcon(st.icon)}</div>
          <div>
            <h3 class="tut-title">${escapeHtml(st.title)}</h3>
            <p class="tut-lead">${escapeHtml(st.lead)}</p>
          </div>
        </div>
        ${st.html}
      `;

      $("tut-prev").disabled = stepIdx === 0;
      const isLast = stepIdx === total - 1;
      $("tut-cta").classList.toggle("hidden", !isLast);
      $("tut-next").innerHTML = isLast
        ? `<span>Done</span>${svgIcon("check", "sm")}`
        : `<span>Next</span>${svgIcon("arrow-right", "sm")}`;

      if (shouldScroll) {
        const target = document.querySelector(st.selector);
        const scroller = document.querySelector(".main-content");
        if (target && scroller) {
          const topBarH = document.querySelector(".top-bar")?.offsetHeight || 74;
          const delta = target.getBoundingClientRect().top - topBarH - 14;
          scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + delta), behavior: "instant" });
        }
      }
      const overlay = $("tour-overlay");
      overlay.classList.add("tour-animating");
      clearTimeout(overlay._animTimer);
      overlay._animTimer = setTimeout(() => overlay.classList.remove("tour-animating"), 240);
      requestAnimationFrame(() => positionSpotlight());
    }

    function openTutorial(startAt = 0) {
      stepIdx = startAt;
      isOpen = true;
      $("tour-overlay").classList.remove("hidden");
      renderStep(true);
    }

    function closeTutorial() {
      isOpen = false;
      markSeen();
      $("tour-overlay").classList.add("hidden");
    }

    $("tut-prev").addEventListener("click", () => {
      if (stepIdx > 0) {
        stepIdx -= 1;
        renderStep(true);
      }
    });
    $("tut-next").addEventListener("click", () => {
      const total = buildSteps().length;
      if (stepIdx < total - 1) {
        stepIdx += 1;
        renderStep(true);
      } else {
        closeTutorial();
      }
    });
    $("tut-cta").addEventListener("click", () => {
      closeTutorial();
      switchTab("alerts");
    });
    $("tut-close").addEventListener("click", closeTutorial);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isOpen) {
        closeTutorial();
      }
    });
    window.addEventListener("resize", schedulePosition);
    const onTourScroll = () => {
      if (!isOpen) return;
      $("tour-overlay").classList.remove("tour-animating");
      positionSpotlight();
    };
    document.querySelector(".main-content")?.addEventListener("scroll", onTourScroll, { passive: true });
    window.addEventListener("scroll", onTourScroll, { passive: true });

    $("btn-open-tutorial").addEventListener("click", () => openTutorial(0));
    $("btn-replay-tutorial").addEventListener("click", () => openTutorial(0));

    return {
      maybeAutoOpen() {
        try {
          if (!localStorage.getItem(TUTORIAL_STORAGE_KEY)) {
            openTutorial(0);
          }
        } catch (_) {}
      },
    };
  }

  async function loadSystemTab() {
    try {
      const [h, me] = await Promise.all([api("/api/health"), api("/api/me")]);
      state.me = me;
      renderProfileBadges();
      const u = me.user || {};
      $("profile-name-input").value = u.display_name || "Commuter";
      $("profile-stats").innerHTML = `
        <div class="stat-row"><span>Profile ID</span><code>${escapeHtml(u.id || "")}</code></div>
        <div class="stat-row"><span>Auth Mode</span><b>${escapeHtml(u.auth_provider || "anonymous")} (Cookie)</b></div>
        <div class="stat-row"><span>Linked Devices</span><b>${me.session_count ?? 1}</b></div>
        <div class="stat-row"><span>Your Web Push Devices</span><b>${me.counts?.push_subs_count ?? 0}</b></div>
      `;

      const obs = h.snapshot_observations ?? h.snapshots_count ?? 0;
      const savedPct = obs > 0 ? Math.max(0, Math.round(100 * (1 - h.snapshots_count / obs))) : 0;
      $("system-stats").innerHTML = `
        <div class="stat-row"><span>Status</span><b>${escapeHtml(h.status)}</b></div>
        <div class="stat-row"><span>Last Poll</span><b>${h.last_poll_at ? fmtRelative(h.last_poll_at) : "never"} (${h.last_poll_ms}ms)</b></div>
        <div class="stat-row"><span>Upstream Poll OK</span><b>${h.poll_ok ? "Yes" : "Error: " + escapeHtml(h.last_error || "unknown")}</b></div>
        <div class="stat-row"><span>Active Profiles</span><b>${h.users_count ?? 1}</b></div>
        <div class="stat-row"><span>Live Departures Cached</span><b>${h.trips_live}</b></div>
        <div class="stat-row"><span>Snapshots (Coalesced)</span><b>${h.snapshots_count} intervals (${obs} polls, ${savedPct}% saved)</b></div>
        <div class="stat-row"><span>Outcomes Stored</span><b>${h.outcomes_count}</b></div>
        <div class="stat-row"><span>Database Size</span><b>${h.db_size_kb != null ? h.db_size_kb + " KB" : "--"}</b></div>
      `;

      const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
      const swSupported = "serviceWorker" in navigator;
      const notifSupported = "Notification" in window;
      $("ios-checklist").innerHTML = `
        <li>${window.isSecureContext ? svgIcon("circle-check", "sm ico-ok") : svgIcon("triangle-alert", "sm ico-warn")} <span>Secure Context (HTTPS): <b>${window.isSecureContext ? "Yes" : "No (HTTP)"}</b></span></li>
        <li>${standalone ? svgIcon("circle-check", "sm ico-ok") : svgIcon("info", "sm ico-info")} <span>Installed to Home Screen: <b>${standalone ? "Yes" : "No (browser tab)"}</b></span></li>
        <li>${swSupported ? svgIcon("circle-check", "sm ico-ok") : svgIcon("circle-x", "sm ico-err")} <span>Service Worker Support: <b>${swSupported ? "Yes" : "No"}</b></span></li>
        <li>${notifSupported ? svgIcon("circle-check", "sm ico-ok") : svgIcon("info", "sm ico-info")} <span>Web Push API Exposed: <b>${notifSupported ? "Yes" : "Requires HTTPS + Home Screen on iOS"}</b></span></li>
      `;
    } catch (err) {
      $("system-stats").textContent = "Error: " + err.message;
    }
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function refreshLive() {
    try {
      const live = await api("/api/live");
      state.live = live;
      autoChooseDirection(live);
      renderBoard();
    } catch (_) {
      $("freshness-label").textContent = "Offline / retrying...";
    }
  }

  function connectSSE() {
    if (state.sse) state.sse.close();
    const es = new EventSource("/api/stream");
    es.addEventListener("update", () => refreshLive());
    es.onerror = () => {
      $("sse-dot").className = "brand-dot err";
    };
    state.sse = es;
  }

  async function handleLocate() {
    if (!navigator.geolocation) {
      alert("Geolocation is unavailable in this browser.");
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
            : `${svgIcon("map-pin", "sm")}<span>GPS updated</span>`;
          renderBoard();
        } catch (err) {
          alert("Location lookup failed: " + err.message);
        } finally {
          btn.disabled = false;
          btn.querySelector("span").textContent = "Locate";
        }
      },
      (err) => {
        btn.disabled = false;
        btn.querySelector("span").textContent = "Locate";
        alert("GPS permission denied or unavailable: " + err.message);
      },
      { enableHighAccuracy: false, timeout: 8000 }
    );
  }

  async function init() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    setupTooltips();
    const tutorial = setupTutorial();

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
      $("freshness-label").textContent = "Polling now...";
      state.live = await api("/api/poll", { method: "POST" });
      renderBoard();
      if (state.tab === "system") loadSystemTab();
    };
    $("btn-poll-top").addEventListener("click", doPoll);
    $("btn-poll-sys").addEventListener("click", doPoll);
    $("btn-compact-db").addEventListener("click", async () => {
      const box = $("compact-result");
      box.classList.remove("hidden");
      box.textContent = "Compacting and pruning snapshots...";
      try {
        const res = await api("/api/system/compact", { method: "POST" });
        box.textContent = `Done: ${res.rows_before} -> ${res.rows_after} rows (merged ${res.merged_count}, pruned ${res.pruned_old_count} old, DB ${res.db_size_kb} KB).`;
        loadSystemTab();
      } catch (err) {
        box.textContent = "Compaction failed: " + err.message;
      }
    });

    $("btn-toggle-advisories").addEventListener("click", () => {
      $("advisories-list").classList.toggle("hidden");
    });

    $("btn-save-route").addEventListener("click", async () => {
      const route = {
        home_corridor: $("sel-home-corr").value,
        home_station: $("sel-home-stat").value,
        dest_corridor: $("sel-dest-corr").value,
        dest_station: $("sel-dest-stat").value,
      };
      state.settings = await api("/api/settings", { method: "PUT", body: JSON.stringify({ route }) });
      await doPoll();
      renderSettings();
      switchTab("board");
    });

    $("btn-add-rule").addEventListener("click", () => {
      $("rule-form").classList.remove("hidden");
      $("rule-edit-id").value = "";
      $("rule-name").value = "";
    });
    $("btn-cancel-rule").addEventListener("click", () => $("rule-form").classList.add("hidden"));
    $("rule-days-picker").querySelectorAll(".day-btn").forEach((b) => {
      b.addEventListener("click", () => b.classList.toggle("active"));
    });

    $("rule-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const days = [...$("rule-days-picker").querySelectorAll(".day-btn.active")].map((b) =>
        Number(b.dataset.day)
      );
      const newRule = {
        id: $("rule-edit-id").value || "rule-" + Date.now(),
        name: $("rule-name").value.trim() || "Commute Rule",
        enabled: true,
        direction: $("rule-dir").value,
        start: $("rule-start").value,
        end: $("rule-end").value,
        days: days.length ? days : [0, 1, 2, 3, 4],
      };
      const rules = [...(state.settings.rules || []), newRule];
      state.settings = await api("/api/settings", { method: "PUT", body: JSON.stringify({ rules }) });
      $("rule-form").classList.add("hidden");
      renderSettings();
      refreshLive();
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
      state.settings = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ alert_prefs }),
      });
      renderSettings();
      refreshLive();
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
      state.settings = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ channels }),
      });
      renderSettings();
    });

    $("btn-test-push").addEventListener("click", async () => {
      const box = $("push-test-result");
      box.classList.remove("hidden");
      box.textContent = "Sending test notification...";
      try {
        const res = await api("/api/push/test", { method: "POST" });
        box.textContent = JSON.stringify(res.results, null, 2);
      } catch (err) {
        box.textContent = "Test failed: " + err.message;
      }
    });

    $("btn-webpush-sub").addEventListener("click", subscribeWebPush);
    $("btn-webpush-unsub").addEventListener("click", unsubscribeWebPush);

    ["btn-loc-home", "btn-loc-dest", "btn-loc-clear"].forEach((id) => {
      $(id).addEventListener("click", async () => {
        const zone = $(id).dataset.zone;
        const tok = state.settings?.location_state?.webhook_token || "";
        await api("/api/location/webhook", {
          method: "POST",
          body: JSON.stringify({ token: tok, zone, ttl_min: 120 }),
        });
        state.settings = await api("/api/settings");
        renderSettings();
        refreshLive();
      });
    });

    $("btn-save-profile").addEventListener("click", async () => {
      const display_name = $("profile-name-input").value.trim() || "Commuter";
      const res = await api("/api/me", { method: "PUT", body: JSON.stringify({ display_name }) });
      state.me = { ...state.me, user: res.user };
      renderProfileBadges();
      loadSystemTab();
    });

    $("btn-gen-link-code").addEventListener("click", async () => {
      const res = await api("/api/session/link-code", { method: "POST" });
      const box = $("link-code-display");
      box.classList.remove("hidden");
      box.innerHTML = `Pairing Code: <b>${escapeHtml(res.code)}</b> (expires at ${fmtTime(res.expires_at)}). Enter this code on your other device to share this profile.`;
    });

    $("btn-claim-link-code").addEventListener("click", async () => {
      const code = $("claim-code-input").value.trim().toUpperCase();
      if (!code) return;
      try {
        const res = await api("/api/session/claim-link", {
          method: "POST",
          body: JSON.stringify({ code }),
        });
        state.me = { user: res.user, session_count: 1 };
        state.settings = res.settings;
        $("claim-code-input").value = "";
        renderSettings();
        await doPoll();
        loadSystemTab();
      } catch (err) {
        alert("Link failed: " + err.message);
      }
    });

    $("btn-reset-profile").addEventListener("click", async () => {
      if (!confirm("Start a brand-new empty cookie profile on this browser?")) return;
      const res = await api("/api/session/reset", { method: "POST" });
      state.me = { user: res.user, session_count: 1 };
      state.settings = res.settings;
      renderSettings();
      await doPoll();
      loadSystemTab();
    });

    $("events-filter").addEventListener("change", loadAnalyticsAndEvents);

    const [catalog, settings, me] = await Promise.all([
      api("/api/catalog"),
      api("/api/settings"),
      api("/api/me"),
    ]);
    state.catalog = catalog;
    state.settings = settings;
    state.me = me;
    renderSettings();
    await refreshLive();
    tutorial.maybeAutoOpen();
    connectSSE();
    setInterval(() => {
      if (state.live && state.tab === "board") renderBoard();
    }, 30000);
  }

  init();
})();
