'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
const RHO_STEEL  = 7850;
const RHO_WATER  = 1025;
const G          = 9.81;
const HYD_EFF    = 0.85;
const P_INFLATE  = 1.5;   // bar — fixed seal inflation pressure

// AUDIT FIX 6 — documented Phase 1 / Phase 2 model constants
const K_WATER          = 2.2e9; // Pa — bulk modulus of seawater
const T_PRESSURISE_S   = 600;   // s — assumed Phase 1 pressurisation ramp (10 min)
const LEAK_FRACTION    = 0.05;  // — seal/fitting leakage allowance as fraction of Phase 2 flow
const RESID_FRICTION   = 0.30;  // — residual (remoulded) skin friction as fraction of peak, post-breakout

const el = id => document.getElementById(id);

// ── Geometry helpers ───────────────────────────────────────────────────────
function ringArea(d, wt) {
  const di = Math.max(d - 2 * wt, 0.05);
  return Math.PI / 4 * (d * d - di * di);
}
function innerArea(d, wt) {
  const di = Math.max(d - 2 * wt, 0.05);
  return Math.PI / 4 * di * di;
}
function outerArea(d) { return Math.PI / 4 * d * d; }

// ── Read inputs ────────────────────────────────────────────────────────────
function getInputs() {
  const dBase      = parseFloat(el('dBase').value);
  const dTop       = parseFloat(el('dTop').value);
  const wt_m       = parseFloat(el('wt').value) / 1000;
  const plen       = parseFloat(el('plen').value);
  const taperStart = parseFloat(el('taperStart').value);
  const taperLen   = parseFloat(el('taperLen').value);
  const emb        = parseFloat(el('emb').value);
  const soilSel    = el('soil').value;
  const usf_kPa    = soilSel === 'custom' ? parseFloat(el('usf').value) : parseFloat(soilSel);
  const fos        = parseFloat(el('fos').value);
  // AUDIT FIX 3 — no silent 0.5 m clamp; validation enforces taperStart+taperLen ≤ plen
  const upperLen   = Math.max(plen - taperStart - taperLen, 0);

  const tipType    = el('tip-soil-type').value;
  const su_tip     = parseFloat(el('su-tip').value);
  const nq_tip     = parseFloat(el('nq-tip').value);
  const gamma_sub  = parseFloat(el('gamma-sub').value);
  // MERGE v1.2 — internal skin friction factor (inner wall vs stationary plug)
  const intFric    = parseFloat(el('int-fric').value);

  return { dBase, dTop, wt_m, plen, taperStart, taperLen, upperLen, emb,
           usf_kPa, fos, tipType, su_tip, nq_tip, gamma_sub, intFric };
}

// ── Input validation ───────────────────────────────────────────────────────
// AUDIT FIX 3 — geometric consistency enforced before any calculation.
// Returns an array of error strings; empty array = valid.
function validateInputs(inp) {
  const errors = [];
  if (inp.taperStart + inp.taperLen > inp.plen) {
    errors.push(
      `Taper start (${inp.taperStart} m) + taper length (${inp.taperLen} m) = ` +
      `${inp.taperStart + inp.taperLen} m exceeds total pile length (${inp.plen} m). ` +
      `Reduce taper start or taper length, or increase pile length.`);
  }
  if (inp.emb > inp.taperStart) {
    errors.push(
      `Embedment (${inp.emb} m) exceeds the lower straight section (${inp.taperStart} m). ` +
      `Embedment must lie entirely within the lower straight section — ` +
      `reduce embedment or move the taper start higher.`);
  }
  return errors;
}

function renderInputErrors(errors) {
  let box = el('input-errors');
  if (!box) {
    box = document.createElement('div');
    box.id = 'input-errors';
    box.className = 'input-errors';
    const panel = document.querySelector('.inputs-panel');
    panel.appendChild(box);
  }
  if (errors.length === 0) {
    box.style.display = 'none';
    box.innerHTML = '';
  } else {
    box.style.display = '';
    box.innerHTML = '<strong>Invalid geometry — calculation blocked:</strong>' +
      errors.map(e => `<div class="input-error-row">✗ ${e}</div>`).join('');
  }
}

// ── Tip suction calculation ────────────────────────────────────────────────
// Clay (plugged): F_tip = Nc × Su × A_inner  (Nc = 9, deep condition)
// Sand (unplugged): F_tip = Nq × σv'_tip × A_annular  where σv' = γ_sub × emb
function calculateTipSuction(inp) {
  const dInner  = inp.dBase - 2 * inp.wt_m;
  const A_inner = Math.PI / 4 * dInner * dInner;
  const A_annul = ringArea(inp.dBase, inp.wt_m);   // steel annulus only

  let tipForce_N = 0, plugged = false, label = '';

  if (inp.tipType === 'clay') {
    const Nc = 9.0;
    tipForce_N = Nc * inp.su_tip * 1000 * A_inner;
    plugged = true;
    label = `Clay plugged: N_c(${Nc}) × S_u(${inp.su_tip} kPa) × A_inner(${A_inner.toFixed(2)} m²)`;
  } else if (inp.tipType === 'sand') {
    const sigma_v = inp.gamma_sub * 1000 * inp.emb;   // Pa
    tipForce_N = inp.nq_tip * sigma_v * A_annul;
    plugged = false;
    label = `Sand unplugged: N_q(${inp.nq_tip}) × σv'(${(sigma_v/1000).toFixed(0)} kPa) × A_annul(${A_annul.toFixed(2)} m²)`;
  }

  return {
    tipForce_N,
    tipForce_kN: tipForce_N / 1000,
    tipForce_t:  tipForce_N / (G * 1000),
    plugged,
    label,
    A_inner,
    A_annul,
    tipType: inp.tipType,
  };
}

// ── Core hydraulic calculation ─────────────────────────────────────────────
function calculate(inp) {
  const { dBase, dTop, wt_m, plen, taperStart, taperLen, upperLen, emb, usf_kPa, fos } = inp;
  const dMid = (dBase + dTop) / 2;

  const steelVol = ringArea(dBase, wt_m) * taperStart
                 + ringArea(dMid,  wt_m) * taperLen
                 + ringArea(dTop,  wt_m) * upperLen;

  // Embedment always within lower straight section (enforced by validateInputs)
  const skinFriction_N = usf_kPa * 1000 * (Math.PI * dBase) * emb;

  // MERGE v1.2 — internal skin friction: the base seal drives the soil plug
  // down while the pile is extracted upward, so the inner wall slides past a
  // stationary plug over the embedment length. Internal unit friction is taken
  // as a user factor × external unit friction (default 0.5): water injection
  // at the plug–wall interface reduces it; Janssen surcharge arching from the
  // seal down-thrust can increase it. Factor range 0–1.5 provided.
  const dInnerCalc        = dBase - 2 * wt_m;
  const intSkinFriction_N = inp.intFric * usf_kPa * 1000 * (Math.PI * dInnerCalc) * emb;

  const pileWeight_N   = steelVol * RHO_STEEL * G;

  // AUDIT FIX 1 — buoyancy acts on the STEEL volume only.
  // The pile is a flooded tube: internal water is part of the pressurised system
  // already represented by P × A_internal. Deducting full-envelope displacement
  // double-counted hydrostatics and understated required force ~18% at defaults.
  // Net submerged steel weight = steelVol × (ρ_steel − ρ_water) × g.
  const buoyancy_N     = steelVol * RHO_WATER * G;
  const submergedWeight_N = pileWeight_N - buoyancy_N;

  // Tip suction
  const ts = calculateTipSuction(inp);

  const baseForce_N   = skinFriction_N + intSkinFriction_N + submergedWeight_N + ts.tipForce_N;
  const designForce_N = baseForce_N * fos;
  const hydForce_N    = designForce_N / HYD_EFF;

  const iAreaBase            = innerArea(dBase, wt_m);
  const breakoutPressure_bar = (hydForce_N / iAreaBase) / 1e5;

  const vel_ms                 = emb / (4 * 3600);
  const extractionFlow_Ls      = iAreaBase * vel_ms * 1000;

  // AUDIT FIX 6a — Phase 1 flow: compressibility make-up of the sealed water
  // column (seal at seabed → top cap, length = plen − emb) over the
  // pressurisation ramp, plus a leakage allowance. Replaces the former
  // undocumented "12% of extraction flow" constant.
  const colVol_m3       = iAreaBase * Math.max(plen - emb, 0);
  const breakoutP_Pa    = breakoutPressure_bar * 1e5;
  const breakoutFlow_Ls = (colVol_m3 * breakoutP_Pa / K_WATER) / T_PRESSURISE_S * 1000
                        + LEAK_FRACTION * extractionFlow_Ls;

  // AUDIT FIX 6b — Phase 2 working pressure derived from the post-breakout
  // force balance: submerged self-weight + residual (remoulded) skin friction
  // at RESID_FRICTION × peak, tip suction taken as broken by Phase 1.
  // Unfactored working estimate; excludes line losses — verify with supplier.
  const extractionPressure_bar =
    ((submergedWeight_N + RESID_FRICTION * (skinFriction_N + intSkinFriction_N)) / HYD_EFF / iAreaBase) / 1e5;

  return {
    skinFriction_N,
    skinFriction_MN: skinFriction_N / 1e6,
    intSkinFriction_MN: intSkinFriction_N / 1e6,
    pileWeight_kN:   pileWeight_N / 1000,
    buoyancy_kN:     buoyancy_N / 1000,
    submergedWeight_MN: submergedWeight_N / 1e6,
    tipSuction_kN:   ts.tipForce_kN,
    tipSuction_t:    ts.tipForce_t,
    tipSuction_pct:  baseForce_N > 0 ? (ts.tipForce_N / baseForce_N) * 100 : 0,
    ts,
    baseForce_MN:    baseForce_N / 1e6,        // AUDIT FIX 7.4 — unfactored total from components
    designForce_kN:  designForce_N / 1000,
    designForce_t:   designForce_N / (G * 1000),
    hydForce_kN:     hydForce_N / 1000,
    breakoutPressure_bar,
    extractionFlow_Ls,
    breakoutFlow_Ls,
    extractionPressure_bar,
    vel_mms:         vel_ms * 1000,
    pileMass_t:      steelVol * RHO_STEEL / 1000,
    iAreaBase,
    upperLen,
  };
}

