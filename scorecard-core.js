// Shared scoring core for the Inventory Health Scorecard.
// Loaded by inventory-dashboard.html (single warehouse) and network-dashboard.html
// (all warehouses) so both pages score items and brands identically.

// Pre-group all rows by warehouse once at load time.
// joinData then does O(1) lookups instead of rescanning all rows per switch.
function groupByWH(raw) {
  const grp={};
  const keys=['oh','abc','xyz','custSku','margin','ledger','proc','daysAct'];
  keys.forEach(key=>{
    (raw[key]||[]).forEach(r=>{
      const wh=getWH(r);
      if(!wh) return;
      if(!grp[wh]) grp[wh]={};
      if(!grp[wh][key]) grp[wh][key]=[];
      grp[wh][key].push(r);
    });
  });
  // custMkt kept separate — multi-month, parsed differently
  return grp;
}

// ─── COLUMN HELPERS ──────────────────────────────────────────
function g(row,...keys){for(const k of keys){if(row&&row[k]!==undefined&&row[k]!==null&&row[k]!=='')return row[k];}return '';}
function n(row,...keys){return parseFloat(String(g(row,...keys)).replace(/[$,]/g,''))||0;}
function nPct(row,...keys){const v=String(g(row,...keys));return v.includes('%')?parseFloat(v)/100:parseFloat(v.replace(/[$,]/g,''))||0;}

// ─── WAREHOUSE DETECTION ─────────────────────────────────────
const WH_COLS=['Warehouse Name','warehouse_name','Warehouse','warehouse','Warehouse (Picked) Warehouse Name','Location','location'];
function getWH(row){for(const c of WH_COLS){if(row[c]&&row[c].trim())return row[c].trim();}return '';}
function detectWH(raw){
  const whs=new Set();
  Object.values(raw).flat().forEach(r=>{ const w=getWH(r); if(w&&w.length<20) whs.add(w); });
  return [...whs].sort();
}
function filterWH(rows,wh){return rows.filter(r=>getWH(r)===wh);}

// ─── TOTAL CUSTOMERS (market level) ──────────────────────────
// Uses the latest month's unique customer count per warehouse.
function parseTotalCust(mktRows) {
  const custCols=['# of Ordering Customers','# Active Customers','Total Active Customers',
                  'Active Customers','# of Active Customers','total_customers','# Customers'];
  // Collect latest month per warehouse
  const latest={};   // wh → {month, count}
  mktRows.forEach(r=>{
    const wh=getWH(r);
    if(!wh) return;
    const mo=r['Date Month']||'';
    for(const c of custCols){
      const v=parseFloat(String(r[c]||'').replace(/,/g,''));
      if(!isNaN(v)&&v>0){
        if(!latest[wh]||mo>latest[wh].month) latest[wh]={month:mo,count:v};
        return;
      }
    }
  });
  const map={};
  Object.entries(latest).forEach(([wh,d])=>{ map[wh]=d.count; });
  return map;
}

// ─── ABC ENRICHMENT ──────────────────────────────────────────
// Compute inventory_classification for warehouses where the source sheet
// left it blank. Groups by warehouse+category, ranks by revenue descending,
// then assigns A (≤80% cumulative), B (≤95%), C (>95%).
function enrichABC(rows) {
  const groups={};
  rows.forEach(r=>{
    if(g(r,'inventory_classification')) return; // already set
    const key=`${g(r,'Warehouse (Picked) Warehouse Name')}|||${g(r,'Picked Items Category')}`;
    if(!groups[key]) groups[key]=[];
    groups[key].push(r);
  });
  Object.values(groups).forEach(items=>{
    items.sort((a,b)=>n(b,'Orders Deliveries and Invoices Invoiced Amount')-n(a,'Orders Deliveries and Invoices Invoiced Amount'));
    const total=items.reduce((s,r)=>s+n(r,'Orders Deliveries and Invoices Invoiced Amount'),0);
    if(!total) return;
    let running=0;
    items.forEach(r=>{
      running+=n(r,'Orders Deliveries and Invoices Invoiced Amount');
      const pct=running/total;
      r.inventory_classification=pct<=0.8?'A':pct<=0.95?'B':'C';
    });
  });
}

