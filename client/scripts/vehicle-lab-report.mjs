// Render the vehicle lab's report.json as one self-contained HTML page: the car x
// scenario matrix, and per run its break audits and tick timelines.
// node scripts/vehicle-lab-report.mjs [../target/vehicle-lab/report.json] [out.html]
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const input = resolve(process.argv[2] ?? '../target/vehicle-lab/report.json');
const output = resolve(process.argv[3] ?? input.replace(/\.json$/, '.html'));
const runs = JSON.parse(readFileSync(input, 'utf8'));
// Timelines are downsampled to at most 400 points per run to keep the page small.
for (const r of runs) {
  const s = r.run.samples, step = Math.max(1, Math.ceil(s.length / 400));
  r.run.samples = s.filter((_, i) => i % step === 0);
}
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vehicle lab</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1f21;--muted:#6b6f73;--ok:#2f7d4f;--bad:#b3362c;--warn:#9a6a00;--line:#dcd8cf;--cell:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#16181a;--fg:#e8e6e1;--muted:#9a9ea3;--ok:#5fbf85;--bad:#ef6f62;--warn:#e0b04a;--line:#33373b;--cell:#1f2225}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 ui-sans-serif,system-ui,sans-serif;margin:0;padding:16px}
h1{font-size:18px;margin:0 0 4px} p{color:var(--muted);margin:0 0 12px;max-width:70ch}
.wrap{overflow-x:auto} table{border-collapse:collapse} th,td{border:1px solid var(--line);padding:4px 6px;text-align:center;white-space:nowrap}
th{font-weight:600;font-size:12px;color:var(--muted)} td.cell{cursor:pointer;background:var(--cell);font-variant-numeric:tabular-nums}
td.ok{color:var(--ok)} td.fail{color:var(--bad);font-weight:600} td.none{color:var(--muted)} td.sel{outline:2px solid var(--fg)}
#detail{margin-top:16px} .audits td{text-align:left;font-size:12px} .tag{display:inline-block;padding:0 6px;border-radius:8px;border:1px solid var(--line);margin-right:4px}
svg{background:var(--cell);border:1px solid var(--line)} .legend{font-size:12px;color:var(--muted)}
</style></head><body>
<h1>Vehicle lab</h1>
<p>Each cell: bonds broken / wheels lost. Green held its expectation, red did not, grey has none. Click a cell for its break audits and timelines.</p>
<div class="wrap"><table id="matrix"></table></div><div id="detail"></div>
<script>
const runs=${JSON.stringify(runs)};
const cars=[...new Set(runs.map(r=>r.car))], scen=[...new Set(runs.map(r=>r.run.scenario))];
const m=document.getElementById('matrix');
m.innerHTML='<tr><th></th>'+scen.map(s=>'<th>'+s+'</th>').join('')+'</tr>'+cars.map(c=>'<tr><th>'+c+'</th>'+scen.map(s=>{
  const r=runs.find(x=>x.car===c&&x.run.scenario===s); if(!r) return '<td></td>';
  const v=r.run.violations.length, cls=v?'fail':((r.run.expect??[]).length?'ok':'none');
  return '<td class="cell '+cls+'" data-c="'+c+'" data-s="'+s+'">'+r.run.bondsBroken+' / '+r.run.wheelsLost+'</td>';}).join('')+'</tr>').join('');
const line=(pts,max,color,w,h)=>'<polyline fill="none" stroke="'+color+'" stroke-width="1.5" points="'+pts.map((v,i)=>(i/(pts.length-1||1)*w).toFixed(1)+','+(h-Math.min(v,max)/max*h).toFixed(1)).join(' ')+'"/>';
function show(c,s){
  document.querySelectorAll('td.sel').forEach(t=>t.classList.remove('sel'));
  document.querySelector('td[data-c="'+c+'"][data-s="'+s+'"]').classList.add('sel');
  const r=runs.find(x=>x.car===c&&x.run.scenario===s).run, S=r.samples, w=640,h=90;
  const col=k=>S.map(x=>x[r.samplesColumns.indexOf(k)]);
  const chart=(k,label,color,max)=>{const v=col(k).map(Number);const mx=max??Math.max(1e-6,...v);return '<div class="legend">'+label+' (max '+Math.max(...v).toFixed(2)+')</div><svg width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'">'+line(v,mx,color,w,h)+'</svg>';};
  const conv=col('converged').map(x=>x?1:0);
  document.getElementById('detail').innerHTML='<h1>'+c+' · '+s+'</h1><p>'+r.why+'. Expect: '+((r.expect??[]).join(', ')||'nothing (measured only)')+'. Top '+r.topSpeed.toFixed(1)+' m/s'+(r.impactSpeed?', impact '+r.impactSpeed.toFixed(1)+' m/s':'')+
    '; '+r.bondsBroken+' bonds, '+r.partsOff+' parts off, '+r.wheelsLost+' wheels lost; stress solve converged on '+(r.converged*100).toFixed(0)+'% of ticks; peak '+r.peakDecelG.toFixed(1)+' g, wheel load '+r.peakWheelLoadXStatic.toFixed(1)+'x static.'+
    (r.violations.length?' <b style="color:var(--bad)">'+r.violations.join('; ')+'</b>':'')+'</p>'+
    chart('speed','speed m/s','#3a78c2')+chart('decelG','deceleration g','#c2703a')+chart('wheelLoadXStatic','peak wheel load x static','#8a55b5')+chart('peakUtilisation','most loaded intact bond, utilisation','#b3362c')+
    '<div class="legend">stress solve converged</div><svg width="'+w+'" height="20" viewBox="0 0 '+w+' 20">'+line(conv,1,'#2f7d4f',w,20)+'</svg>'+
    (r.audits.length?'<h1 style="margin-top:12px">Break audits</h1><div class="wrap"><table class="audits"><tr><th>tick</th><th>bond</th><th>area m²</th><th>tick before, % of fatal (t/c/s)</th><th>utilisation, 5 ticks before</th><th>solve</th><th>decel g</th><th>wheels x static</th><th>touching</th><th>causes</th></tr>'+
      r.audits.map(a=>'<tr><td>'+a.tick+'</td><td>'+a.bond+'</td><td>'+a.area.toFixed(4)+'</td><td>'+['tension','compression','shear'].map(k=>(a.beforeFractionOfFatal[k]*100).toFixed(0)).join(' / ')+'</td><td>'+(a.utilisationBefore||[]).join(' ')+'</td><td>'+(a.converged?'converged':'unconverged')+' ('+a.iterations+' it)</td><td>'+a.decelG.toFixed(1)+'</td><td>'+a.wheelLoadXStatic.toFixed(1)+'</td><td>'+a.touching.slice(0,4).join(', ')+'</td><td>'+a.causes.map(x=>'<span class="tag">'+x+'</span>').join('')+'</td></tr>').join('')+'</table></div>':'<p>Nothing broke.</p>');
}
m.addEventListener('click',e=>{const t=e.target.closest('td.cell');if(t)show(t.dataset.c,t.dataset.s);});
const firstFail=runs.find(r=>r.run.violations.length)??runs[0]; if(firstFail) show(firstFail.car,firstFail.run.scenario);
</script></body></html>`;
writeFileSync(output, html);
console.log(`${runs.length} runs -> ${output}`);
