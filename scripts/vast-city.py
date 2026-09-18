#!/usr/bin/env python3
"""Deploy this checkout on an existing Vast host. No rental, checkout, or Docker.

python3 scripts/vast-city.py status
python3 scripts/vast-city.py up [--blast-root PATH] [--rebuild]
python3 scripts/vast-city.py verify [--browser] [--public]

State and logs: .certs/vast-city/. Existing checkout-owned servers and Caddy
configs are discovered automatically. Fresh hosts use free mapped ports.
"""
import argparse
import concurrent.futures
import fcntl
import gzip
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import ssl
import subprocess as sp
import sys
import time
import tomllib
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / '.certs/vast-city'
TLS = ssl._create_unverified_context()  # This deployment deliberately pins self-signed TLS.


def run(args, **kw):
    return sp.check_output(args, **kw).decode().strip()


def proc_env(pid):
    return dict(x.decode().split('=', 1) for x in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0') if b'=' in x)


def fetch(url):
    with urllib.request.urlopen(url, context=TLS, timeout=8) as r:
        body = r.read()
        if r.headers.get('Content-Encoding') == 'gzip':
            body = gzip.decompress(body)
        return body, dict(r.headers)


def health(port):
    return json.loads(fetch(f'http://127.0.0.1:{port}/healthz')[0])


def mappings(env):
    result = {'TCP': {}, 'UDP': {}}
    for k, v in env.items():
        m = re.fullmatch(r'VAST_(TCP|UDP)_PORT_(\d+)', k)
        if m and 0 < int(m[2]) < 65536 and v.isdigit() and 0 < int(v) < 65536:
            result[m[1]][int(m[2])] = int(v)
    return result


def free_port(port, udp=False):
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM if udp else socket.SOCK_STREAM) as s:
        try:
            s.bind(('0.0.0.0', port))
            return True
        except OSError:
            return False


def process_identity(pid):
    p = Path(f'/proc/{pid}')
    return [str((p / 'exe').resolve()), (p / 'stat').read_text().rsplit(')', 1)[1].split()[19]]


def discover():
    host = proc_env(1)
    ports = mappings(host)
    ip = os.environ.get('VIBE_PUBLIC_IP') or host.get('PUBLIC_IPADDR')
    if not ip:
        raise RuntimeError('Public IP absent; set VIBE_PUBLIC_IP. Do not guess from old docs.')
    ipaddress.IPv4Address(ip)
    servers, proxies, supervisors = [], [], []
    for p in Path('/proc').glob('[0-9]*'):
        try:
            cmd = (p / 'cmdline').read_bytes().decode().split('\0')
            if (p / 'cwd').resolve() == ROOT and len(cmd) > 1:
                script = Path(cmd[1])
                script = script if script.is_absolute() else ROOT / script
                legacy = script.resolve() == ROOT / 'scripts/run-vl4-server.sh' and Path(cmd[0]).name in ('bash', 'sh')
                managed = script.resolve() == Path(__file__).resolve() and len(cmd) > 2 and cmd[2] == '_serve'
                if legacy or managed:
                    supervisors.append((int(p.name), process_identity(int(p.name))))
            if 'web-fps-server' in Path(cmd[0]).name and (p / 'cwd').resolve() == ROOT:
                e = proc_env(p.name)
                if 'BIND_ADDR' in e and 'WT_BIND_ADDR' in e:
                    servers.append((int(p.name), e))
            if Path(cmd[0]).name == 'caddy' and '--config' in cmd:
                config = Path(cmd[cmd.index('--config') + 1])
                if not config.is_absolute():
                    config = (p / 'cwd').resolve() / config
                text = config.read_text()
                if str(ROOT / 'client/dist') in text:
                    proxies.append((int(p.name), str(config), text))
        except (OSError, ValueError, IndexError, UnicodeError):
            continue
    if len(servers) > 1 or len(proxies) > 1:
        raise RuntimeError('Multiple deployments belong to this checkout; resolve ambiguity before restarting.')
    saved = json.loads((STATE / 'deployment.json').read_text()) if (STATE / 'deployment.json').exists() else {}
    env = servers[0][1] if servers else saved.get('env', {})
    api = int(env.get('BIND_ADDR', '127.0.0.1:4005').rsplit(':', 1)[1])
    udp = int(env['WT_BIND_ADDR'].rsplit(':', 1)[1]) if env else next((p for p in sorted(ports['UDP']) if free_port(p, True)), None)
    proxy = proxies[0] if proxies else None
    if proxy:
        listeners = re.findall(r'^\s*:(\d+)\s*\{', proxy[2], re.M)
        if len(listeners) != 1 or f'127.0.0.1:{api}' not in proxy[2]:
            raise RuntimeError('Existing Caddy configuration is not a single matching city listener.')
        web = int(listeners[0])
    elif servers and env.get('WEB_BIND_ADDR'):
        web = int(env['WEB_BIND_ADDR'].rsplit(':', 1)[1])
    else:
        web = saved.get('web') or next((p for p in sorted(ports['TCP']) if p != 22 and free_port(p)), None)
    if not servers:
        while not free_port(api):
            api += 1
    if web not in ports['TCP'] or udp not in ports['UDP']:
        raise RuntimeError('No suitable mapped TCP/UDP ports; inspect PID-1 mappings or free a deployment-owned port.')
    return dict(ip=ip, web=web, udp=udp, api=api, public_web=ports['TCP'][web],
                public_udp=ports['UDP'][udp], env=env, server=servers[0][0] if servers else None,
                proxy=proxy, supervisors=supervisors, server_identity=process_identity(servers[0][0]) if servers else None,
                proxy_identity=process_identity(proxy[0]) if proxy else None, url=f'https://{ip}:{ports["TCP"][web]}/city')


