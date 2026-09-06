from pathlib import Path
import gzip,hashlib,json
base=Path(__file__).resolve().parent
s=json.loads((base/'summary.json').read_text())
for name,expected in s['artifact_sha256'].items():
 p=base/name
 assert hashlib.sha256(p.read_bytes()).hexdigest()==expected,name
 gzip.decompress(p.read_bytes())
assert 'PASS contact scratch' in gzip.decompress((base/'sanitizer.log.gz').read_bytes()).decode()
assert '100% tests passed, 0 tests failed out of 1' in gzip.decompress((base/'cmake-test.log.gz').read_bytes()).decode()
assert 'Finished `release` profile' in gzip.decompress((base/'release-build.log.gz').read_bytes()).decode()
assert not gzip.decompress((base/'main-syntax.log.gz').read_bytes())
assert s['cpu_order_records']==3910872 and s['cpu_sum_additions']==693000
assert not s['full_city_audit_run'] and not s['city_deployed']
print('PASS: CPU tests/sanitizers, release build, main syntax check; full-city audit and deployment explicitly pending')
