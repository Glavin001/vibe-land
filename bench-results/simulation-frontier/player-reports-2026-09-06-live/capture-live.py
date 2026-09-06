from pathlib import Path
import csv,json,os,subprocess,time,urllib.request
base=Path('/tmp/city-live-player-sep6');out=base/'live-samples';out.mkdir(exist_ok=False)
pid=166548
hertz=os.sysconf('SC_CLK_TCK')
prev=None
for i in range(10):
 start=time.monotonic();utc=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
 raw=json.load(urllib.request.urlopen('http://127.0.0.1:4005/match-stats/city-default',timeout=10))
 stat=Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()
 cpu=(int(stat[11])+int(stat[12]))/hertz
 gpu=subprocess.check_output(['nvidia-smi','--query-gpu=utilization.gpu,utilization.memory,memory.used,power.draw,clocks.current.sm','--format=csv,noheader,nounits'],text=True).strip()
 sample={'utc':utc,'monotonic':start,'request_seconds':time.monotonic()-start,'pid':pid,'cpu_seconds':cpu,'gpu':gpu,'stats':raw}
 if prev:
  elapsed=start-prev['monotonic'];sample['process_cpu_cores']=(cpu-prev['cpu_seconds'])/elapsed
  sample['observed_tick_rate']=(raw['server_tick']-prev['stats']['server_tick'])/elapsed
 (out/f'{i:02d}.json').write_text(json.dumps(sample,indent=2)+'\n')
 city=raw['city'];spans=raw['spans'];timings=raw['timings'];net=raw['network']
 print(json.dumps({'sample':i,'utc':utc,'tick':raw['server_tick'],'players':raw['player_count'],'awake':city['awake_bodies'],'bonds':city['broken_bonds'],'tick_mean':timings['total_ms']['avg'],'tick_p95':timings['total_ms']['p95'],'pending':[p['pending_inputs'] for p in raw['players']],'cpu_cores':sample.get('process_cpu_cores'),'gpu':gpu,'contact_host_ms':sum(spans['physics/direct_contact_'+p+'_ms']['v'] for p in ['ownership','validate','sort','reduce','route']),'restore_ms':city['resim_restore_ms'],'replay_ms':city['resim_step_ms']}),flush=True)
 prev=sample
 if i!=9:time.sleep(max(0,5-(time.monotonic()-start)))