// ─── BUILD LOOKUPS ───────────────────────────────────────────
function buildLookup(rows, ...idCols) {
  const m={};
  rows.forEach(r=>{
    const id=String(g(r,...idCols)||'').trim();
    if(id&&id!=='0') m[id]=r;
  });
  return m;
}
function buildLookupWH(rows, wh, ...idCols) {
  const m={};
  filterWH(rows,wh).forEach(r=>{
    const id=String(g(r,...idCols)||'').trim();
    if(id) m[id]=r;
  });
  return m;
}

// ─── VELOCITY PERCENTILE ─────────────────────────────────────
// pct = fraction of items in same category that move SLOWER than this item.
// Higher = faster mover = lower penalty. X (fastest) → near 1.0, Z (slowest) → 0.
function buildVelPct(xyzRows, wh) {
  const whRows=wh?filterWH(xyzRows,wh):xyzRows;
  const catMap={}; // cat → [xyzClass]
  whRows.forEach(r=>{
    const cat=g(r,'Picked Items Category','Category','category');
    const xyz=(g(r,'xyz_classification')||'').toUpperCase();
    if(!cat||!xyz) return;
    if(!catMap[cat]) catMap[cat]=[];
    catMap[cat].push(xyz);
  });
  const pct={}; // cat → {X:p, Y:p, Z:p}
  Object.entries(catMap).forEach(([cat,arr])=>{
    const tot=arr.length;
    pct[cat]={};
    // c > cls counts items with SLOWER velocity (higher letter = slower in XYZ)
    ['X','Y','Z'].forEach(cls=>{
      pct[cat][cls]=tot>0?arr.filter(c=>c>cls).length/tot:0;
    });
  });
  return pct;
}

// ─── SCORING (exact Excel formulas) ──────────────────────────
function scoreDIO(status,dio){
  if(status!=='Active') return 0;
  if(dio>365) return 30; if(dio>180) return 25; if(dio>90) return 18;
  if(dio>60) return 10; if(dio>30) return 5; return 0;
}
function scoreABC(status,catABC){
  // Reference: category-level ABC only. C=25, B=10, A=0.
  if(status!=='Active') return 0;
  if(catABC==='C') return 25; if(catABC==='B') return 10; return 0;
}
function scoreVelo(status,velRaw){
  // Reference: ratio of recent 3-mo avg / prior 9-mo avg.
  // 0 = no sales (worst), >20 = explosive growth (best).
  if(status!=='Active') return 0;
  if(velRaw===null||velRaw===0) return 20;
  if(velRaw<=2)  return 12;
  if(velRaw<=5)  return 9;
  if(velRaw<=10) return 5;
  if(velRaw<=20) return 2;
  return 0;
}
function scoreCust(status,numC){
  if(status!=='Active') return 0;
  if(numC===0) return 15; if(numC<=2) return 12; if(numC<=5) return 9;
  if(numC<=10) return 5; if(numC<=20) return 2; return 0;
}
function scoreGMROI(status,gmroi,hasData){
  if(status!=='Active') return 0;
  if(!hasData) return 0; // missing avgInv/cost = unknown, not penalized
  if(gmroi<0.5) return 10; if(gmroi<1) return 8; if(gmroi<1.5) return 5;
  if(gmroi<2) return 3; if(gmroi<3) return 1; return 0;
}
function rec(status,total){
  if(status!=='Active') return '';
  if(total<40) return 'KEEP'; if(total<=54) return 'WATCH'; return 'SUNSET';
}