// ── Seal analysis calculation ──────────────────────────────────────────────
// AUDIT FIX 4 — pressure-energised seal model.
// The former membrane-tension derivation (T = ΔP·R/2 resolved at the rim) was
// removed: (a) it resolved the VERTICAL component (T·sinθ = ΔP·r/2 — check:
// × 2πr = ΔP·πr², the total pressure resultant) and labelled it radial;
// (b) a convex-up dome loaded from above is in membrane COMPRESSION, so the
// tension model does not apply.
// Physical mechanism implemented instead: the inflated dome is squeezed
// between the applied water pressure above and the soil plug below. Its
// internal pressure tracks the applied pressure, pressing the lip against the
// pile inner wall with contact pressure ≈ P_applied + P_inflate. Contact
// therefore always exceeds the sealed pressure — the standard sealing
// criterion for a pressure-energised seal is met at any applied pressure.
function calculateSeal(inp, r) {
  const dInner    = inp.dBase - 2 * inp.wt_m;
  const rInner    = dInner / 2;
  const iArea     = Math.PI / 4 * dInner * dInner;

  // MERGE v1.2 — multi-ring seal inputs
  const nRings     = parseInt(el('n-rings').value, 10);
  const tubeDia_m  = parseFloat(el('tube-dia').value) / 1000;
  const domeH      = Math.min(parseFloat(el('dome-height').value), rInner * 0.95);
  const lipWidth_m = 0.25 * tubeDia_m;   // effective contact width per ring ≈ 25% of tube ⌀
  const stackHeight_m = nRings * tubeDia_m + domeH;
  const domeRatio  = domeH / rInner;

  // Dome geometry — spherical cap (informational, for bag design)
  const R_sphere = (rInner * rInner + domeH * domeH) / (2 * domeH);
  const rimAngle_deg = Math.asin(Math.min(rInner / R_sphere, 1)) * (180 / Math.PI);

  // Applied gauge pressure at the seal
  const P_applied = r.breakoutPressure_bar;

  // Downward thrust — seabed/plug resists P_applied acting on the full inner area
  const downThrust_MN = (P_applied * 1e5 * iArea) / 1e6;
  const downThrust_t  = (downThrust_MN * 1e6) / (G * 1000);

  // AUDIT FIX 5.4 (minor) — net bearing increase on the plug = applied gauge
  // pressure (inflation pressure is internal to the bag, not transmitted net)
  const seabedBearing_kPa = P_applied * 100;

  // Lip contact pressure — pressure-energised: bag internal ≈ applied + inflation
  const lipContact_bar = P_applied + P_INFLATE;
  const lipContact_MPa = lipContact_bar / 10;
  const sealMargin_bar = lipContact_bar - P_applied;   // always = P_INFLATE > 0

  // Radial line load on the pile wall = contact pressure × lip contact width
  const radialFPL_kNm  = (lipContact_bar * 1e5 * lipWidth_m) / 1000;  // kN per metre of rim
  const totalRadial_MN = (radialFPL_kNm * 2 * Math.PI * rInner) / 1000;

  // MERGE v1.2 — multi-ring sliding friction during extraction. The pile wall
  // slides up past the seal lips: top ring is pressure-energised at
  // (P_ext + inflation); lower rings grip at inflation pressure only
  // (standby barriers, un-energised unless the ring above leaks).
  const MU_SEAL      = 0.15;   // rubber on wet steel, water lubricated
  const P_ext_bar    = r.extractionPressure_bar;
  const topGrip_Nm   = (P_ext_bar + P_INFLATE) * 1e5 * lipWidth_m;
  const lowerGrip_Nm = P_INFLATE * 1e5 * lipWidth_m * Math.max(nRings - 1, 0);
  const frictionDrag_MN = (MU_SEAL * (topGrip_Nm + lowerGrip_Nm) * 2 * Math.PI * rInner) / 1e6;

  // Extrusion risk assessment
  // Reinforced elastomer with anti-extrusion backup rings: ~200–400 bar contact
  // capability; plain rubber ~10–20 bar. 300 bar used as "with rings" design limit.
  // AUDIT FIX 5 — percentage no longer capped; only the bar fill is capped in gaugeBar()
  const extrusionPct = (lipContact_bar / 300) * 100;
  const extrusionCls  = extrusionPct >= 100 ? 'high' : extrusionPct >= 50 ? 'moderate' : 'low';
  const extrusionMsg  = extrusionPct >= 100 ? 'Bespoke high-pressure elastomer specification required'
                      : extrusionPct >= 50  ? 'Anti-extrusion backup rings essential'
                      : 'Manageable with standard backup ring arrangement';

  // Hydraulic fracturing at pile tip
  // Threshold ≈ K0 × γ' × emb (effective horizontal stress at tip depth).
  // Fracturing is BENEFICIAL — breaks negative pore pressure (tip suction).
  // AUDIT FIX 7 — γ' taken from the user's tip input when sand is selected;
  // 9 kN/m³ retained as the typical marine-sediment default otherwise.
  const K0            = 0.45;
  const gammaSub_Nm3  = inp.tipType === 'sand' ? inp.gamma_sub * 1000 : 9000;
  const sigmaH_Pa     = K0 * gammaSub_Nm3 * inp.emb;
  const fractureThreshold_bar = sigmaH_Pa / 1e5;
  const fractureRatio = fractureThreshold_bar > 0 ? P_applied / fractureThreshold_bar : 0;
  const fracturingActive = fractureRatio >= 1.0;
  // Bar display: scale so threshold = 20% of bar (bar fill only; numeric ratio shown uncapped)
  const fracturePct   = Math.min((fractureRatio / 5) * 100, 100);

  return {
    dInner, rInner, domeH, R_sphere, rimAngle_deg,
    P_applied,
    downThrust_MN, downThrust_t,
    seabedBearing_kPa,
    lipContact_bar, lipContact_MPa, sealMargin_bar,
    radialFPL_kNm, totalRadial_MN,
    extrusionPct, extrusionCls, extrusionMsg,
    fractureThreshold_bar, fractureRatio, fracturingActive, fracturePct,
    gammaSub_kNm3: gammaSub_Nm3 / 1000,
    domeRatio, lipWidth_m,
    nRings, tubeDia_m, stackHeight_m, frictionDrag_MN,
  };
}

