from pathlib import Path
import gzip,hashlib,json
b=Path(__file__).resolve().parent;s=json.loads((b/'summary.json').read_text())
def data(name):return gzip.decompress((b/(name+'.gz')).read_bytes())
for name,digest in s['artifact_sha256'].items():assert hashlib.sha256((b/name).read_bytes()).hexdigest()==digest
assert '49 passed' in data('tests.log').decode()
assert data('types.log')==b''
assert 'built in' in data('build.log').decode()
p=json.loads(data('publication.json'));h=json.loads(data('live-http.json'));r=json.loads(data('live-stream-browser.json'));c=r['city']
assert r['ok'] and not r['errors'] and r['transport']=='webtransport'
assert c['chunksTotal']==96420 and c['datagramsReceived']==262 and c['hashChecks']==1
assert c['hashMismatches']==c['topoSeqGaps']==c['orphanedChunks']==0
assert c['chunksBelowGround']==4 and c['staleDrawnChunks']==1
assert c['diagnosticSweep']['performed'] and c['diagnosticSweep']['drawnChunkPosesChecked']==96420
assert c['deepest']['bodyPos'][1]==-40.46 and c['deepest']['localOffset']==[0,0,0]
assert p['index_sha256']==h['index_sha256'] and p['server_sha256']==s['server_sha256']
assert not p['server_restarted'] and not s['backend_compact_contacts_enabled']
print('PASS: client-only deployment, CPU/client checks and live streaming verified; geometry/parking issues remain explicit')
