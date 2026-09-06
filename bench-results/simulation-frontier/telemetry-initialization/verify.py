from pathlib import Path
import gzip,hashlib,json
b=Path(__file__).resolve().parent;s=json.loads((b/'summary.json').read_text())
for name,digest in s['evidence_sha256'].items():
 assert hashlib.sha256((b/name).read_bytes()).hexdigest()==digest,name
reg=json.loads(gzip.decompress((b/'regression.json.gz').read_bytes()))
assert reg==s['regression']
assert reg[0]['arm']=='before' and reg[0]['exit_code']!=0
assert 'gpuStressHostWorkMilliseconds' in reg[0]['output']
assert reg[1]['arm']=='after' and reg[1]['exit_code']==0
assert '308 telemetry initialization checks' in reg[1]['output']
ctest=gzip.decompress((b/'ctest.log.gz').read_bytes()).decode()
assert 'blast_stress_physx_telemetry_initialization' in ctest and '100% tests passed' in ctest
unit=gzip.decompress((b/'validator-tests.log.gz').read_bytes()).decode()
assert 'Ran 6 tests' in unit and '\nOK\n' in unit
build=gzip.decompress((b/'release-build.log.gz').read_bytes()).decode()
assert 'Compiling vibe-land-physx-bridge' in build and 'Finished `release` profile' in build
first=json.loads(gzip.decompress((b/'historical-first-tick.json.gz').read_bytes()))
assert first['t']==0 and first['hw_node_stress_ms']>1e12 and first['gpu_host_blocked_ms']>1e9
assert len(s['not_qualified'])==5
assert s['live_binary_sha256']=='7c5d04267217f6993ca6da0464de8a3ea8ebf8bfe3283f089521f003841aa5ee'
assert s['candidate_binaries']['web-fps-server'] != s['live_binary_sha256']
print('PASS: old-constructor failure, fixed 308-check pass, native CTest, six validator tests, rebuilt candidate, raw corrupt startup evidence')
