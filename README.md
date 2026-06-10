# AquaHERO

**Aqua Hydraulic Extraction & Recovery Operation**

Engineering calculator for hydraulic offshore wind monopile extraction during decommissioning. Computes break-out pressures, extraction flow rates, dual pump class requirements, base seal loading, and tip suction forces for complete bi-diameter tapered monopile recovery.

## What it calculates

- Skin friction load (embedment within lower straight section, base diameter)
- Pile self-weight and buoyancy
- Tip suction force — clay plugged (Nc method) or sand unplugged (Nq reverse bearing)
- Complete force breakdown with signed components
- Design extraction force with user-defined factor of safety
- Phase 1 break-out pressure (triplex plunger pump class)
- Phase 2 extraction flow rate (centrifugal pump class), auto-derived from 4-hour extraction target
- Dual pump class feasibility assessment against adjustable equipment limits
- Base seal loading analysis — self-energising radial lip force, downward thrust, extrusion risk, seabed bearing check
- PDF export report with full input/output summary and pile diagram

## Fixed assumptions

| Parameter | Value |
|---|---|
| Steel density | 7,850 kg/m³ |
| Hydraulic efficiency | 0.85 |
| Seawater density | 1,025 kg/m³ |
| Extraction target | 4 hours per pile |
| Seal inflation pressure | 1.5 bar |

## Pile geometry model

Three-zone bi-diameter tapered monopile:
1. **Lower straight section** — base diameter (embedment always within this zone)
2. **Taper section** — linear transition, user-defined start and length
3. **Upper straight section** — top diameter

## Running locally

No build step required. Pure HTML/CSS/JS.

```bash
git clone https://github.com/YOUR_USERNAME/aquahero.git
cd aquahero
# Open index.html directly, or serve locally:
npx serve .
# or
python3 -m http.server 8080
```

## Deploying to Vercel

### Option A — Vercel CLI
```bash
npm install -g vercel
vercel
```

### Option B — Vercel dashboard
1. Push repo to GitHub
2. Go to vercel.com → New Project → Import your GitHub repo
3. Leave all settings as default → Deploy
4. Live at `aquahero.vercel.app` or your custom domain

## Custom domain

Register `aquahero.com` or `aquahero.io`, add via Vercel project Settings → Domains. HTTPS automatic.

## Disclaimer

For engineering guidance only. All outputs require independent verification by a qualified engineer before use in design, planning, or operations.

## Licence

MIT
