from pathlib import Path
import gzip,json,os,statistics,subprocess,time,urllib.request
base=Path('/tmp/city-live-late-sep6');base.mkdir(exist_ok=False)
all=[];ticks=os.sysconf('SC_CLK_TCK');pid=166548
for i in range(10):
 started=time.monotonic();s=json.load(urllib.request.urlopen('http://127.0.0.1:4005/match-stats/city-default',timeout=10))
 c=s['city'];n=s['network'];spans=s['spans']
 stat=Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()
 gpu=subprocess.check_output(['nvidia-smi','--query-gpu=utilization.gpu,utilization.memory,memory.used,power.draw','--format=csv,noheader,nounits'],text=True).strip()
 sample={'utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'monotonic':started,'tick':s['server_tick'],'players':s['player_count'],
 'pending_inputs':[p['pending_inputs'] for p in s['players']], 'timings':s['timings']['total_ms'],
 'city':{k:c[k] for k in ['awake_bodies','frozen_bodies','broken_bonds','resim_restore_ms','resim_step_ms'] if k in c},
 'network':{k:n[k] for k in ['total_inbound_bytes','total_outbound_bytes','total_inbound_packets','total_outbound_packets','reliable_packets_sent','datagram_packets_sent','dropped_outbound_packets','malformed_packets']},
 'contact':{k:spans['physics/direct_contact_'+k+'_ms']['v'] for k in ['ownership','validate','sort','reduce','route','copy']},
 'contact_records':spans['physics/direct_contact_count']['v'],'gpu':gpu,'cpu_seconds':(int(stat[11])+int(stat[12]))/ticks}
 all.append(sample);(base/f'{i:02d}.json.gz').write_bytes(gzip.compress((json.dumps(sample,indent=2)+'\n').encode(),mtime=0))
 print(json.dumps({'sample':i,'utc':sample['utc'],'mean_ms':sample['timings']['avg'],'p95_ms':sample['timings']['p95'],'awake':c['awake_bodies'],'bonds':c['broken_bonds'],'restore_ms':c['resim_restore_ms'],'replay_ms':c['resim_step_ms'],'gpu':gpu}),flush=True)
 if i<9:time.sleep(max(0,5-(time.monotonic()-started)))
a,b=all[0],all[-1];elapsed=b['monotonic']-a['monotonic']
summary={'samples':len(all),'start_utc':a['utc'],'end_utc':b['utc'],'wall_seconds':elapsed,
 'tick_rate':(b['tick']-a['tick'])/elapsed,'simulated_seconds':(b['tick']-a['tick'])/60,
 'mean_tick_ms_range':[min(s['timings']['avg'] for s in all),max(s['timings']['avg'] for s in all)],
 'p95_tick_ms_range':[min(s['timings']['p95'] for s in all),max(s['timings']['p95'] for s in all)],
 'contact_host_point_mean_ms':statistics.mean(sum(s['contact'][k] for k in ['ownership','validate','sort','reduce','route']) for s in all),
 'restore_point_mean_ms':statistics.mean(s['city']['resim_restore_ms'] for s in all),
 'replay_point_mean_ms':statistics.mean(s['city']['resim_step_ms'] for s in all),
 'gpu_utilization_sample_mean_percent':statistics.mean(float(s['gpu'].split(',')[0]) for s in all),
 'process_cpu_core_equivalents':(b['cpu_seconds']-a['cpu_seconds'])/elapsed,
 'network_counter_deltas':{k:b['network'][k]-a['network'][k] for k in a['network']},
 'awake_range':[min(s['city']['awake_bodies'] for s in all),max(s['city']['awake_bodies'] for s in all)],
 'bonds_start_end':[a['city']['broken_bonds'],b['city']['broken_bonds']],
 'players':[s['players'] for s in all], 'pending_inputs':[s['pending_inputs'] for s in all]}
(base/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary,indent=2),flush=True)