// ─── JOIN DATA ───────────────────────────────────────────────
// g2 = one warehouse's slice of groupByWH(); totalCustWH = its market customer count.
function joinWH(g2, totalCustWH, wh) {
  g2 = g2 || {};
  totalCustWH = totalCustWH || 1;
  const ohRows = g2.oh || [];
  if(!ohRows.length) return [];

  const abcById  = buildLookup(g2.abc  ||[], 'Netsuite Items Item ID','Item ID','item_id');
  const xyzById  = buildLookup(g2.xyz  ||[], 'Netsuite Items Item ID','Item ID','item_id');
  const custById = buildLookup(g2.custSku||[], 'Item ID','item_id');
  const mgnById  = buildLookup(g2.margin ||[], 'Item ID','item_id');
  const ledById  = buildLookup(g2.ledger ||[], 'Internal ID');
  // Name-based ledger fallback (most rows lack Internal ID)
  const ledByName = {};
  (g2.ledger||[]).forEach(r=>{
    const nm=String(g(r,'Item','item_name')||'').trim().toLowerCase();
    if(nm) ledByName[nm]=r;
  });
  // Active = in proc AND in_catalog not false
  const procRows = g2.proc||[];
  const procIds = new Set(procRows
    .filter(r=>String(r.in_catalog||'').toUpperCase()!=='FALSE')
    .map(r=>String(g(r,'item_id','Item ID')||'').trim()));
  const daById = buildLookup(g2.daysAct||[], 'Item ID','item_id');

  const rows = ohRows.map(item=>{
    const id = String(g(item,'Item ID','item_id')||'').trim();
    const itemName = g(item,'Item Name');
    const abc  = abcById[id]  || {};
    const xyz  = xyzById[id]  || {};
    const cust = custById[id] || {};
    const mgn  = mgnById[id]  || {};
    const led  = ledById[id]  || ledByName[(itemName||'').trim().toLowerCase()] || {};

    const da = daById[id] || {};
    const daysActive = n(da,'days Active','daysActive');
    const _baseStatus = procIds.size>0 ? (procIds.has(id)?'Active':'Inactive') : 'Active';
    // New To Market: <90 days active. No Data: active in proc but zero signal across all sources.
    const _noData = _baseStatus==='Active' && !daysActive
      && !g(abc,'inventory_classification') && !g(xyz,'xyz_classification')
      && !n(mgn,'net revenue','Net Revenue') && !n(led,'Beginning Inv On-hand Value','beginning_inv_value');
    const status = (_baseStatus==='Active' && daysActive>0 && daysActive<90) ? 'New To Market'
                 : _noData ? 'No Data'
                 : _baseStatus;
    const category = g(item,'Item Category Name','Category Name','Category');
    const subCat   = g(item,'item subcategory name','Sub Category Name','Sub Category');
    const brand    = g(item,'Catalog Brand','Brand');
    const saleUnit = g(item,'Sale Units Name');

    // On Hand metrics — raw eaches values
    const convRate  = Math.max(n(item,'Sales Unit Conversion Rate'),1);
    const qohEa    = n(item,'quantity on hand eaches','Quantity On Hand');
    const cons30Ea = n(item,'Consumption 30 Days');
    const cons60Ea = n(item,'Consumption 60 Days');
    const onOrderEa= n(item,'Quantity on Order Each');
    const avgCostEa= n(item,'Average Cost Dollars Eaches','Average Cost');
    // Convert to purchase units
    const qoh      = qohEa    / convRate;
    const cons30   = cons30Ea / convRate;
    const cons60   = cons60Ea / convRate;
    const onOrder  = onOrderEa/ convRate;
    const avgCostPu= avgCostEa * convRate;
    const ohCost   = n(item,'Total On Hand Cost') || qohEa * avgCostEa;
    // Inv Pipe and Total Value computed (not a column in source data)
    const invPipe  = qoh + onOrder;
    const totalVal = invPipe * avgCostPu;

    // ABC
    const rev12mo   = n(abc,'Orders Deliveries and Invoices Invoiced Amount','Invoiced Amount','invoiced_amount');
    const catABC    = (g(abc,'inventory_classification')||'').toUpperCase();
    const subCatABC = (g(abc,'sub_category_classification','Sub Category Classification','subcat_classification')||catABC).toUpperCase();

    // XYZ
    const xyzClass  = (g(xyz,'xyz_classification')||'').toUpperCase();
    const units12mo = n(xyz,'Orders Deliveries and Invoices Invoiced Sales Units','Invoiced Sales Units','total_units');
    const coV       = n(xyz,'coefficient_of_variation');
    // Velocity ratio = recent 3-mo avg / prior 9-mo avg (reference formula).
    // If prior=0 but recent>0 → 2 (new/growing). If no XYZ data → null → max penalty.
    const recent3   = n(xyz,'recent_3_months_units');
    const prior9    = n(xyz,'prior_9_months_units');
    const hasXyz    = !!(g(xyz,'xyz_classification')||recent3||prior9);
    const priorAvg  = prior9/9;
    const recentAvg = recent3/3;
    const velRaw    = !hasXyz ? null : priorAvg>0 ? recentAvg/priorAvg : recentAvg>0 ? 2 : 0;

    // Customers
    const numCust   = n(cust,'# of Ordering Customers','num_customers');
    const custPct   = numCust / totalCustWH;
    // 6-mo revenue from the customer source — pairs with numCust for $/customer
    const custNetRev= n(cust,'net revenue','Net Revenue');

    // Customer Margin
    const netRev    = n(mgn,'net revenue','Net Revenue');
    const costAmt   = n(mgn,'Cost Amount','cost_amount');
    const marginPct = nPct(mgn,'Margin %','margin_pct','Margin');

    // Stock Ledger → avg inv + period COGS
    const begOH  = n(led,'Beginning Inv On-hand Value','beginning_inv_value');
    const endOH  = n(led,'Ending Inv On-hand Value','ending_inv_value');
    const avgInvRaw = n(led,'avg inv','Avg Inv','avg_inv','Average Inventory');
    const avgInv = avgInvRaw || (begOH+endOH)/2;
    // Value of Outputs = April COGS (30-day period, same window as avgInv)
    const vop = n(led,'Value of Outputs','value_of_outputs');
    const hasLedger = avgInv>0;

    // DIO: primary = 6-month margin COGS (stable trailing signal, matches reference formula).
    // Secondary = ledger VOP (30-day April) for items with no margin data.
    // Single-month VOP is too volatile to use as primary (one slow month inflates DIO).
    // Dead stock (avgInv > 0, no COGS anywhere) → 9999.
    let dio = 0;
    if(avgInv>0){
      if(costAmt>0)    dio = Math.min(avgInv*182/costAmt, 9999); // margin: 6-month COGS; cap dead-slow
      else if(vop>0)   dio = Math.min(avgInv*30/vop,     9999); // VOP fallback
      else             dio = 9999;                               // no sales signal
    }

    // ITO and GMROI — costAmt primary (stable 6-mo), VOP fallback
    const ito   = avgInv>0 ? (costAmt>0 ? (costAmt*2)/avgInv : vop>0 ? (vop*12)/avgInv : 0) : 0;
    const gmroi = hasLedger && costAmt>0 ? (netRev-costAmt)/avgInv : 0;

    // Scoring (aligned to reference formulas)
    const dioSc   = scoreDIO(status,dio);
    const abcSc   = scoreABC(status,catABC);
    const veloSc  = scoreVelo(status,velRaw);
    const custSc  = scoreCust(status,numCust);
    const gmroiSc = scoreGMROI(status,gmroi,hasLedger&&costAmt>0);
    // Items with no inventory value (e.g. currently OOS, no ledger row) can't
    // earn DIO (30) or GMROI (10) penalties — grading them against 100 makes
    // missing data a free pass to KEEP. Normalize to the achievable max instead.
    const hasGm     = hasLedger && costAmt>0;
    const scoredMax = 60 + (hasLedger?30:0) + (hasGm?10:0);
    const rawScore  = dioSc+abcSc+veloSc+custSc+gmroiSc;
    const total     = status==='Active' ? Math.round(rawScore/scoredMax*100) : null;
    const recommendation = rec(status,total);

    return {id,brand,itemName,category,subCat,saleUnit,status,daysActive,wh,
      qoh,cons30,cons60,onOrder,avgCostEa,ohCost,invPipe,totalVal,
      rev12mo,catABC,subCatABC,xyzClass,units12mo,coV,
      numCust,custPct,netRev,costAmt,marginPct,avgInv,vop,ito,dio,gmroi,
      velRaw,dioSc,abcSc,veloSc,custSc,gmroiSc,scoredMax,total,recommendation};
  });

  // Customer category %
  const catCustTot={};
  rows.forEach(r=>{catCustTot[r.category]=(catCustTot[r.category]||0)+r.numCust;});
  rows.forEach(r=>{r.custCatPct=catCustTot[r.category]>0?r.numCust/catCustTot[r.category]:0;});

  return rows;
}

