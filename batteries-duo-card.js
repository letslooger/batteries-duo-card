/*
 * batteries-duo-card.js — Carte Home Assistant pour 2 batteries (ou plus) JK-BMS
 * À placer dans /config/www/batteries-duo-card.js
 * Ressource : /local/batteries-duo-card.js (type : module JavaScript)
 *
 * Exemple :
 *   type: custom:batteries-duo-card
 *   title: Mes batteries
 *   nominal_voltage: 51.2
 *   reserve_soc: 20
 *   batteries:
 *     - name: Batterie 1
 *       prefix: esp32_batterie_1_
 *     - name: Batterie 2
 *       prefix: esp32_batterie_1_b2_
 */

class BatteriesDuoCard extends HTMLElement {
  setConfig(config) {
    if (!config || !Array.isArray(config.batteries) || !config.batteries.length) {
      throw new Error("Indique au moins une batterie dans « batteries »");
    }
    this._config = Object.assign(
      {
        title: "Mes batteries",
        nominal_voltage: 51.2,
        reserve_soc: 20,
        full_soc: 99,
        cells: 16,
        history_days: 14,
        rated_cycles: 6000,
      },
      config
    );
    this._stats = null;
    this._statsAt = 0;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
  }

  set hass(hass) {
    this._hass = hass;
    const now = Date.now();
    if (!this._statsAt || now - this._statsAt > 10 * 60 * 1000) {
      this._statsAt = now;
      this._loadStats();
    }
    if (this._pending) return;
    const wait = Math.max(0, 1500 - (now - (this._lastRender || 0)));
    this._pending = setTimeout(() => {
      this._pending = null;
      this._lastRender = Date.now();
      this._render();
    }, wait);
  }

  getCardSize() {
    return 12;
  }

  static getStubConfig() {
    return {
      batteries: [
        { name: "Batterie 1", prefix: "esp32_batterie_1_" },
        { name: "Batterie 2", prefix: "esp32_batterie_1_b2_" },
      ],
    };
  }

  /* ---------- données ---------- */

  _st(id) {
    return this._hass && this._hass.states[id];
  }
  _num(id) {
    const s = this._st(id);
    if (!s) return NaN;
    return parseFloat(s.state);
  }
  _on(id) {
    const s = this._st(id);
    return s ? s.state === "on" : null;
  }

  _battery(b, i) {
    const p = b.prefix;
    const n = (x) => this._num("sensor." + p + x);
    const cells = [];
    for (let k = 1; k <= this._config.cells; k++) cells.push(n("cell_voltage_" + k));
    const valid = cells.filter((v) => !isNaN(v) && v > 0);
    const cmin = valid.length ? Math.min(...valid) : NaN;
    const cmax = valid.length ? Math.max(...valid) : NaN;
    const avg = valid.length ? valid.reduce((a, v) => a + v, 0) / valid.length : NaN;
    return {
      idx: i,
      name: b.name || "Batterie " + (i + 1),
      soc: n("state_of_charge"),
      rem: n("capacity_remaining"),
      cap: n("full_charge_capacity"),
      cur: n("current"),
      pw: n("power"),
      volt: n("total_voltage"),
      t1: n("temperature_sensor_1"),
      t2: n("temperature_sensor_2"),
      mos: n("mosfet_temperature"),
      cycles: n("charging_cycles"),
      bal: n("balancing_current"),
      delta: isNaN(cmax) ? n("delta_cell_voltage") : cmax - cmin,
      cells,
      cmin,
      cmax,
      avg,
      balancing: this._on("binary_sensor." + p + "balancing"),
      chargeOk: this._on("switch." + p + "charging"),
      dischargeOk: this._on("switch." + p + "discharging"),
      online: this._on("binary_sensor." + p + "online_status"),
      balStart: b.balance_start ? this._num(b.balance_start) : NaN,
      balTrig: b.balance_trigger ? this._num(b.balance_trigger) : NaN,
      balMax: b.balance_current ? this._num(b.balance_current) : NaN,
      socId: "sensor." + p + "state_of_charge",
    };
  }