// ── Seal SVG diagram ───────────────────────────────────────────────────────
// MERGE v1.2 — multi-ring seal assembly: n stacked toroidal tubes + dome
function drawSealSVG(s, idPrefix) { idPrefix = idPrefix || '';
  const W = 180, H = 175;
  const pileX_L = 30, pileX_R = 150;
  const pileW = pileX_R - pileX_L;
  const seabedY = H - 28;
  const cx = (pileX_L + pileX_R) / 2;

  // Tube radius px scaled to tube dia vs inner pile diameter
  const rT = Math.max(6, Math.min(16, (s.tubeDia_m / s.dInner) * pileW / 2));
  const n  = s.nRings;

  // Tube centre y positions, stacked up from seabed
  const tubeYs = [];
  for (let i = 0; i < n; i++) tubeYs.push(seabedY - rT - i * 2 * rT);
  const topTubeTopY = tubeYs[n - 1] - rT;

  // Dome arc above the top tube
  const domeH_px  = Math.max(8, Math.min(38, (s.domeH / s.rInner) * (pileW / 2)));
  const domeBaseY = topTubeTopY;
  const rx        = pileW / 2;
  const rSph_px   = (rx * rx + domeH_px * domeH_px) / (2 * domeH_px);

  let tubes = '';
  tubeYs.forEach(cy => {
    tubes += `<circle cx="${pileX_L + rT}" cy="${cy}" r="${rT}" fill="rgba(167,139,250,0.18)" stroke="#a78bfa" stroke-width="1.4"/>`;
    tubes += `<circle cx="${pileX_R - rT}" cy="${cy}" r="${rT}" fill="rgba(167,139,250,0.18)" stroke="#a78bfa" stroke-width="1.4"/>`;
  });

  let hatch = '';
  for (let x = 6; x < W - 6; x += 8)
    hatch += `<line x1="${x}" y1="${seabedY}" x2="${x - 8}" y2="${seabedY + 8}" stroke="#4e6280" stroke-width="0.6"/>`;

  let arrows = '';
  for (let i = 0; i < 5; i++) {
    const ax = pileX_L + 12 + i * (pileW - 24) / 4;
    arrows += `<line x1="${ax}" y1="${domeBaseY - domeH_px - 20}" x2="${ax}" y2="${domeBaseY - domeH_px - 6}" stroke="#38bdf8" stroke-width="1.2" marker-end="url(#${idPrefix}arrB)"/>`;
  }

  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="${idPrefix}arrB" markerWidth="5" markerHeight="5" refX="3" refY="2.5" orient="auto"><polygon points="0 0, 5 2.5, 0 5" fill="#38bdf8"/></marker>
    <marker id="${idPrefix}arrL" markerWidth="5" markerHeight="5" refX="0" refY="2.5" orient="auto"><polygon points="5 0, 0 2.5, 5 5" fill="#a78bfa"/></marker>
    <marker id="${idPrefix}arrR" markerWidth="5" markerHeight="5" refX="3" refY="2.5" orient="auto"><polygon points="0 0, 5 2.5, 0 5" fill="#a78bfa"/></marker>
  </defs>
  ${hatch}
  <line x1="4" y1="${seabedY}" x2="${W-4}" y2="${seabedY}" stroke="#4e6280" stroke-width="1" stroke-dasharray="4,3"/>
  <rect x="${pileX_L - 8}" y="6" width="8" height="${seabedY + 8}" rx="1" fill="#1e3252" stroke="#38bdf8" stroke-width="1"/>
  <rect x="${pileX_R}" y="6" width="8" height="${seabedY + 8}" rx="1" fill="#1e3252" stroke="#38bdf8" stroke-width="1"/>
  ${arrows}
  <path d="M ${pileX_L} ${domeBaseY} A ${rSph_px} ${rSph_px} 0 0 1 ${pileX_R} ${domeBaseY}" fill="rgba(167,139,250,0.12)" stroke="#a78bfa" stroke-width="1.8"/>
  ${tubes}
  <line x1="${pileX_L - 2}" y1="${tubeYs[n-1]}" x2="${pileX_L - 17}" y2="${tubeYs[n-1]}" stroke="#a78bfa" stroke-width="1.3" marker-end="url(#${idPrefix}arrL)"/>
  <line x1="${pileX_R + 2}" y1="${tubeYs[n-1]}" x2="${pileX_R + 17}" y2="${tubeYs[n-1]}" stroke="#a78bfa" stroke-width="1.3" marker-end="url(#${idPrefix}arrR)"/>
  <text x="${cx}" y="${domeBaseY - domeH_px - 24}" font-size="8.5" fill="#38bdf8" text-anchor="middle" font-family="Inter,sans-serif">applied pressure</text>
  <text x="${cx}" y="${seabedY + 16}" font-size="8" fill="#4e6280" text-anchor="middle" font-family="Inter,sans-serif">seabed</text>
  <text x="${cx}" y="${(tubeYs[0] + tubeYs[n-1]) / 2 + 3}" font-size="8" fill="#a78bfa" text-anchor="middle" font-family="Inter,sans-serif" opacity="0.85">${n} × seal rings</text>
</svg>`;
}

// ── Pile canvas drawing ────────────────────────────────────────────────────
function drawPileOnCanvas(canvas, inp, opts) {
  opts = opts || {};
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const { dBase, dTop, plen, taperStart, taperLen, emb } = inp;
  const upperLen = inp.upperLen;

  const PT = opts.padTop    || 36;
  const PB = opts.padBottom || 28;
  const PL = opts.padLeft   || 8;
  const PR = opts.padRight  || 72;

  const drawH  = H - PT - PB;
  const pxPerM = drawH / plen;
  const maxHalf = (W - PL - PR) / 2;
  const scaleD  = maxHalf / (dBase / 2);
  const cx = PL + maxHalf;

  const yFB = m => H - PB - m * pxPerM;
  const xL  = d => cx - (d / 2) * scaleD;
  const xR  = d => cx + (d / 2) * scaleD;

  const yBot       = yFB(0);
  const yTaperBase = yFB(taperStart);
  const yTaperTop  = yFB(taperStart + taperLen);
  const yTop       = yFB(plen);
  const ySeabed    = yFB(emb);

  // Ground hatch
  const hc = document.createElement('canvas'); hc.width = 8; hc.height = 8;
  const hx = hc.getContext('2d'); hx.strokeStyle = 'rgba(78,98,128,0.4)'; hx.lineWidth = 0.8;
  hx.beginPath(); hx.moveTo(0, 8); hx.lineTo(8, 0); hx.stroke();
  ctx.fillStyle = ctx.createPattern(hc, 'repeat');
  ctx.fillRect(0, ySeabed, W, H - ySeabed);

  // Seabed line
  ctx.setLineDash([6, 4]); ctx.strokeStyle = '#334155'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(0, ySeabed); ctx.lineTo(W, ySeabed); ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = '10px Inter, sans-serif'; ctx.fillStyle = '#475569'; ctx.textAlign = 'left';
  ctx.fillText('seabed', 3, ySeabed - 4);

  // Pile polygon
  const leftPts  = [[xL(dTop),yTop],[xL(dTop),yTaperTop],[xL(dBase),yTaperBase],[xL(dBase),yBot]];
  const rightPts = [[xR(dBase),yBot],[xR(dBase),yTaperBase],[xR(dTop),yTaperTop],[xR(dTop),yTop]];
  const all = [...leftPts, ...rightPts];

  function interpX(p1, p2, y) { return p1[0] + (y - p1[1]) / (p2[1] - p1[1]) * (p2[0] - p1[0]); }
  function clipSide(pts) {
    const r = [];
    for (let i = 0; i < pts.length - 1; i++) {
      if (pts[i][1] >= ySeabed) r.push(pts[i]);
      if ((pts[i][1] < ySeabed) !== (pts[i+1][1] < ySeabed))
        r.push([interpX(pts[i], pts[i+1], ySeabed), ySeabed]);
    }
    if (pts[pts.length-1][1] >= ySeabed) r.push(pts[pts.length-1]);
    return r;
  }
  const bL = clipSide(leftPts), bR = clipSide(rightPts);
  const buried = [...bL, ...[...bR].reverse()];
  if (buried.length >= 3) {
    ctx.beginPath(); ctx.moveTo(buried[0][0], buried[0][1]);
    buried.slice(1).forEach(p => ctx.lineTo(p[0], p[1]));
    ctx.closePath(); ctx.fillStyle = 'rgba(14,165,233,0.2)'; ctx.fill();
  }

  ctx.beginPath(); ctx.moveTo(all[0][0], all[0][1]);
  all.slice(1).forEach(p => ctx.lineTo(p[0], p[1]));
  ctx.closePath();
  ctx.fillStyle = 'rgba(14,165,233,0.07)'; ctx.fill();
  ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 1.8; ctx.stroke();

  // Zone labels
  const lx = xR(dBase) + 5;
  ctx.strokeStyle = 'rgba(125,211,252,0.3)'; ctx.lineWidth = 0.8;
  ctx.font = '9px JetBrains Mono, monospace'; ctx.fillStyle = '#7dd3fc'; ctx.textAlign = 'left';
  function zoneLabel(yA, yB, txt) {
    const my = (yA + yB) / 2;
    ctx.beginPath(); ctx.moveTo(lx, yA); ctx.lineTo(lx+3, yA); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(lx, yB); ctx.lineTo(lx+3, yB); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(lx+1.5, yA); ctx.lineTo(lx+1.5, yB); ctx.stroke();
    ctx.fillText(txt, lx+6, my+3);
  }
  zoneLabel(yTaperBase, yBot,       `${taperStart}m`);
  zoneLabel(yTaperTop,  yTaperBase, `${taperLen}m`);
  zoneLabel(yTop,       yTaperTop,  `${upperLen.toFixed(0)}m`);

  ctx.font = '9px JetBrains Mono, monospace'; ctx.fillStyle = '#38bdf8'; ctx.textAlign = 'center';
  ctx.fillText(`⌀${dBase.toFixed(2)}m`, cx, yBot + 14);
  ctx.fillText(`⌀${dTop.toFixed(2)}m`,  cx, yTop - 7);
  ctx.fillStyle = '#64748b'; ctx.font = '9px Inter, sans-serif';
  ctx.fillText(`L = ${plen}m`, cx, yTop - 18);
  const embMidY = (ySeabed + yBot) / 2;
  ctx.fillStyle = '#38bdf8'; ctx.font = '9px JetBrains Mono, monospace';
  ctx.fillText(`${emb}m emb.`, cx, embMidY + 3);

  // Base seal
  const sXL = xL(dBase), sXR = xR(dBase);
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(sXL, ySeabed - 4, sXR - sXL, 7, 2);
  else ctx.rect(sXL, ySeabed - 4, sXR - sXL, 7);
  ctx.fillStyle = '#ef4444'; ctx.globalAlpha = 0.9; ctx.fill(); ctx.globalAlpha = 1;
  ctx.font = '9px Inter, sans-serif'; ctx.fillStyle = '#fca5a5'; ctx.textAlign = 'left';
  ctx.fillText('▲ base seal', 3, ySeabed + 12);
}

// ── Button state machine ───────────────────────────────────────────────────
let _dirty = false, _lastResult = null;

function applyBtnState(btn, label, iC, iS, iD, state) {
  if (!btn) return;
  btn.classList.remove('dirty','done','spinning');
  [iC,iS,iD].forEach(i => { if(i) i.style.display = 'none'; });
  if (state === 'idle')     { if(iC) iC.style.display=''; if(label) label.textContent='Calculate'; }
  else if (state==='dirty') { if(iC) iC.style.display=''; btn.classList.add('dirty'); if(label) label.textContent='Calculate'; }
  else if (state==='spinning') { if(iS) iS.style.display=''; btn.classList.add('spinning'); if(label) label.textContent='Calculating…'; }
  else if (state==='done')  { if(iD) iD.style.display=''; btn.classList.add('done'); if(label) label.textContent='Done'; }
}

function setButtonState(state) {
  applyBtnState(el('calc-btn'),     el('calc-btn-label'),     el('btn-icon-calc'),     el('btn-icon-spin'),     el('btn-icon-done'),     state);
  applyBtnState(el('hdr-calc-btn'), el('hdr-calc-btn-label'), el('hdr-btn-icon-calc'), el('hdr-btn-icon-spin'), el('hdr-btn-icon-done'), state);
  const note = el('calc-btn-note');
  if (note) note.classList.toggle('visible', state === 'dirty');
  if (state === 'done') setTimeout(() => { if(!_dirty) setButtonState('idle'); }, 2400);
}
function markDirty() { _dirty = true; setButtonState('dirty'); }

function runCalculation() {
  // AUDIT FIX 3 — validate before calculating; block and explain if invalid
  const inp    = getInputs();
  const errors = validateInputs(inp);
  renderInputErrors(errors);
  if (errors.length > 0) {
    setButtonState('dirty');
    return;
  }

  setButtonState('spinning');
  _dirty = false;
  // Always show the calculator panel when calculating
  showCalculatorTab();
  setTimeout(() => {
    const r = calculate(inp);
    // AUDIT FIX 8.4 — defensive sanity guard (unreachable with corrected
    // buoyancy since ρ_steel > ρ_water, but protects against future edits)
    if (!isFinite(r.designForce_kN) || r.designForce_kN <= 0) {
      renderInputErrors(['Computed extraction force is non-physical (≤ 0 or non-finite). Check inputs.']);
      setButtonState('dirty');
      return;
    }
    _lastResult = { inp, r };
    renderResults(inp, r);
    setButtonState('done');
  }, 320);
}

// ── Helper: gauge bar HTML ─────────────────────────────────────────────────
// AUDIT FIX 5 — bars cap the FILL visually; numeric percentages are never capped.
function gaugeBar(pct, colour, extraClass) {
  const fill = Math.min(pct, 100);
  const over = pct > 100 ? Math.min(pct - 100, 20) : 0;
  return `<div class="${extraClass || 'feas-bar-track'}">
    <div class="${extraClass ? 'seal-bar-fill' : 'feas-bar-fill'}" style="width:${fill}%;background:${colour}"></div>
    ${over > 0 ? `<div class="${extraClass ? 'seal-bar-over' : 'feas-bar-over'}" style="width:${over}%"></div>` : ''}
  </div>`;
}
function gaugeColour(pct) {
  if (pct >= 100) return '#ef4444';
  if (pct >= 75)  return '#f59e0b';
  return '#22c55e';
}
function overUnder(val, limit, unit) {
  const d = val - limit;
  if (d > 0)             return `<span class="feas-over">+${Math.abs(d).toFixed(1)} ${unit} over</span>`;
  if (d > -limit * 0.25) return `<span class="feas-near">${Math.abs(d).toFixed(1)} ${unit} headroom</span>`;
  return                        `<span class="feas-clear">${Math.abs(d).toFixed(1)} ${unit} headroom</span>`;
}

// ── Render results ─────────────────────────────────────────────────────────
function renderResults(inp, r) {
  // Geometry summary (only rendered for validated geometry — claim is now always true)
  el('geom-summary').innerHTML =
    `<strong>${inp.taperStart}m</strong> lower (⌀${inp.dBase.toFixed(2)}m) + ` +
    `<strong>${inp.taperLen}m</strong> taper + ` +
    `<strong>${r.upperLen.toFixed(0)}m</strong> upper (⌀${inp.dTop.toFixed(2)}m) ` +
    `= <strong>${(inp.taperStart + inp.taperLen + r.upperLen).toFixed(0)}m</strong>. ` +
    `Embedment <strong>${inp.emb}m</strong> in lower straight section.`;

  el('fos-indicator').textContent = inp.fos > 1
    ? `+${((inp.fos - 1) * 100).toFixed(0)}% additional load above calculated value` : '';

  // Diagrams
  drawPileOnCanvas(el('pile-canvas'), inp);
  const hc = el('hero-canvas');
  if (hc) drawPileOnCanvas(hc, inp, { padTop:40, padBottom:30, padLeft:10, padRight:80 });

  // Hero stats (AUDIT FIX 7.4 — thousands separators)
  el('hs-force').textContent    = Math.round(r.designForce_kN).toLocaleString('en-GB') + ' kN';
  el('hs-pressure').textContent = r.breakoutPressure_bar.toFixed(1) + ' bar';
  el('hs-flow').textContent     = r.extractionFlow_Ls.toFixed(0) + ' L/s';

  // Metric cards
  const pC = r.breakoutPressure_bar > 50 ? 'bad' : r.breakoutPressure_bar > 25 ? 'warn' : 'ok';
  const fC = r.extractionFlow_Ls > 500 ? 'warn' : 'ok';
  const tsCls = r.tipSuction_kN > 0 ? (r.tipSuction_pct > 30 ? 'warn' : '') : '';
  el('metrics-grid').innerHTML = [
    { label:'Design extraction force', val:Math.round(r.designForce_kN).toLocaleString('en-GB')+' kN', val2:Math.round(r.designForce_t).toLocaleString('en-GB')+' t', cls:'info highlight' },
    { label:'Pile steel mass',         val:r.pileMass_t.toFixed(0)+' t',       val2:'', cls:'' },
    { label:'Break-out pressure',      val:r.breakoutPressure_bar.toFixed(1)+' bar', val2:'', cls:pC },
    { label:'Extraction flow rate',    val:r.extractionFlow_Ls.toFixed(0)+' L/s', val2:'', cls:fC },
    { label:'Skin friction (ext + int)', val:(r.skinFriction_MN + r.intSkinFriction_MN).toFixed(2)+' MN', val2:'ext '+r.skinFriction_MN.toFixed(2)+' + int '+r.intSkinFriction_MN.toFixed(2), cls:'' },
    { label:'Tip suction force',       val: r.tipSuction_kN > 0 ? Math.round(r.tipSuction_kN).toLocaleString('en-GB')+' kN' : '—', val2: r.tipSuction_kN > 0 ? Math.round(r.tipSuction_t).toLocaleString('en-GB')+' t  ('+r.tipSuction_pct.toFixed(0)+'% of total)' : 'not included', cls: tsCls },
    { label:'Extraction velocity',     val:r.vel_mms.toFixed(3)+' mm/s', val2:'4-hr target', cls:'' },
  ].map(m => `<div class="metric-card ${m.cls}"><div class="mc-label">${m.label}</div><div class="mc-val">${m.val}</div>${m.val2?`<div class="mc-val2">${m.val2}</div>`:''}</div>`).join('');

  // Force breakdown panel (AUDIT FIX 1 — buoyancy on steel displacement;
  // AUDIT FIX 7.4 — unfactored total from components, not designForce/fos)
  const fbHtml = `
    <div class="phase-block">
      <div class="phase-title">Force breakdown — breakout</div>
      <div class="phase-sub">Component forces before factor of safety and hydraulic efficiency</div>
      <div class="phase-row"><span>External skin friction (${inp.usf_kPa} kPa × ${(Math.PI*inp.dBase).toFixed(2)}m perimeter × ${inp.emb}m)</span><span class="pval">+${r.skinFriction_MN.toFixed(2)} MN</span></div>
      <div class="phase-row"><span>Internal skin friction (plug interface, ${inp.intFric.toFixed(2)} × ext unit friction on inner wall)</span><span class="pval">+${r.intSkinFriction_MN.toFixed(2)} MN</span></div>
      <div class="phase-row"><span>Pile self-weight</span><span class="pval">+${(r.pileWeight_kN/1000).toFixed(2)} MN</span></div>
      <div class="phase-row"><span>Buoyancy of steel displacement (upward — deducted)</span><span class="pval">−${(r.buoyancy_kN/1000).toFixed(2)} MN</span></div>
      ${r.tipSuction_kN > 0 ? `<div class="phase-row" style="color:#fdba74"><span>Tip suction — ${inp.tipType === 'clay' ? 'clay plugged (N_c=9)' : 'sand unplugged (N_q='+inp.nq_tip+')'}</span><span class="pval" style="color:#fdba74">+${(r.tipSuction_kN/1000).toFixed(2)} MN</span></div>` : ''}
      <div class="phase-row" style="border-top:1px solid rgba(255,255,255,0.15);margin-top:4px;padding-top:6px;font-weight:500;color:var(--white)"><span>Total (unfactored)</span><span class="pval">${r.baseForce_MN.toFixed(2)} MN</span></div>
      <div class="phase-row" style="color:var(--sky-light)"><span>× FoS ${inp.fos.toFixed(1)} × efficiency (÷${HYD_EFF}) = hydraulic requirement</span><span class="pval" style="color:var(--sky-light)">${(r.hydForce_kN/1000).toFixed(2)} MN</span></div>
    </div>`;

  // Tip note in inputs panel
  if (inp.tipType !== 'none') {
    el('tip-note').innerHTML = `<strong>Tip suction ${Math.round(r.tipSuction_kN).toLocaleString('en-GB')} kN (${Math.round(r.tipSuction_t).toLocaleString('en-GB')} t)</strong> — ${r.tipSuction_pct.toFixed(0)}% of total unfactored extraction force. ${r.tipSuction_pct > 25 ? 'Dominant load component — Phase 1 hydraulic pre-conditioning is critical.' : 'Significant but not dominant. Phase 1 pulse will address.'}`;
    el('tip-note').style.display = '';
  } else {
    el('tip-note').innerHTML = 'Tip suction not included — result is a lower-bound estimate. Consider activating for maximum potential load.';
    el('tip-note').style.display = '';
  }

  // Phase blocks (AUDIT FIX 6 — documented flow/pressure bases; FIX 8 — 8-hr window)
  el('phase-blocks').innerHTML = fbHtml + `
    <div class="phase-block">
      <div class="phase-title">Phase 1 — break-out</div>
      <div class="phase-sub">High-pressure pulse to shear soil skin friction and initiate pile movement</div>
      <div class="phase-row"><span>Required pressure (FoS ${inp.fos.toFixed(1)}×)</span><span class="pval">${r.breakoutPressure_bar.toFixed(1)} bar</span></div>
      <div class="phase-row"><span>Flow during break-out (compressibility make-up + ${(LEAK_FRACTION*100).toFixed(0)}% leakage)</span><span class="pval">${r.breakoutFlow_Ls.toFixed(1)} L/s</span></div>
      <div class="phase-row"><span>Hydraulic force required</span><span class="pval">${(r.hydForce_kN/1000).toFixed(2)} MN</span></div>
      <span class="pump-tag triplex">✓ Triplex plunger pump — high pressure</span>
    </div>
    <div class="phase-block">
      <div class="phase-title">Phase 2 — extraction</div>
      <div class="phase-sub">High-volume flow to sustain 4-hour extraction; valve manifold switches pump class after break-out</div>
      <div class="phase-row"><span>Required flow rate</span><span class="pval">${r.extractionFlow_Ls.toFixed(0)} L/s</span></div>
      <div class="phase-row"><span>Working pressure (submerged weight + ${(RESID_FRICTION*100).toFixed(0)}% residual friction ext+int, unfactored)</span><span class="pval">${r.extractionPressure_bar.toFixed(1)} bar</span></div>
      <div class="phase-row"><span>Extraction velocity (4-hr target)</span><span class="pval">${r.vel_mms.toFixed(3)} mm/s</span></div>
      <div class="phase-row"><span>Embedment to clear</span><span class="pval">${inp.emb}m in 4.0 hrs</span></div>
      <div class="phase-row"><span>Operational window per pile</span><span class="pval">8 hrs (4 extraction + 4 seal set / crane / post-ops)</span></div>
      <span class="pump-tag centrifugal">✓ Large centrifugal seawater pump — high flow</span>
    </div>`;

  // Pump feasibility (AUDIT FIX 5 — percentages uncapped; bars cap fill internally)
  const lP  = parseFloat(el('lim-pressure').value) || 50;
  const lF  = parseFloat(el('lim-flow').value) || 600;
  const pPct = (r.breakoutPressure_bar / lP) * 100;
  const fPct = (r.extractionFlow_Ls / lF) * 100;
  const pc   = gaugeColour(pPct), fc = gaugeColour(fPct);
  const oS   = (pPct >= 100 || fPct >= 100) ? 'difficult' : (pPct >= 75 || fPct >= 75) ? 'marginal' : 'ok';
  const oMsg = { ok:'✓ Both parameters within commercial pump envelope for single-unit operation.', marginal:'⚠ One or more parameters approaching single-unit equipment limits. Verify with pump supplier before committing to design.', difficult:'✗ Parameter(s) exceed single-unit limits. Multiple pump sets in parallel required, or review pile/soil inputs.' };
  el('feasibility-block').innerHTML = `
    <div class="feasibility ${oS}">
      <div class="feas-verdict">${oMsg[oS]}</div>
      <div class="feas-gauges">
        <div class="feas-gauge-row">
          <div class="feas-gauge-label"><span>Break-out pressure</span><span class="feas-nums"><strong style="color:#eef4fc">${r.breakoutPressure_bar.toFixed(1)} bar</strong><span class="feas-sep">/</span><span class="feas-limit">${lP} bar limit</span>${overUnder(r.breakoutPressure_bar,lP,'bar')}</span></div>
          ${gaugeBar(pPct, pc)}
          <div class="feas-pct" style="color:${pc}">${pPct.toFixed(0)}% of limit</div>
        </div>
        <div class="feas-gauge-row">
          <div class="feas-gauge-label"><span>Extraction flow rate</span><span class="feas-nums"><strong style="color:#eef4fc">${r.extractionFlow_Ls.toFixed(0)} L/s</strong><span class="feas-sep">/</span><span class="feas-limit">${lF} L/s limit</span>${overUnder(r.extractionFlow_Ls,lF,'L/s')}</span></div>
          ${gaugeBar(fPct, fc)}
          <div class="feas-pct" style="color:${fc}">${fPct.toFixed(0)}% of limit</div>
        </div>
      </div>
      <div class="feas-note">Limits adjustable in Pump equipment limits panel. Defaults reflect typical single-unit North Sea pump rental ratings. Gauges pair Phase 1 pressure with the triplex limit and Phase 2 flow with the centrifugal limit — additionally verify Phase 1 flow (${r.breakoutFlow_Ls.toFixed(1)} L/s) against the triplex flow rating and Phase 2 working pressure (${r.extractionPressure_bar.toFixed(1)} bar) against the centrifugal head rating with the supplier.</div>
    </div>`;

  // Seal analysis (AUDIT FIX 4 — pressure-energised model; MERGE v1.2 — multi-ring)
  const s = calculateSeal(inp, r);
  const extC = gaugeColour(s.extrusionPct);

  el('seal-analysis').innerHTML = `
    <div class="seal-panel">
      <div class="seal-panel-header">
        <div class="seal-panel-title">Base seal loading analysis</div>
        <span class="seal-at-pressure">At break-out pressure: ${s.P_applied.toFixed(1)} bar</span>
      </div>
      <div class="seal-body">
        <div class="seal-svg-wrap">${drawSealSVG(s)}</div>
        <div class="seal-data">

          <div>
            <div class="seal-group-title">Seal geometry</div>
            <div class="seal-row"><span>Inner pile diameter</span><span class="sval">${s.dInner.toFixed(3)} m</span></div>
            <div class="seal-row"><span>Seal rings</span><span class="sval">${s.nRings} × ⌀${(s.tubeDia_m*1000).toFixed(0)} mm tubes</span></div>
            <div class="seal-row"><span>Stack height (rings + dome)</span><span class="sval">${s.stackHeight_m.toFixed(2)} m</span></div>
            <div class="seal-row"><span>Dome height above top ring</span><span class="sval">${s.domeH.toFixed(2)} m</span></div>
            <div class="seal-row"><span>Sphere radius of dome</span><span class="sval">${s.R_sphere.toFixed(2)} m</span></div>
            <div class="seal-row"><span>Applied gauge pressure at seal</span><span class="sval">${s.P_applied.toFixed(1)} bar</span></div>
          </div>

          <div>
            <div class="seal-group-title">Force analysis</div>
            <div class="seal-row"><span>↓ Total downward thrust on seabed</span><span class="sval">${s.downThrust_MN.toFixed(1)} MN <span class="sval2">(${Math.round(s.downThrust_t).toLocaleString('en-GB')} t)</span></span></div>
            <div class="seal-row"><span>Net bearing pressure increase above ambient</span><span class="sval">${s.seabedBearing_kPa.toFixed(0)} kPa</span></div>
            <div class="seal-row"><span>Top-ring lip contact pressure (pressure-energised: applied + inflation)</span><span class="sval">${s.lipContact_bar.toFixed(1)} bar</span></div>
            <div class="seal-row"><span>Sealing margin (contact − applied)</span><span class="sval">+${s.sealMargin_bar.toFixed(1)} bar ✓</span></div>
            <div class="seal-row"><span>← → Radial line load at ${(s.lipWidth_m*1000).toFixed(0)}mm contact width (≈25% tube ⌀)</span><span class="sval">${s.radialFPL_kNm.toFixed(0)} kN/m of rim</span></div>
            <div class="seal-row"><span>Total circumferential radial force (top ring)</span><span class="sval">${s.totalRadial_MN.toFixed(1)} MN</span></div>
            <div class="seal-row"><span>Seal sliding drag during extraction (μ=0.15, all rings)</span><span class="sval">${s.frictionDrag_MN.toFixed(2)} MN</span></div>
          </div>

          <div>
            <div class="seal-group-title">Assessment</div>
            <div class="seal-gauge-row">
              <div class="seal-gauge-label">
                <span>Rubber extrusion risk</span>
                <span class="seal-gauge-nums"><strong style="color:#eef4fc">${s.lipContact_bar.toFixed(0)} bar contact</strong><span class="feas-sep">/</span><span class="feas-limit">300 bar design limit (with rings)</span></span>
              </div>
              ${gaugeBar(s.extrusionPct, extC, 'seal-bar-track')}
              <div class="seal-pct" style="color:${extC}">${s.extrusionPct.toFixed(0)}% of limit</div>
              <span class="seal-risk-tag ${s.extrusionCls}">${s.extrusionMsg}</span>
            </div>
            <div class="seal-gauge-row" style="margin-top:0.85rem;">
              <div class="seal-gauge-label">
                <span>Hydraulic fracturing at pile tip</span>
                <span class="seal-gauge-nums">
                  <strong style="color:#eef4fc">P ${s.P_applied.toFixed(1)} bar</strong>
                  <span class="feas-sep">vs</span>
                  <span class="feas-limit">threshold ${s.fractureThreshold_bar.toFixed(2)} bar (K₀=0.45, γ'=${s.gammaSub_kNm3.toFixed(1)} kN/m³${inp.tipType === 'sand' ? ' from tip input' : ''})</span>
                </span>
              </div>
              <div class="seal-bar-track">
                <div class="seal-bar-fill" style="width:${s.fracturePct}%;background:${s.fracturingActive ? '#22c55e' : '#f59e0b'}"></div>
              </div>
              <div class="seal-pct" style="color:${s.fracturingActive ? '#22c55e' : '#f59e0b'}">${s.fractureRatio.toFixed(1)}× threshold</div>
              <span class="seal-risk-tag ${s.fracturingActive ? 'low' : 'moderate'}">${s.fracturingActive ? '✓ Fracturing active — tip suction being broken, soil matrix pressurised' : 'Below fracturing threshold — tip conditioning not yet initiated'}</span>
            </div>
            <div class="seal-confined-note">
              Confined soil plug inside pile will not fail in bearing — lateral confinement from the pile wall prevents any shear wedge formation. Under applied pressure the plug compacts and stiffens. This is not a limiting condition for the extraction system.
            </div>
          </div>

          <div class="seal-self-energising">
            <strong>Pressure-energised multi-ring mechanism:</strong> The inflated assembly is squeezed between the applied water pressure above and the soil plug below. The dome's internal pressure tracks the applied pressure, pressing the <strong>top ring</strong> against the pile inner wall at applied + ${P_INFLATE.toFixed(1)} bar inflation — at ${s.P_applied.toFixed(1)} bar applied, the lip bears at <strong>${s.lipContact_bar.toFixed(1)} bar</strong> (${s.radialFPL_kNm.toFixed(0)} kN/m of rim at the ${(s.lipWidth_m*1000).toFixed(0)}mm contact). Contact always exceeds the sealed pressure, so the sealing criterion holds at any applied pressure. The ${s.nRings > 1 ? (s.nRings - 1) + ' lower ring' + (s.nRings > 2 ? 's' : '') + ' provide staged passive redundancy — if the top ring weeps, leaked pressure enters the gap below and pressure-energises the next ring' : 'single-ring arrangement has no staged redundancy — consider 2–3 rings'}. Axial squash of the stack additionally presses every ring into the wall. The ${P_INFLATE.toFixed(1)} bar inflation sets geometry and provides the initial sealing margin.
          </div>

        </div>
      </div>
    </div>`;
}

// ── Calculate button ───────────────────────────────────────────────────────
el('hdr-calc-btn').addEventListener('click', runCalculation);

// ── Slider bindings ────────────────────────────────────────────────────────
const sliderFmt = {
  dBase:          v => parseFloat(v).toFixed(2)+' m',
  dTop:           v => parseFloat(v).toFixed(2)+' m',
  wt:             v => v+' mm',
  plen:           v => v+' m',
  taperStart:     v => v+' m',
  taperLen:       v => v+' m',
  emb:            v => v+' m',
  usf:            v => v+' kPa',
  fos:            v => parseFloat(v).toFixed(1),
  'lim-pressure': v => v+' bar',
  'lim-flow':     v => v+' L/s',
  'int-fric':     v => parseFloat(v).toFixed(2),
  'n-rings':      v => v,
  'tube-dia':     v => v+' mm',
  'dome-height':  v => parseFloat(v).toFixed(2)+' m',
  'su-tip':       v => v+' kPa',
  'nq-tip':       v => v,
  'gamma-sub':    v => parseFloat(v).toFixed(1)+' kN/m³',
};
Object.keys(sliderFmt).forEach(id => {
  const input = el(id); if (!input) return;
  input.addEventListener('input', () => {
    const out = el(id+'-v');
    if (out) out.textContent = sliderFmt[id](input.value);
    markDirty();
    // AUDIT FIX 3 — live geometry feedback while sliding
    renderInputErrors(validateInputs(getInputs()));
  });
});
el('soil').addEventListener('change', () => {
  el('custom-field').style.display = el('soil').value === 'custom' ? '' : 'none';
  markDirty();
});
el('tip-soil-type').addEventListener('change', () => {
  const t = el('tip-soil-type').value;
  el('tip-clay-fields').style.display = t === 'clay' ? '' : 'none';
  el('tip-sand-fields').style.display = t === 'sand' ? '' : 'none';
  markDirty();
});

// ── Tab switching (header-controlled) ──────────────────────────────────────
function showCalculatorTab() {
  el('tab-panel-calculator').style.display = '';
  el('tab-panel-report').style.display = 'none';
  el('hdr-print-btn').style.display = 'none';
}

function showReportTab() {
  el('tab-panel-calculator').style.display = 'none';
  el('tab-panel-report').style.display = '';
  el('hdr-print-btn').style.display = '';
  if (_lastResult) {
    generateReport(_lastResult.inp, _lastResult.r);
    el('report-stale').style.display = 'none';
    el('report-ready').style.display = '';
  } else {
    el('report-stale').style.display = '';
    el('report-ready').style.display = 'none';
  }
}

el('hdr-report-btn').addEventListener('click', () => {
  showReportTab();
  el('tab-panel-report').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

el('hdr-print-btn').addEventListener('click', () => window.print());

const navCta = document.querySelector('.nav-cta');
if (navCta) navCta.addEventListener('click', showCalculatorTab);

// ── Report generation ──────────────────────────────────────────────────────
function generateReport(inp, r) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GB', { day:'2-digit', month:'long', year:'numeric' });
  const timeStr = now.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });

  // Draw a fresh dedicated report pile canvas (taller, cleaner)
  const rpCanvas = document.createElement('canvas');
  rpCanvas.width = 150; rpCanvas.height = 340;
  drawPileOnCanvas(rpCanvas, inp, { padTop:26, padBottom:20, padLeft:6, padRight:56 });
  const rpImgSrc = rpCanvas.toDataURL('image/png');

  const s  = calculateSeal(inp, r);
  const ts = r.ts;

  const tipLabel  = { clay:`Clay plugged (N_c = 9, S_u = ${inp.su_tip} kPa)`, sand:`Sand unplugged (N_q = ${inp.nq_tip}, γ' = ${inp.gamma_sub} kN/m³)`, none:'Not included' }[inp.tipType];

  const lP = parseFloat(el('lim-pressure').value) || 50;
  const lF = parseFloat(el('lim-flow').value) || 600;
  // AUDIT FIX 5 — uncapped percentages in numeric output; bar fill capped at render
  const pPct = (r.breakoutPressure_bar / lP) * 100;
  const fPct = (r.extractionFlow_Ls / lF) * 100;
  const gc   = p => p >= 100 ? '#ef4444' : p >= 75 ? '#f59e0b' : '#22c55e';
  const gcPrint = p => p >= 100 ? 'bad' : p >= 75 ? 'warn' : 'ok';

  el('report-content').innerHTML = `
  <div class="rpt">

    <div class="rpt-header">
      <div>
        <div class="rpt-logo">Aqua<span>HERO</span></div>
        <div style="font-size:0.72rem;color:var(--steel-dim);margin-top:2px;">Aqua Hydraulic Extraction Restoration Operation — Calculation Report</div>
      </div>
      <div class="rpt-meta">
        Date: ${dateStr} ${timeStr}<br>
        Version: v1.2<br>
        Reference: AH-${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}
      </div>
    </div>

    <div class="rpt-grid2">
      <div class="rpt-section">
        <div class="rpt-section-title">Pile geometry</div>
        <div class="rpt-kv"><span class="rk">Base diameter</span><span class="rv">${inp.dBase.toFixed(2)} m</span></div>
        <div class="rpt-kv"><span class="rk">Upper diameter</span><span class="rv">${inp.dTop.toFixed(2)} m</span></div>
        <div class="rpt-kv"><span class="rk">Avg wall thickness</span><span class="rv">${(inp.wt_m*1000).toFixed(0)} mm</span></div>
        <div class="rpt-kv"><span class="rk">Total pile length</span><span class="rv">${inp.plen} m</span></div>
        <div class="rpt-kv"><span class="rk">Lower straight section</span><span class="rv">${inp.taperStart} m</span></div>
        <div class="rpt-kv"><span class="rk">Taper length</span><span class="rv">${inp.taperLen} m</span></div>
        <div class="rpt-kv"><span class="rk">Upper straight section</span><span class="rv">${r.upperLen.toFixed(0)} m</span></div>
        <div class="rpt-kv"><span class="rk">Embedment depth</span><span class="rv">${inp.emb} m</span></div>
      </div>
      <div class="rpt-section">
        <div class="rpt-section-title">Soil &amp; loading</div>
        <div class="rpt-kv"><span class="rk">Skin friction scenario</span><span class="rv">${inp.usf_kPa} kPa</span></div>
        <div class="rpt-kv"><span class="rk">Internal friction factor (plug interface)</span><span class="rv">${inp.intFric.toFixed(2)} × external</span></div>
        <div class="rpt-kv"><span class="rk">Tip suction model</span><span class="rv">${tipLabel}</span></div>
        <div class="rpt-kv"><span class="rk">Factor of safety</span><span class="rv">${inp.fos.toFixed(1)} ×</span></div>
        <div class="rpt-kv" style="margin-top:0.75rem;"><span class="rk">Hydraulic efficiency</span><span class="rv">0.85</span></div>
        <div class="rpt-kv"><span class="rk">Steel density</span><span class="rv">7,850 kg/m³</span></div>
        <div class="rpt-kv"><span class="rk">Seawater density</span><span class="rv">1,025 kg/m³</span></div>
        <div class="rpt-kv"><span class="rk">Extraction target</span><span class="rv">4 hours (8-hr operational window per pile)</span></div>
        <div class="rpt-kv"><span class="rk">Pile steel mass</span><span class="rv">${r.pileMass_t.toFixed(0)} t</span></div>
      </div>
    </div>

    <div class="rpt-diagram-row">
      <div class="rpt-canvas-wrap">
        <img src="${rpImgSrc}" width="150" height="340" alt="Pile cross-section diagram">
        <div class="rpt-diagram-caption">Pile &amp; embedment</div>
      </div>
      <div class="rpt-canvas-wrap">
        ${drawSealSVG(s, 'rpt-')}
        <div class="rpt-diagram-caption">Base seal — ${s.nRings} × ⌀${(s.tubeDia_m*1000).toFixed(0)}mm rings + dome</div>
      </div>
      <div class="rpt-force-col">
        <div class="rpt-section-title">Force breakdown at breakout</div>
        <div class="rpt-kv"><span class="rk">+ External skin friction (${inp.usf_kPa} kPa × ${(Math.PI*inp.dBase).toFixed(2)}m × ${inp.emb}m)</span><span class="rv hi">+${r.skinFriction_MN.toFixed(3)} MN</span></div>
        <div class="rpt-kv"><span class="rk">+ Internal skin friction (plug interface, factor ${inp.intFric.toFixed(2)})</span><span class="rv hi">+${r.intSkinFriction_MN.toFixed(3)} MN</span></div>
        <div class="rpt-kv"><span class="rk">+ Pile self-weight</span><span class="rv hi">+${(r.pileWeight_kN/1000).toFixed(3)} MN</span></div>
        <div class="rpt-kv"><span class="rk">− Buoyancy of steel displacement (deducted)</span><span class="rv" style="color:var(--steel)">−${(r.buoyancy_kN/1000).toFixed(3)} MN</span></div>
        ${r.tipSuction_kN > 0 ? `<div class="rpt-kv"><span class="rk">+ Tip suction — ${tipLabel}</span><span class="rv orange">+${(r.tipSuction_kN/1000).toFixed(3)} MN</span></div>` : ''}
        <div class="rpt-total-row"><span>Unfactored total</span><span class="rv">${r.baseForce_MN.toFixed(3)} MN</span></div>
        <div class="rpt-kv" style="margin-top:8px;"><span class="rk">× FoS ${inp.fos.toFixed(1)} → design force</span><span class="rv hi">${(r.designForce_kN/1000).toFixed(3)} MN  /  ${Math.round(r.designForce_t).toLocaleString('en-GB')} t</span></div>
        <div class="rpt-kv"><span class="rk">÷ efficiency 0.85 → hydraulic requirement</span><span class="rv hi">${(r.hydForce_kN/1000).toFixed(3)} MN</span></div>
        ${r.tipSuction_kN > 0 ? `<div style="margin-top:0.75rem;font-size:0.72rem;color:#fdba74;background:rgba(251,146,60,0.08);border-left:3px solid rgba(251,146,60,0.4);border-radius:4px;padding:0.4rem 0.6rem;line-height:1.5;">Tip suction ${Math.round(r.tipSuction_t).toLocaleString('en-GB')} t = <strong>${r.tipSuction_pct.toFixed(0)}%</strong> of total unfactored extraction force</div>` : ''}
      </div>
    </div>

    <div class="rpt-grid2">
      <div class="rpt-section">
        <div class="rpt-section-title">Phase 1 — break-out</div>
        <div class="rpt-kv"><span class="rk">Required pressure</span><span class="rv ${gcPrint(pPct)}">${r.breakoutPressure_bar.toFixed(1)} bar</span></div>
        <div class="rpt-kv"><span class="rk">Flow during break-out (make-up + leakage)</span><span class="rv">${r.breakoutFlow_Ls.toFixed(1)} L/s</span></div>
        <div class="rpt-kv"><span class="rk">Hydraulic force</span><span class="rv">${(r.hydForce_kN/1000).toFixed(2)} MN</span></div>
        <div class="rpt-kv"><span class="rk">Pump limit</span><span class="rv">${lP} bar</span></div>
        <div class="rpt-kv"><span class="rk">% of pump limit</span><span class="rv ${gcPrint(pPct)}">${pPct.toFixed(0)}%</span></div>
        <span class="rpt-tag triplex">Triplex plunger pump</span>
      </div>
      <div class="rpt-section">
        <div class="rpt-section-title">Phase 2 — extraction</div>
        <div class="rpt-kv"><span class="rk">Required flow rate</span><span class="rv ${gcPrint(fPct)}">${r.extractionFlow_Ls.toFixed(0)} L/s</span></div>
        <div class="rpt-kv"><span class="rk">Working pressure (unfactored est.)</span><span class="rv">${r.extractionPressure_bar.toFixed(1)} bar</span></div>
        <div class="rpt-kv"><span class="rk">Extraction velocity</span><span class="rv">${r.vel_mms.toFixed(3)} mm/s</span></div>
        <div class="rpt-kv"><span class="rk">Extraction time</span><span class="rv">4.0 hours (${inp.emb} m)</span></div>
        <div class="rpt-kv"><span class="rk">Flow limit</span><span class="rv">${lF} L/s</span></div>
        <div class="rpt-kv"><span class="rk">% of pump limit</span><span class="rv ${gcPrint(fPct)}">${fPct.toFixed(0)}%</span></div>
        <span class="rpt-tag centrifugal">Centrifugal seawater pump</span>
      </div>
    </div>

    <div class="rpt-section">
      <div class="rpt-section-title">Pump feasibility</div>
      <div class="rpt-bar-row">
        <span class="rpt-bar-label">Break-out pressure</span>
        <div class="rpt-bar-track"><div class="rpt-bar-fill" style="width:${Math.min(pPct,100)}%;background:${gc(pPct)}"></div></div>
        <span class="rpt-bar-pct" style="color:${gc(pPct)}">${r.breakoutPressure_bar.toFixed(1)} / ${lP} bar  (${pPct.toFixed(0)}%)</span>
      </div>
      <div class="rpt-bar-row">
        <span class="rpt-bar-label">Extraction flow rate</span>
        <div class="rpt-bar-track"><div class="rpt-bar-fill" style="width:${Math.min(fPct,100)}%;background:${gc(fPct)}"></div></div>
        <span class="rpt-bar-pct" style="color:${gc(fPct)}">${r.extractionFlow_Ls.toFixed(0)} / ${lF} L/s  (${fPct.toFixed(0)}%)</span>
      </div>
      <div style="margin-top:0.6rem;font-size:0.7rem;color:var(--steel-dim);font-style:italic;">Phase 1 flow (${r.breakoutFlow_Ls.toFixed(1)} L/s) to be verified against triplex flow rating; Phase 2 working pressure (${r.extractionPressure_bar.toFixed(1)} bar) to be verified against centrifugal head rating.</div>
    </div>
      </div>
    </div>

    <div class="rpt-grid2">
      <div class="rpt-section">
        <div class="rpt-section-title">Base seal analysis</div>
        <div class="rpt-kv"><span class="rk">Seal rings</span><span class="rv">${s.nRings} × ⌀${(s.tubeDia_m*1000).toFixed(0)} mm tubes</span></div>
        <div class="rpt-kv"><span class="rk">Stack height (rings + dome)</span><span class="rv">${s.stackHeight_m.toFixed(2)} m</span></div>
        <div class="rpt-kv"><span class="rk">Dome height above top ring</span><span class="rv">${s.domeH.toFixed(2)} m</span></div>
        <div class="rpt-kv"><span class="rk">Sphere radius</span><span class="rv">${s.R_sphere.toFixed(2)} m</span></div>
        <div class="rpt-kv"><span class="rk">Applied gauge pressure</span><span class="rv">${s.P_applied.toFixed(1)} bar</span></div>
        <div class="rpt-kv"><span class="rk">Downward thrust</span><span class="rv">${s.downThrust_MN.toFixed(1)} MN  (${Math.round(s.downThrust_t).toLocaleString('en-GB')} t)</span></div>
        <div class="rpt-kv"><span class="rk">Top-ring lip contact (pressure-energised)</span><span class="rv">${s.lipContact_bar.toFixed(1)} bar</span></div>
        <div class="rpt-kv"><span class="rk">Radial line load (${(s.lipWidth_m*1000).toFixed(0)}mm contact)</span><span class="rv">${s.radialFPL_kNm.toFixed(0)} kN/m rim</span></div>
        <div class="rpt-kv"><span class="rk">Seal sliding drag (extraction, μ=0.15, all rings)</span><span class="rv">${s.frictionDrag_MN.toFixed(2)} MN</span></div>
        <div class="rpt-kv"><span class="rk">Extrusion risk (vs 300 bar with rings)</span><span class="rv ${s.extrusionCls === 'low' ? 'ok' : s.extrusionCls === 'moderate' ? 'warn' : 'bad'}">${s.extrusionPct.toFixed(0)}% — ${s.extrusionCls.toUpperCase()}</span></div>
        <div class="rpt-kv"><span class="rk">Net seabed bearing increase</span><span class="rv">${s.seabedBearing_kPa.toFixed(0)} kPa — confined plug, non-limiting</span></div>
        <div class="rpt-kv"><span class="rk">Hydraulic fracturing at tip</span><span class="rv ${s.fracturingActive ? 'ok' : 'warn'}">${s.fractureRatio.toFixed(1)}× threshold (${s.fractureThreshold_bar.toFixed(2)} bar) — ${s.fracturingActive ? 'ACTIVE (beneficial)' : 'not initiated'}</span></div>
      </div>
      ${r.tipSuction_kN > 0 ? `
      <div class="rpt-section">
        <div class="rpt-section-title">Tip suction</div>
        <div class="rpt-kv"><span class="rk">Soil model</span><span class="rv">${tipLabel}</span></div>
        <div class="rpt-kv"><span class="rk">Pile condition at tip</span><span class="rv">${ts.plugged ? 'Plugged (full inner area)' : 'Unplugged (annulus only)'}</span></div>
        <div class="rpt-kv"><span class="rk">Area used</span><span class="rv">${ts.plugged ? ts.A_inner.toFixed(2)+' m² (full inner)' : ts.A_annul.toFixed(2)+' m² (annulus)'}</span></div>
        <div class="rpt-kv"><span class="rk">Tip suction force</span><span class="rv orange">${Math.round(r.tipSuction_kN).toLocaleString('en-GB')} kN  /  ${Math.round(r.tipSuction_t).toLocaleString('en-GB')} t</span></div>
        <div class="rpt-kv"><span class="rk">% of unfactored total</span><span class="rv orange">${r.tipSuction_pct.toFixed(0)}%</span></div>
        <div style="margin-top:0.65rem;font-size:0.72rem;color:var(--steel-dim);line-height:1.5;font-style:italic;">Phase 1 hydraulic pre-conditioning breaks negative pore pressure at tip before upward extraction force is applied. Crane-only extraction must overcome skin friction and tip suction simultaneously.</div>
      </div>` : `
      <div class="rpt-section">
        <div class="rpt-section-title">Tip suction</div>
        <div style="font-size:0.78rem;color:var(--steel-dim);padding:0.5rem 0;font-style:italic;">Not included in this calculation. Activate the Tip Suction panel to compute maximum potential extraction loads.</div>
      </div>`}
    </div>

    <div class="rpt-disclaimer">
      This report was generated by AquaHERO v1.2 on ${dateStr} at ${timeStr}. AquaHERO — Aqua Hydraulic Extraction Restoration Operation. All outputs are for engineering guidance only and require independent verification by a qualified engineer before use in design, planning, or offshore operations. Assumptions: hydraulic efficiency 0.85; steel density 7,850 kg/m³; seawater density 1,025 kg/m³; buoyancy on steel displacement (flooded pile); embedment within lower straight pile section (enforced); internal plug skin friction at ${inp.intFric.toFixed(2)} × external unit friction on the inner wall (plug held stationary by seal down-thrust while pile slides past); 4-hour extraction within an 8-hour per-pile operational window (4 h extraction + 4 h seal setting, crane engagement and post-extraction operations); multi-ring pressure-energised base seal (${s.nRings} stacked toroidal tubes + domed diaphragm; top-ring contact = applied + 1.5 bar inflation, lower rings staged passive redundancy; per-ring contact width ≈ 25% of tube diameter; seal–wall friction μ = 0.15); Phase 1 flow from water-column compressibility over a ${(T_PRESSURISE_S/60).toFixed(0)}-minute ramp plus ${(LEAK_FRACTION*100).toFixed(0)}% leakage allowance; Phase 2 pressure from submerged weight plus ${(RESID_FRICTION*100).toFixed(0)}% residual skin friction, unfactored, excluding line losses.
    </div>

  </div>`;
}

// ── Initial render ─────────────────────────────────────────────────────────
(function init() {
  const inp    = getInputs();
  const errors = validateInputs(inp);
  renderInputErrors(errors);
  if (errors.length > 0) { setButtonState('dirty'); return; }
  const r = calculate(inp);
  _lastResult = { inp, r };
  renderResults(inp, r);
  setButtonState('idle');
})();