def source_hash(repo, paths):
    # Content, including dirty/untracked source; not merely HEAD or timestamps.
    names = run(['git', '-C', str(repo), 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', *paths]).split('\0')
    h = hashlib.sha256()
    for name in sorted(set(names)):
        p = repo / name
        if name and p.is_file():
            h.update(name.encode()); h.update(b'\0'); h.update(p.read_bytes())
    return h.hexdigest()


def artifact_hash(artifact, kind):
    if not artifact.exists():
        return None
    if kind == 'server':
        return hashlib.sha256(artifact.read_bytes()).hexdigest()
    h = hashlib.sha256()
    for p in sorted(artifact.parent.rglob('*')):
        if p.is_file():
            h.update(str(p.relative_to(artifact.parent)).encode()); h.update(p.read_bytes())
    return h.hexdigest()


def build(blast, rebuild):
    dependency = tomllib.loads((ROOT / 'destruction/Cargo.toml').read_text())['dependencies']['blast-stress-solver']['path']
    if (ROOT / 'destruction' / dependency).resolve() != (blast / 'blast-stress-solver-rs').resolve():
        raise RuntimeError('BLAST_ROOT differs from destruction/Cargo.toml: align the Rust and native dependency paths first')
    cachefile = STATE / 'build.json'
    cache = json.loads(cachefile.read_text()) if cachefile.exists() else {}
    fingerprint = {
        'server': source_hash(ROOT, ['Cargo*', 'server', 'shared', 'destruction', 'physx-bridge', 'netcode', 'research', 'worlds', '.cargo']) + source_hash(blast.parent, ['blast']) + str(blast),
        'client': source_hash(ROOT, ['Cargo*', 'client', 'shared', 'research/destruction-codec', 'scripts', 'worlds', 'destruction/assets', '.cargo']),
    }
    # Toolchain/build configuration also affects generated artifacts. Never serialize secrets.
    config = run(['rustc', '--version']) + run(['node', '--version']) + repr([(k, os.environ.get(k)) for k in ('PHYSX_ROOT', 'VIBE_CUDA_ARCH', 'RUSTFLAGS', 'CC', 'CXX')])
    envfiles = b''.join(p.read_bytes() for p in sorted(ROOT.glob('.env*')) if p.is_file())
    for key in fingerprint:
        fingerprint[key] = hashlib.sha256((fingerprint[key] + config).encode() + envfiles).hexdigest()
    env = dict(os.environ, BLAST_ROOT=str(blast))
    env.pop('CARGO_TARGET_DIR', None)  # Artifact location is explicitly this checkout's target/.
    jobs = []
    binary = ROOT / 'target/release/web-fps-server'
    artifacts = {'server': binary, 'client': STATE / 'client/index.html'}
    def worker(kind):
        log = STATE / f'build-{kind}.log'
        with log.open('w') as out:
            if kind == 'server':
                commands = [['cargo', 'build', '--release', '-p', 'web-fps-server', '--bin', 'web-fps-server', '--features', 'blast-core,cuda-stress']]
                cwd = ROOT
            else:
                lockhash = hashlib.sha256((ROOT / 'client/package-lock.json').read_bytes()).hexdigest()
                commands = []
                if not (ROOT / 'client/node_modules/.package-lock.json').exists() or cache.get('npm_lock') != lockhash:
                    commands.append(['npm', 'ci', '--no-audit', '--no-fund'])
                commands.append(['npm', 'run', 'build', '--', '--outDir', str(STATE / 'client'), '--emptyOutDir'])
                cwd = ROOT / 'client'
            for command in commands:
                sp.run(command, cwd=cwd, env=env, stdout=out, stderr=sp.STDOUT, check=True)
        return kind
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        for kind, artifact in artifacts.items():
            digest = artifact_hash(artifact, kind)
            if rebuild or cache.get(kind) != fingerprint[kind] or digest != cache.get(kind + '_artifact'):
                print(f'Building {kind}; log: {STATE}/build-{kind}.log', flush=True)
                jobs.append(pool.submit(worker, kind))
        for job in jobs:
            job.result()
    for kind, artifact in artifacts.items():
        fingerprint[kind + '_artifact'] = artifact_hash(artifact, kind)
    fingerprint['npm_lock'] = hashlib.sha256((ROOT / 'client/package-lock.json').read_bytes()).hexdigest()
    cachefile.write_text(json.dumps(fingerprint))
    return binary


def stop(pid, identity):
    try:
        current = process_identity(pid)
    except FileNotFoundError:
        return
    if current != identity:
        raise RuntimeError('PID identity changed; refusing to stop a different process')
    os.kill(pid, signal.SIGTERM)
    for _ in range(100):
        try:
            if process_identity(pid) != identity:
                return
        except FileNotFoundError:
            return
        time.sleep(.1)
    raise RuntimeError(f'PID {pid} did not stop; no broad pkill or forced kill attempted')


def start(binary, env, logfile):
    with logfile.open('ab') as log:
        return sp.Popen([sys.executable, str(Path(__file__).resolve()), '_serve', str(binary)], cwd=ROOT, env=env, stdin=sp.DEVNULL, stdout=log, stderr=log, start_new_session=True)


def ready(process, port):
    for _ in range(100):
        if process.poll() is not None:
            raise RuntimeError('New server exited; see server.log')
        try:
            if health(port)['status'] == 'ok':
                return
        except Exception:
            pass
        time.sleep(.2)
    raise RuntimeError('New server did not become healthy within 20 seconds')


def deploy(d, binary):
    oldenv = d['env']
    env = dict(os.environ, **oldenv)
    cert, key = STATE / 'cert.pem', STATE / 'key.pem'
    renew = not cert.exists() or sp.run(['openssl', 'x509', '-in', str(cert), '-checkend', '172800', '-noout'], stdout=sp.DEVNULL, stderr=sp.DEVNULL).returncode != 0
    if cert.exists() and not renew:
        renew = sp.run(['openssl', 'x509', '-in', str(cert), '-checkip', d['ip'], '-noout'], stdout=sp.DEVNULL, stderr=sp.DEVNULL).returncode != 0
    desired = dict(BIND_ADDR=f'127.0.0.1:{d["api"]}', WT_BIND_ADDR=f'0.0.0.0:{d["udp"]}',
                   WT_PUBLIC_URL=f'https://{d["ip"]}:{d["public_udp"]}')
    same_binary = d['server'] and hashlib.sha256(Path(f'/proc/{d["server"]}/exe').read_bytes()).digest() == hashlib.sha256(binary.read_bytes()).digest()
    if same_binary and d.get('supervisors') and not renew and all(env.get(k) == v for k, v in desired.items()) and env.get('WT_CERT_PEM') == str(cert):
        print('Server already current; no restart.', flush=True)
        return
    identity = (d.get('server_identity') or process_identity(d['server'])) if d['server'] else None
    if d['server'] and health(d['api']).get('players') != 0:
        raise RuntimeError('Players are connected; builds are ready. Retry up once the match is empty.')
    if renew:
        sp.run(['openssl', 'ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', str(key)], check=True)
        key.chmod(0o600)
        sp.run(['openssl', 'req', '-new', '-x509', '-key', str(key), '-out', str(cert), '-days', '12', '-subj', f'/CN={d["ip"]}', '-addext', f'subjectAltName=IP:{d["ip"]},IP:127.0.0.1'], check=True)
    env.update(desired, WT_CERT_PEM=str(cert), WT_KEY_PEM=str(key), RUST_LOG='info')
    env.setdefault('VIBE_PHYSICS_BACKEND', 'physx_gpu')
    env.setdefault('VIBE_CITY_SCENE', 'skyline-stable.json')
    env.setdefault('VIBE_CITY_GRID', '1')
    env['LD_LIBRARY_PATH'] = env.get('LD_LIBRARY_PATH', '') + ':/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release'
    if not d['proxy']:
        if not d['server'] and not free_port(d['web']):
            raise RuntimeError('Selected web port became occupied')
        env.update(WEB_BIND_ADDR=f'0.0.0.0:{d["web"]}', VIBE_WEB_DIR=str(ROOT / 'client/dist'))
    if not d['server'] and (not free_port(d['api']) or not free_port(d['udp'], True)):
        raise RuntimeError('Selected server ports became occupied')
    proxytext = None
    if d['proxy']:
        proxytext = d['proxy'][2].replace(oldenv['WT_CERT_PEM'], str(cert)).replace(oldenv['WT_KEY_PEM'], str(key))
        proxyconfig = STATE / f'Caddyfile-{time.time_ns()}'
        proxyconfig.write_text(proxytext)
        sp.run(['caddy', 'validate', '--config', str(proxyconfig), '--adapter', 'caddyfile'], check=True, stdout=sp.DEVNULL, stderr=sp.DEVNULL)
    previous = STATE / 'web-fps-server-previous'
    if d['server']:
        if process_identity(d['server']) != identity:
            raise RuntimeError('Serving process changed; retry deployment')
        shutil.copyfile(f'/proc/{d["server"]}/exe', previous)
        previous.chmod(0o700)
    for supervisor, stamp in d.get('supervisors', []):
        stop(supervisor, stamp)
    if d['server']:
        stop(d['server'], identity)
    active = STATE / f'web-fps-server-{time.time_ns()}'
    shutil.copy2(binary, active)
    process = start(active, env, STATE / 'server.log')
    try:
        ready(process, d['api'])
    except Exception:
        if process.poll() is None:
            stop(process.pid, process_identity(process.pid))
        if d['server']:
            rollback = start(previous, oldenv, STATE / 'rollback.log')
            ready(rollback, d['api'])
        raise
    if proxytext:
        proxyid = d['proxy_identity']
        stop(d['proxy'][0], proxyid)
        with (STATE / 'caddy.log').open('ab') as log:
            proxy = sp.Popen(['caddy', 'run', '--config', str(proxyconfig), '--adapter', 'caddyfile'], cwd=ROOT, stdin=sp.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        time.sleep(.5)
        if proxy.poll() is not None:
            with (STATE / 'caddy.log').open('ab') as log:
                sp.Popen(['caddy', 'run', '--config', d['proxy'][1], '--adapter', 'caddyfile'], stdin=sp.DEVNULL, stdout=log, stderr=log, start_new_session=True)
            raise RuntimeError('Caddy failed; attempted to restore its original config. See caddy.log.')
    (STATE / 'deployment.json').write_text(json.dumps(dict(env=env, web=d['web'])))
    print(f'Started server PID {process.pid}', flush=True)


def verify(d, browser=False, public=False):
    origin = f'https://127.0.0.1:{d["web"]}'
    body, headers = fetch(origin + '/city')
    headers = {k.lower(): v for k, v in headers.items()}
    if b'<html' not in body.lower() or headers.get('cross-origin-opener-policy') != 'same-origin' or headers.get('cross-origin-embedder-policy') not in ('require-corp', 'credentialless'):
        raise RuntimeError('SPA or cross-origin isolation headers missing')
    h = json.loads(fetch(origin + '/healthz')[0])
    if h.get('status') != 'ok' or h.get('physics_backend') != 'physx_gpu':
        raise RuntimeError('GPU server is not healthy')
    session = json.loads(fetch(origin + '/session-config?match_id=city-default')[0])
    expected = f'https://{d["ip"]}:{d["public_udp"]}/game'
    if session['url'] != expected:
        raise RuntimeError(f'Advertised URL mismatch: {session["url"]} != {expected}')
    certpath = d['env'].get('WT_CERT_PEM')
    if not certpath:
        raise RuntimeError('Running certificate path unknown; run status/up first')
    der = sp.check_output(['openssl', 'x509', '-in', certpath, '-outform', 'der'])
    if hashlib.sha256(der).hexdigest() != session['server_certificate_hash_hex']:
        raise RuntimeError('Certificate pin mismatch')
    certtext = run(['openssl', 'x509', '-in', certpath, '-noout', '-text'])
    if 'prime256v1' not in certtext:
        raise RuntimeError('WebTransport certificate is not P-256')
    dates = ssl._ssl._test_decode_cert(certpath)
    before, after = [ssl.cert_time_to_seconds(dates[k]) for k in ('notBefore', 'notAfter')]
    if not before <= time.time() < after or after - before > 14 * 86400:
        raise RuntimeError('Certificate expired, not yet valid, or exceeds 14 days')
    sp.run(['openssl', 'x509', '-in', certpath, '-checkip', d['ip'], '-noout'], check=True, stdout=sp.DEVNULL)
    manifest, _ = fetch(origin + '/city-manifest/' + session['city_manifest_hash'])
    if manifest[:4] != b'VLCM':
        raise RuntimeError('City manifest is not binary VLCM')
    report = dict(url=d['url'], health=h, manifest_bytes=len(manifest), certificate_expires=dates['notAfter'],
                  local_http='passed', public_https='not_checked', public_udp='not_verified', browser='not_requested')
    if public:
        # Explicit opt-in: a third party fetches the public health endpoint only.
        try:
            text = fetch('https://r.jina.ai/' + d['url'].replace('/city', '/healthz'))[0].decode()
            report['public_https'] = 'passed' if '"status":"ok"' in text and '"physics_backend":"physx_gpu"' in text else 'inconclusive'
        except Exception as e:
            report['public_https'] = 'inconclusive: ' + str(e)
    if browser:
        sp.run(['node', str(ROOT / 'scripts/vast-city-verify.mjs'), origin, str(d['udp']), str(STATE / 'browser.json')], cwd=ROOT / 'client', check=True, timeout=100)
        report['browser'] = json.loads((STATE / 'browser.json').read_text())
    (STATE / 'verification.json').write_text(json.dumps(report, indent=2))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('action', choices=['status', 'up', 'verify'], nargs='?', default='status')
    parser.add_argument('--blast-root', type=Path, default=Path(os.environ.get('BLAST_ROOT', ROOT.parent / 'blast-stress-solver-2/blast')))
    parser.add_argument('--rebuild', action='store_true')
    parser.add_argument('--browser', action='store_true', help='Bounded, low-resolution render/WT smoke test; does not shoot')
    parser.add_argument('--public', action='store_true', help='Ask r.jina.ai to fetch the public /healthz endpoint')
    args = parser.parse_args()
    os.umask(0o077)
    STATE.mkdir(parents=True, exist_ok=True)
    with (STATE / 'lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        d = discover()
        if args.action == 'status':
            print(json.dumps({k: d[k] for k in ('url', 'server', 'web', 'udp', 'api', 'public_udp')}, indent=2))
            return
        if args.action == 'up':
            blast = args.blast_root.resolve()
            if not (blast / 'source').is_dir():
                raise RuntimeError(f'Invalid BLAST_ROOT: {blast}')
            binary = build(blast, args.rebuild)
            d = discover()  # A reset or another deployment may finish while builds run.
            staged = STATE / 'client'
            if not d['server']:
                shutil.copytree(staged, ROOT / 'client/dist', dirs_exist_ok=True)
            deploy(d, binary)
            if staged.exists():
                # Keep old content-addressed assets for already open browser tabs.
                shutil.copytree(staged, ROOT / 'client/dist', dirs_exist_ok=True)
            d = discover()
        print(json.dumps(verify(d, args.browser, args.public), indent=2))


def serve(binary):
    # Keep the server available after /city-reset or an unexpected exit. The
    # parent handles SIGTERM and terminates only its own child on replacement.
    stopping = False
    child = None
    def shutdown(signum, frame):
        nonlocal stopping
        stopping = True
        if child is not None and child.poll() is None:
            child.terminate()
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    while not stopping:
        child = sp.Popen([binary])
        code = child.wait()
        print(f'[vast-city supervisor] server exited {code}', flush=True)
        for _ in range(30):
            if stopping:
                break
            time.sleep(.1)


if __name__ == '__main__':
    try:
        if len(sys.argv) == 3 and sys.argv[1] == '_serve':
            serve(sys.argv[2])
        else:
            main()
    except Exception as error:
        print(f'ERROR: {error}\nLogs/state: {STATE}', file=sys.stderr)
        sys.exit(1)