  async _loadStats() {
    if (!this._hass || !this._config) return;
    const ids = this._config.batteries.map((b) => "sensor." + b.prefix + "state_of_charge");
    try {
      const start = new Date(Date.now() - this._config.history_days * 864e5).toISOString();
      const r = await this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: start,
        period: "hour",
        statistic_ids: ids,
        types: ["mean", "max"],
      });
      const out = {};
      ids.forEach((id) => {
        const pts = (r[id] || []).map((p) => ({
          t: typeof p.start === "number" ? p.start : Date.parse(p.start),
          mean: p.mean,
          max: p.max,
        }));
        let lastFull = null;
        pts.forEach((p) => {
          if (p.max != null && p.max >= this._config.full_soc) lastFull = p.t + 3600e3;
        });
        out[id] = { pts, lastFull };
      });
      this._stats = out;
      this._render();
    } catch (e) {
      this._stats = { error: true };
    }
  }

  /* ---------- formatage ---------- */

  _f(v, d = 0) {
    if (v == null || isNaN(v)) return "–";
    return v.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  _pw(w) {
    if (isNaN(w)) return "–";
    const a = Math.abs(w);
    return a >= 1000 ? this._f(a / 1000, 2) + " kW" : this._f(a, 0) + " W";
  }
  _ago(t) {
    if (!t) return null;
    const s = Math.max(0, (Date.now() - t) / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    if (d === 0 && h === 0) return "à l'instant";
    if (d === 0) return "il y a " + h + " h";
    return "il y a " + d + " j" + (h ? " " + h + " h" : "");
  }
  _socColor(soc) {
    if (isNaN(soc)) return "#6c7fd8";
    if (soc < 20) return "#ef476f";
    if (soc < 40) return "#ffb703";
    if (soc < 70) return "#ffd166";
    return "#06d6a0";
  }
  _deltaInfo(mv) {
    if (isNaN(mv)) return { c: "#8b95b8", l: "–" };
    if (mv < 15) return { c: "#06d6a0", l: "Excellent" };
    if (mv < 30) return { c: "#ffd166", l: "Correct" };
    if (mv < 60) return { c: "#ffb703", l: "À surveiller" };
    return { c: "#ef476f", l: "Déséquilibré" };
  }

  /* ---------- rendu ---------- */

  _batteryHtml(b) {
    const col = this._socColor(b.soc);
    const lvl = isNaN(b.soc) ? 0 : Math.max(0, Math.min(100, b.soc));
    const dir = b.cur > 0.5 ? "charge" : b.cur < -0.5 ? "decharge" : "repos";
    const dirTxt = dir === "charge" ? "En charge" : dir === "decharge" ? "En décharge" : "Au repos";
    const tmax = Math.max(...[b.t1, b.t2, b.mos].filter((x) => !isNaN(x)));
    const badges = [];
    if (b.balancing) badges.push(`<span class="badge bal">⚖ Équilibrage ${this._f(b.bal, 2)} A</span>`);
    if (b.chargeOk === false) badges.push(`<span class="badge warn">Charge coupée</span>`);
    if (b.dischargeOk === false) badges.push(`<span class="badge warn">Décharge coupée</span>`);
    if (b.online === false) badges.push(`<span class="badge warn">BMS hors ligne</span>`);
    return `
      <div class="batt">
        <div class="bname">${b.name}</div>
        <div class="bwrap">
          <div class="bshape ${dir}">
            <div class="cap"></div>
            <div class="body">
              <div class="fill" style="height:${lvl}%;background:linear-gradient(180deg,${col},${col}99)"></div>
              <div class="flow"></div>
              <div class="pct">${this._f(b.soc)}<small>%</small></div>
            </div>
          </div>
          <div class="bstats">
            <div class="row"><span>Restant</span><b>${this._f(b.rem, 0)} / ${this._f(b.cap, 0)} Ah</b></div>
            <div class="row"><span>${dirTxt}</span><b class="${dir}">${this._f(Math.abs(b.cur), 1)} A · ${this._pw(b.pw)}</b></div>
            <div class="row"><span>Tension</span><b>${this._f(b.volt, 2)} V</b></div>
            <div class="row"><span>Température</span><b>${isFinite(tmax) ? this._f(tmax, 1) + " °C" : "–"}</b></div>
            <div class="row"><span>Cycles</span><b>${this._f(b.cycles)}</b></div>
          </div>
        </div>
        <div class="badges">${badges.join("")}</div>
      </div>`;
  }

  _cellsHtml(b) {
    const mv = b.delta * 1000;
    const di = this._deltaInfo(mv);
    const half = Math.max(0.012, (b.cmax - b.cmin) / 2 + 0.004);
    const lo = b.avg - half;
    const hi = b.avg + half;
    const minI = b.cells.indexOf(b.cmin);
    const maxI = b.cells.indexOf(b.cmax);
    const avgPos = 50;
    const bars = b.cells
      .map((v, i) => {
        if (isNaN(v)) return `<div class="cell"><div class="cbar na"></div><i>${i + 1}</i></div>`;
        const h = Math.max(4, Math.min(100, ((v - lo) / (hi - lo)) * 100));
        const dev = (v - b.avg) * 1000;
        let c = "#06d6a0";
        if (i === maxI && mv >= 5) c = "#ffb703";
        else if (i === minI && mv >= 5) c = "#4cc9f0";
        const tip = `C${i + 1} : ${this._f(v, 3)} V (${dev >= 0 ? "+" : ""}${this._f(dev, 0)} mV)`;
        return `<div class="cell" title="${tip}"><div class="cbar" style="height:${h}%;background:${c}"></div><i>${i + 1}</i></div>`;
      })
      .join("");
    return `
      <div class="cellbox">
        <div class="ctitle">
          <span>${b.name}</span>
          <span class="delta" style="color:${di.c}">Δ ${this._f(mv, 0)} mV · ${di.l}</span>
        </div>
        <div class="cells">
          <div class="avgline" style="bottom:calc(14px + (100% - 14px) * ${avgPos / 100})"></div>
          ${bars}
        </div>
        <div class="cfoot">
          <span><i class="dot" style="background:#4cc9f0"></i>Mini C${minI + 1} ${this._f(b.cmin, 3)} V</span>
          <span>Moy. ${this._f(b.avg, 3)} V</span>
          <span><i class="dot" style="background:#ffb703"></i>Maxi C${maxI + 1} ${this._f(b.cmax, 3)} V</span>
        </div>
        ${isNaN(b.balStart) ? "" : `
        <div class="balset">
          <span>⚖ Équilibrage</span>
          <span>dès <b>${this._f(b.balStart, 2)} V</b></span>
          <span>écart <b>${this._f(b.balTrig * 1000, 0)} mV</b></span>
          <span>max <b>${this._f(b.balMax, 1)} A</b></span>
          <span class="${b.avg >= b.balStart ? "actif" : "attente"}">${b.avg >= b.balStart ? "zone active" : "en attente (" + this._f((b.balStart - b.avg) * 1000, 0) + " mV)"}</span>
        </div>`}
      </div>`;
  }

  _cyclesHtml(bats) {
    const R = 46, C = 2 * Math.PI * R;
    const rings = bats
      .map((b) => {
        const rated = Number(this._config.batteries[b.idx].rated_cycles || this._config.rated_cycles);
        const used = isNaN(b.cycles) ? 0 : Math.min(1, b.cycles / rated);
        const col = used < 0.5 ? "#06d6a0" : used < 0.8 ? "#ffd166" : "#ef476f";
        const left = isNaN(b.cycles) ? NaN : Math.max(0, rated - b.cycles);
        return `
          <div class="cyc">
            <svg viewBox="0 0 120 120" class="ring">
              <circle cx="60" cy="60" r="${R}" class="track"/>
              <circle cx="60" cy="60" r="${R}" class="arc" stroke="${col}"
                stroke-dasharray="${(used * C).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 60 60)"/>
              <text x="60" y="58" class="rv">${this._f(b.cycles)}</text>
              <text x="60" y="76" class="rl">cycles</text>
            </svg>
            <div class="cinfo">
              <b>${b.name}</b>
              <span>${this._f(used * 100, 1)} % de la durée de vie</span>
              <span>≈ ${this._f(left)} cycles restants sur ${this._f(rated)}</span>
            </div>
          </div>`;
      })
      .join("");
    return `
      <div class="section">
        <div class="stitle">Cycles de charge <span class="hint">durée de vie LiFePO4 estimée à ${this._f(this._config.rated_cycles)} cycles</span></div>
        <div class="cycgrid">${rings}</div>
      </div>`;
  }

  _tempColor(t) {
    if (isNaN(t)) return "#8b95b8";
    if (t < 5) return "#4cc9f0";
    if (t < 35) return "#06d6a0";
    if (t < 45) return "#ffd166";
    return "#ef476f";
  }

  _tempsHtml(bats) {
    const MIN = -5, MAX = 60;
    const pos = (t) => Math.max(0, Math.min(100, ((t - MIN) / (MAX - MIN)) * 100));
    const blocks = bats
      .map((b) => {
        const probes = [
          ["Sonde 1", b.t1],
          ["Sonde 2", b.t2],
          ["MOSFET (BMS)", b.mos],
        ];
        const rows = probes
          .map(([lbl, t]) => {
            const c = this._tempColor(t);
            const bar = isNaN(t)
              ? ""
              : `<div class="tfill" style="width:${pos(t).toFixed(1)}%;background:linear-gradient(90deg,#4cc9f0,${c})"></div>
                 <div class="tdot" style="left:${pos(t).toFixed(1)}%;background:${c};box-shadow:0 0 8px ${c}"></div>`;
            return `
              <div class="trow">
                <span class="tl">${lbl}</span>
                <div class="ttrack">${bar}</div>
                <b style="color:${c}">${isNaN(t) ? "–" : this._f(t, 1) + " °C"}</b>
              </div>`;
          })
          .join("");
        const valid = probes.map((p) => p[1]).filter((x) => !isNaN(x));
        const spread = valid.length > 1 ? Math.max(...valid) - Math.min(...valid) : NaN;
        return `
          <div class="tbox">
            <div class="ctitle"><span>${b.name}</span><span class="hint">écart sondes ${this._f(spread, 1)} °C</span></div>
            ${rows}
          </div>`;
      })
      .join("");
    return `
      <div class="section">
        <div class="stitle">Températures <span class="hint">charge LiFePO4 déconseillée sous 5 °C · idéal 15–35 °C · échelle −5 à 60 °C</span></div>
        <div class="cellgrid">${blocks}</div>
      </div>`;
  }

  _sparkHtml(bats) {
    if (!this._stats || this._stats.error) return "";
    const colors = ["#c77dff", "#4cc9f0", "#ffd166"];
    const W = 600, H = 90;
    const since = Date.now() - 72 * 3600e3;
    let lines = "";
    bats.forEach((b, i) => {
      const s = this._stats[b.socId];
      if (!s) return;
      const pts = s.pts.filter((p) => p.t >= since && p.mean != null);
      if (pts.length < 2) return;
      const d = pts
        .map((p) => {
          const x = ((p.t - since) / (72 * 3600e3)) * W;
          const y = H - (p.mean / 100) * H;
          return x.toFixed(1) + "," + y.toFixed(1);
        })
        .join(" ");
      lines += `<polyline points="${d}" fill="none" stroke="${colors[i % 3]}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
    });
    if (!lines) return "";
    const grid = [25, 50, 75]
      .map((g) => `<line x1="0" x2="${W}" y1="${H - (g / 100) * H}" y2="${H - (g / 100) * H}" class="g"/>`)
      .join("");
    const legend = bats
      .map((b, i) => `<span><i class="dot" style="background:${colors[i % 3]}"></i>${b.name}</span>`)
      .join("");
    return `
      <div class="section">
        <div class="stitle">Charge sur 72 h <span class="legend">${legend}</span></div>
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="spark">${grid}${lines}</svg>
        <div class="axis"><span>-72 h</span><span>-48 h</span><span>-24 h</span><span>maintenant</span></div>
      </div>`;
  }

  _gapHtml(bats) {
    if (bats.length < 2) return "";
    const [a, b] = bats;
    const gap = b.soc - a.soc;
    const ag = Math.abs(gap);
    const gc = ag < 5 ? "#06d6a0" : ag < 10 ? "#ffd166" : "#ef476f";
    const lower = gap > 0 ? a.name : b.name;

    // partage du courant
    const tot = a.cur + b.cur;
    let share = "";
    const expA = a.cap / (a.cap + b.cap);
    if (Math.abs(tot) >= 3 && Math.sign(a.cur) === Math.sign(b.cur)) {
      const sa = a.cur / tot;
      const ecart = (sa - expA) * 100;
      const sens = tot > 0 ? "de la charge" : "de la décharge";
      share = `
        <div class="share">
          <div class="sbar">
            <div class="sa" style="width:${(sa * 100).toFixed(1)}%">${a.name.replace("Batterie ", "B")} ${this._f(sa * 100)} %</div>
            <div class="sb">${b.name.replace("Batterie ", "B")} ${this._f((1 - sa) * 100)} %</div>
            <div class="exp" style="left:${(expA * 100).toFixed(1)}%" title="Répartition attendue selon les capacités"></div>
          </div>
          <div class="note">${a.name} assure ${this._f(sa * 100)} % ${sens} (attendu ${this._f(expA * 100)} % selon les capacités) · ${ecart >= 0 ? "+" : ""}${this._f(ecart, 0)} pt</div>
        </div>`;
    } else {
      share = `<div class="note">Courant trop faible pour mesurer la répartition entre les batteries (au repos).</div>`;
    }

    // dernière charge pleine
    let full = "";
    if (this._stats && !this._stats.error) {
      const ts = bats.map((x) => (this._stats[x.socId] || {}).lastFull).filter(Boolean);
      const last = ts.length === bats.length ? Math.min(...ts) : null;
      const age = last ? (Date.now() - last) / 864e5 : Infinity;
      const fc = age < 3 ? "#06d6a0" : age < 7 ? "#ffd166" : "#ef476f";
      const txt = last ? this._ago(last) : "plus de " + this._config.history_days + " jours";
      full = `
        <div class="kpi">
          <span>Dernière charge à 100 %</span>
          <b style="color:${fc}">${txt}</b>
          <em>${age >= 3 ? "Une charge complète recale les % et laisse l'équilibreur travailler" : "Les % des BMS sont recalés"}</em>
        </div>`;
    }

    return `
      <div class="section">
        <div class="stitle">Écart entre les batteries</div>
        <div class="kpis">
          <div class="kpi">
            <span>Écart de charge</span>
            <b style="color:${gc}">${this._f(ag)} pt</b>
            <em>${ag < 1 ? "Batteries alignées" : lower + " est plus basse"}</em>
          </div>
          <div class="kpi">
            <span>Écart en énergie</span>
            <b>${this._f(Math.abs(b.rem - a.rem), 0)} Ah</b>
            <em>${this._f(a.rem, 0)} Ah contre ${this._f(b.rem, 0)} Ah</em>
          </div>
          ${full}
        </div>
        ${share}
      </div>`;
  }

  _render() {
    if (!this._config || !this._hass || !this.shadowRoot) return;
    const c = this._config;
    const bats = c.batteries.map((b, i) => this._battery(b, i));
    const rem = bats.reduce((s, b) => s + (isNaN(b.rem) ? 0 : b.rem), 0);
    const cap = bats.reduce((s, b) => s + (isNaN(b.cap) ? 0 : b.cap), 0);
    const soc = cap ? (rem / cap) * 100 : NaN;
    const pw = bats.reduce((s, b) => s + (isNaN(b.pw) ? 0 : b.pw), 0);
    const kwh = (rem * c.nominal_voltage) / 1000;
    const usable = Math.max(0, ((soc - c.reserve_soc) / 100) * cap * c.nominal_voltage / 1000);
    let status, scls;
    if (pw > 40) { status = "Charge " + this._pw(pw); scls = "charge"; }
    else if (pw < -40) { status = "Décharge " + this._pw(pw); scls = "decharge"; }
    else { status = "Au repos"; scls = "repos"; }
    let auto = "";
    if (pw < -40 && usable > 0) {
      const h = usable / (Math.abs(pw) / 1000);
      auto = ` · ≈ ${h >= 1 ? this._f(h, 1) + " h" : this._f(h * 60) + " min"} jusqu'à ${c.reserve_soc} %`;
    }

    this.shadowRoot.innerHTML = `
      <style>${BatteriesDuoCard.css}</style>
      <ha-card>
        <div class="wrap">
          <div class="head">
            <div>
              <div class="title">${c.title}</div>
              <div class="sub"><span class="pill ${scls}">${status}</span>${auto}</div>
            </div>
            <div class="tot">
              <div class="big" style="color:${this._socColor(soc)}">${this._f(soc)}<small>%</small></div>
              <div class="sub">${this._f(kwh, 1)} kWh stockés</div>
            </div>
          </div>
          <div class="totbar"><div style="width:${isNaN(soc) ? 0 : soc}%"></div><i style="left:${c.reserve_soc}%"></i></div>

          <div class="batts">${bats.map((b) => this._batteryHtml(b)).join("")}</div>

          ${this._gapHtml(bats)}
          ${this._sparkHtml(bats)}
          ${this._tempsHtml(bats)}
          ${this._cyclesHtml(bats)}

          <div class="section">
            <div class="stitle">Cellules <span class="hint">écart significatif surtout en haut de charge (&gt; 3,40 V)</span></div>
            <div class="cellgrid">${bats.map((b) => this._cellsHtml(b)).join("")}</div>
          </div>
        </div>
      </ha-card>`;
  }
}

BatteriesDuoCard.css = `
  :host { display:block; }
  ha-card { background:transparent; box-shadow:none; border:none; }
  .wrap {
    font-family: var(--ha-card-header-font-family, "Segoe UI", Roboto, sans-serif);
    color:#eef2ff; border-radius:22px; padding:18px 18px 14px;
    background: radial-gradient(120% 80% at 50% 0%, #23315c 0%, #121a33 55%, #0b1020 100%);
    box-shadow: 0 10px 30px rgba(0,0,0,.45); max-width:920px; margin:0 auto;
  }
  .head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
  .title { font-size:20px; font-weight:700; letter-spacing:.2px; }
  .sub { color:#aab4d6; font-size:12.5px; margin-top:4px; }
  .pill { display:inline-block; padding:2px 9px; border-radius:20px; font-weight:600; font-size:12px; margin-right:4px; }
  .pill.charge { background:rgba(6,214,160,.15); color:#06d6a0; }
  .pill.decharge { background:rgba(255,183,3,.15); color:#ffb703; }
  .pill.repos { background:rgba(255,255,255,.08); color:#aab4d6; }
  .tot { text-align:right; }
  .big { font-size:34px; font-weight:800; line-height:1; }
  .big small, .pct small { font-size:.5em; margin-left:2px; opacity:.8; }
  .totbar { position:relative; height:8px; border-radius:6px; margin:12px 0 16px; background:rgba(255,255,255,.08); overflow:visible; }
  .totbar div { height:100%; border-radius:6px; background:linear-gradient(90deg,#ef476f,#ffd166,#06d6a0); }
  .totbar i { position:absolute; top:-3px; width:2px; height:14px; background:#eef2ff; opacity:.5; }

  .batts { display:grid; grid-template-columns:repeat(auto-fit,minmax(250px,1fr)); gap:12px; }
  .batt { background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.08); border-radius:16px; padding:12px; }
  .bname { font-weight:700; font-size:14px; margin-bottom:8px; color:#c9d6ff; }
  .bwrap { display:flex; gap:14px; align-items:center; }
  .bshape { width:74px; flex:none; display:flex; flex-direction:column; align-items:center; }
  .bshape .cap { width:26px; height:7px; background:#3a4a80; border-radius:4px 4px 0 0; }
  .bshape .body { position:relative; width:74px; height:118px; border:3px solid #3a4a80; border-radius:12px; overflow:hidden; background:#121a33; }
  .fill { position:absolute; left:0; right:0; bottom:0; transition:height 1s ease; }
  .pct { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-size:22px; font-weight:800; text-shadow:0 1px 4px rgba(0,0,0,.6); }
  .flow { position:absolute; inset:0; opacity:0; }
  .bshape.charge .flow { opacity:1; background:repeating-linear-gradient(0deg, transparent 0 14px, rgba(255,255,255,.18) 14px 16px); animation:up 1.2s linear infinite; }
  .bshape.decharge .flow { opacity:1; background:repeating-linear-gradient(0deg, transparent 0 14px, rgba(0,0,0,.22) 14px 16px); animation:down 1.6s linear infinite; }
  @keyframes up { from { background-position:0 0; } to { background-position:0 -32px; } }
  @keyframes down { from { background-position:0 0; } to { background-position:0 32px; } }
  .bstats { flex:1; display:flex; flex-direction:column; gap:5px; font-size:12.5px; }
  .row { display:flex; justify-content:space-between; gap:8px; color:#8b95b8; }
  .row b { color:#e8eeff; font-weight:600; text-align:right; }
  b.charge { color:#06d6a0; } b.decharge { color:#ffb703; }
  .badges { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; min-height:0; }
  .badge { font-size:11px; padding:2px 8px; border-radius:20px; }
  .badge.bal { background:rgba(199,125,255,.12); color:#c77dff; }
  .badge.warn { background:rgba(239,71,111,.15); color:#ff8fab; }

  .section { margin-top:14px; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.08); border-radius:16px; padding:12px; }
  .stitle { font-weight:700; font-size:14px; color:#c9d6ff; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px; }
  .hint { font-weight:400; font-size:11px; color:#8b95b8; }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:10px; }
  .kpi { background:rgba(255,255,255,.05); border-radius:12px; padding:10px; display:flex; flex-direction:column; gap:3px; }
  .kpi span { font-size:11.5px; color:#8b95b8; }
  .kpi b { font-size:20px; font-weight:800; }
  .kpi em { font-style:normal; font-size:11.5px; color:#aab4d6; }
  .share { margin-top:12px; }
  .sbar { position:relative; display:flex; height:24px; border-radius:8px; overflow:hidden; font-size:11.5px; font-weight:700; }
  .sa { background:#6c7fd8; display:flex; align-items:center; padding-left:8px; white-space:nowrap; }
  .sb { flex:1; background:#2a2f4a; display:flex; align-items:center; justify-content:flex-end; padding-right:8px; white-space:nowrap; }
  .exp { position:absolute; top:0; bottom:0; width:2px; background:#fff3b0; box-shadow:0 0 6px #ffd166; }
  .note { font-size:11.5px; color:#aab4d6; margin-top:6px; }
  .legend { display:flex; gap:12px; font-weight:400; font-size:11.5px; color:#aab4d6; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:5px; vertical-align:middle; }
  .spark { width:100%; height:90px; display:block; }
  .spark .g { stroke:rgba(255,255,255,.08); stroke-width:1; }
  .axis { display:flex; justify-content:space-between; font-size:10.5px; color:#8b95b8; margin-top:4px; }

  .balset { display:flex; flex-wrap:wrap; gap:4px 12px; margin-top:8px; padding-top:8px; border-top:1px solid rgba(255,255,255,.08); font-size:11px; color:#8b95b8; }
  .balset b { color:#c77dff; font-weight:700; }
  .balset .actif { color:#06d6a0; }
  .balset .attente { color:#aab4d6; }
  .tbox { background:rgba(255,255,255,.05); border-radius:12px; padding:10px; display:flex; flex-direction:column; gap:8px; }
  .trow { display:grid; grid-template-columns:92px 1fr 62px; align-items:center; gap:10px; font-size:12px; }
  .tl { color:#8b95b8; }
  .trow b { text-align:right; font-weight:700; }
  .ttrack { position:relative; height:8px; border-radius:6px; background:rgba(255,255,255,.08); }
  .tfill { position:absolute; left:0; top:0; bottom:0; border-radius:6px; opacity:.55; }
  .tdot { position:absolute; top:50%; width:12px; height:12px; border-radius:50%; transform:translate(-50%,-50%); border:2px solid #0b1020; }
  .cycgrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:12px; }
  .cyc { display:flex; align-items:center; gap:14px; background:rgba(255,255,255,.05); border-radius:12px; padding:10px; }
  .ring { width:96px; height:96px; flex:none; }
  .ring .track { fill:none; stroke:rgba(255,255,255,.08); stroke-width:10; }
  .ring .arc { fill:none; stroke-width:10; stroke-linecap:round; filter:drop-shadow(0 0 4px rgba(6,214,160,.35)); }
  .ring .rv { fill:#eef2ff; font-size:24px; font-weight:800; text-anchor:middle; }
  .ring .rl { fill:#8b95b8; font-size:11px; text-anchor:middle; }
  .cinfo { display:flex; flex-direction:column; gap:3px; font-size:12px; color:#aab4d6; }
  .cinfo b { color:#c9d6ff; font-size:13.5px; }
  .cellgrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px; }
  .cellbox { background:rgba(255,255,255,.05); border-radius:12px; padding:10px; }
  .ctitle { display:flex; justify-content:space-between; font-size:12.5px; font-weight:700; margin-bottom:8px; }
  .delta { font-weight:700; }
  .cells { position:relative; display:flex; align-items:flex-end; gap:3px; height:90px; padding-bottom:14px; }
  .avgline { position:absolute; left:0; right:0; height:0; border-top:1px dashed rgba(255,255,255,.25); z-index:1; pointer-events:none; }
  .cell { flex:1; height:100%; display:flex; flex-direction:column; justify-content:flex-end; align-items:center; position:relative; }
  .cbar { width:100%; border-radius:4px 4px 2px 2px; transition:height .8s ease; opacity:.9; }
  .cbar.na { height:4px; background:#2a2f4a; }
  .cell i { position:absolute; bottom:-14px; font-style:normal; font-size:9.5px; color:#8b95b8; }
  .cfoot { display:flex; justify-content:space-between; flex-wrap:wrap; gap:6px; font-size:11px; color:#aab4d6; margin-top:6px; }
`;

customElements.define("batteries-duo-card", BatteriesDuoCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "batteries-duo-card",
  name: "Batteries duo",
  description: "Vue de plusieurs batteries JK-BMS : charge, écart, répartition du courant, cellules",
});