// ─── BRAND AGGREGATION ───────────────────────────────────────
function buildBrands(joined){
  const map={};
  joined.filter(r=>r.status!=='Inactive'&&r.status!=='No Data').forEach(r=>{
    const key=r.brand;
    if(!map[key]) map[key]={brand:r.brand,catCounts:{},skus:0,rev:0,cost:0,aClass:0,bClass:0,cClass:0,xClass:0,zClass:0,dioArr:[],sumNetRev:0,sumCostAmt:0,gmroiArr:[],sunsetSkus:0,sunsetCust:0,sunsetRev:0};
    const d=map[key];
    if(r.category)d.catCounts[r.category]=(d.catCounts[r.category]||0)+1;
    d.skus++;d.rev+=r.rev12mo;d.cost+=r.ohCost;
    if(r.catABC==='A')d.aClass++;else if(r.catABC==='B')d.bClass++;else if(r.catABC==='C')d.cClass++;
    if(r.xyzClass==='X')d.xClass++;else if(r.xyzClass==='Z')d.zClass++;
    if(r.dio>0&&r.dio<99999)d.dioArr.push(r.dio);
    if(r.netRev>0){d.sumNetRev+=r.netRev;d.sumCostAmt+=r.costAmt;}
    if(r.gmroi!==0)d.gmroiArr.push(r.gmroi);
    if(r.recommendation==='SUNSET'){d.sunsetSkus++;d.sunsetCust+=r.numCust;d.sunsetRev+=r.rev12mo;}
  });
  const avg=arr=>arr.length?arr.reduce((a,b)=>a+b,0)/arr.length:0;
  return Object.values(map).map(d=>{
    // Derive display category: primary (most SKUs) or "Multiple"
    const catEntries=Object.entries(d.catCounts).sort((a,b)=>b[1]-a[1]);
    const category=catEntries.length===0?'—':catEntries.length===1?catEntries[0][0]:'Multiple';
    const pctSunset=d.skus>0?d.sunsetSkus/d.skus:0;
    const revRetention=d.rev-d.sunsetRev;
    const revRetPct=d.rev>0?revRetention/d.rev:0;
    const blendedMargin=d.sumNetRev>0?(d.sumNetRev-d.sumCostAmt)/d.sumNetRev:0;
    const avgDIO=avg(d.dioArr);
    // Reference 5-tier brand recommendation (Score Engine → Brand Evaluation sheet)
    const brandRec=
      d.rev<1000                                                ? 'EXIT BRAND'      : // near-zero revenue
      (pctSunset>=0.6&&d.rev<50000)                            ? 'EXIT BRAND'      : // high sunset + low rev
      (d.aClass===0&&d.rev<20000)                              ? 'EXIT BRAND'      : // no A-class + small brand
      revRetPct>0&&avgDIO>150                                   ? 'MOQ REVIEW'      :
      pctSunset>=0.25&&d.aClass>0                               ? 'TRIM TAIL'       :
      d.rev>200000&&d.aClass>0                                  ? 'KEEP — Strategic':
                                                                  'MONITOR';
    return {...d,category,avgDIO,blendedMargin,avgGMROI:avg(d.gmroiArr),pctSunset,revRetention,revRetPct,custImpacted:d.sunsetCust,recommendation:brandRec};
  }).sort((a,b)=>b.rev-a.rev);
}
