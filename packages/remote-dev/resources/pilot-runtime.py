#!/usr/bin/python3
"""Reuse the pilot's native startup and existing credential delivery owner."""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

CONTAINER = r'''
import fcntl,json,os,pathlib,subprocess,sys,time,urllib.request,urllib.error
os.umask(0o077)
ROOT=pathlib.Path('/home/agent/.local/state/pilot-runtime/remote-dev')
HOME='/home/agent'
WEB='/home/agent/.local/share/shepherdr/service/main.ts'
ENV={'HOME':HOME,'PATH':'/opt/node/bin:/opt/bun:/opt/agent-tools/node_modules/.bin:/home/agent/.local/bin:/usr/local/bin:/usr/bin:/bin','CLAUDE_CONFIG_DIR':HOME+'/.claude','CODEX_HOME':HOME+'/.codex','SHEPHERDR_HC':'/usr/local/bin/hc','SHEPHERDR_JOBS':'off','SHEPHERDR_WEB':'on','DISABLE_AUTOUPDATER':'1'}
for key in ['AGENT_BROWSER_EXECUTABLE_PATH','PLAYWRIGHT_BROWSERS_PATH','PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD']:
 if key in os.environ:ENV[key]=os.environ[key]
started=[]
attempted=False

def command(args):
 return subprocess.run(args,env=ENV,capture_output=True,text=True,timeout=15)

def pids():
 found={'core':[],'tailscale':[],'shepherdr':[]}
 for p in pathlib.Path('/proc').iterdir():
  if not p.name.isdigit():continue
  try:
   a=p.joinpath('cmdline').read_bytes().split(b'\0');a=[x.decode() for x in a if x]
   if a[:2]==['/usr/local/bin/herdr-core','serve']:found['core'].append(int(p.name))
   if a and a[0]=='/usr/local/bin/tailscaled':found['tailscale'].append(int(p.name))
   if a[:2]==['/opt/bun/bun',WEB]:found['shepherdr'].append(int(p.name))
  except (OSError,UnicodeError):pass
 return found

def health():
 try:
  with urllib.request.build_opener(urllib.request.ProxyHandler({})).open('http://127.0.0.1:7788/api/health',timeout=2) as r:return json.load(r)
 except urllib.error.HTTPError:raise RuntimeError('unexpected response on the local web service port')
 except OSError:return None

def tailstate():
 p=command(['/usr/local/bin/tailscale','status','--json'])
 try:return json.loads(p.stdout).get('BackendState') if p.returncode==0 else None
 except ValueError:return None

def snapshot():
 ps=pids();h=health();ts=tailstate()
 if any(len(v)>1 for v in ps.values()):raise RuntimeError('duplicate native service processes')
 if ps['tailscale'] and ts in ['NeedsLogin','NeedsMachineAuth','Stopped']:raise RuntimeError('retained Tailscale identity is not ready; no sign-in attempted')
 if h is not None and (not ps['shepherdr'] or h.get('app')!='shepherdr' or h.get('version')!=sys.argv[2] or h.get('jobs') is not False):raise RuntimeError('unexpected web service identity, version or Jobs policy')
 ready=all(ps.values()) and h is not None and all(h.get(k) is True for k in ['ok','core','serving','reachable']) and ts=='Running'
 return {'status':'ready' if ready else 'missing','core':bool(ps['core']),'processes':ps,'tailscale':ts,'version':h.get('version') if h else None}

def preconditions():
 log=pathlib.Path(sys.argv[3]);base=pathlib.Path('/home/agent/.local/state/pilot-runtime')
 if log.is_symlink() or not log.resolve().is_relative_to(base.resolve()) or not log.parent.is_dir() or log.name!='service.log':raise RuntimeError('unexpected service log owner')
 for name in ['/home/agent/.local/state/shepherdr/service/token','/state/tailscale/tailscaled.state',WEB]:
  if not pathlib.Path(name).is_file():raise RuntimeError('retained service state or installed source is missing')
 if json.loads(pathlib.Path(WEB).parent.parent.joinpath('package.json').read_text()).get('version')!=sys.argv[2]:raise RuntimeError('unexpected installed Shepherdr version')
 p=command(['/usr/local/bin/hc','--version'])
 if p.returncode!=0 or p.stdout.strip().split()[-1:]!=['0.1.20']:raise RuntimeError('unexpected Core version')

def wait(check,message):
 for _ in range(75):
  if check():return
  time.sleep(1)
 raise RuntimeError(message)

def start_program(name,args):
 global attempted
 attempted=True
 with (pathlib.Path(sys.argv[3]) if name=='shepherdr' else ROOT/(name+'.log')).open('ab',buffering=0) as log:
  p=subprocess.Popen(args,env=ENV,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
 started.append(name)
 return p

def restore():
 global attempted
 ROOT.mkdir(mode=0o700,parents=True,exist_ok=True)
 with (ROOT/'restore.lock').open('a') as lock:
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:raise RuntimeError('another restore is in progress')
  s=snapshot()
  if s['status']=='ready':return s
  preconditions()
  if not s['core']:
   if not os.environ.get('CLAUDE_CODE_OAUTH_TOKEN'):raise RuntimeError('existing Core credential delivery is required')
   attempted=True
   e={**ENV,'CLAUDE_CODE_OAUTH_TOKEN':os.environ['CLAUDE_CODE_OAUTH_TOKEN']}
   p=subprocess.run(['/usr/local/bin/hc','server','start','--json'],env=e,capture_output=True,text=True,timeout=90)
   if p.returncode!=0:raise RuntimeError('native Core startup failed')
   started.append('core')
   servers=pids()['core']
   if not servers or not all(any(x.startswith(b'CLAUDE_CODE_OAUTH_TOKEN=') and len(x)>24 for x in pathlib.Path('/proc',str(pid),'environ').read_bytes().split(b'\0')) for pid in servers):raise RuntimeError('Core did not retain the existing credential delivery')
  if not s['processes']['tailscale']:
   start_program('tailscale',['/usr/local/bin/tailscaled','--tun=userspace-networking','--statedir=/state/tailscale','--socket=/var/run/tailscale/tailscaled.sock'])
  wait(lambda:tailstate()=='Running','retained Tailscale login is not ready; no sign-in attempted')
  if not s['processes']['shepherdr']:start_program('shepherdr',['/opt/bun/bun',WEB])
  wait(lambda:snapshot()['status']=='ready','native web service did not become ready')
  return snapshot()
try:
 s=snapshot() if sys.argv[1]=='probe' else restore()
 result={**s,'started':started,'attempted':attempted}
 if started:ROOT.joinpath('runtime.json').write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps(result))
except Exception as e:
 print(json.dumps({'status':'failed','error':str(e) if isinstance(e,RuntimeError) else type(e).__name__,'started':started,'attempted':attempted}))
 sys.exit(1)
'''


def options():
    p = argparse.ArgumentParser()
    p.add_argument('action', choices=['probe', 'restore', 'deliver'])
    p.add_argument('--service-log', default='/home/agent/.local/state/pilot-runtime/remote-dev/service.log')
    for key in ['ssh', 'alias', 'docker', 'endpoint', 'container', 'version', 'wrapper', 'reference']:
        p.add_argument('--' + key, required=True)
    a = p.parse_args()
    if not re.fullmatch('[a-f0-9]{64}', a.container):
        p.error('full container identity required')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', a.alias):
        p.error('invalid SSH alias')
    return a


def remote(a, action, secret=None):
    args = [a.docker, '--host', a.endpoint, 'exec', '--user', '1000:1001']
    if secret is not None:
        args += ['--env-file', '/dev/stdin']
    args += [a.container, '/usr/bin/python3', '-I', '-c', CONTAINER, action, a.version, a.service_log]
    ssh = [a.ssh, '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '--', a.alias, shlex.join(args)]
    return subprocess.run(ssh, input=secret, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=240)


def emit(p):
    try:
        data = json.loads(p.stdout)
        if not isinstance(data, dict) or data.get('status') not in ['ready', 'missing', 'failed']:
            raise ValueError()
    except ValueError:
        data = {'status': 'failed', 'attempted': True, 'started': [], 'error': 'remote restore result is unknown'}
    print(json.dumps(data))
    return 0 if p.returncode == 0 and data.get('status') != 'failed' else 1


def main():
    a = options()
    if a.action == 'deliver':
        secret = sys.stdin.buffer.read(65537)
        if not 1 <= len(secret) <= 65536 or any(x in secret for x in (0, 10, 13)):
            print(json.dumps({'status': 'failed', 'attempted': False, 'error': 'credential shape refused', 'started': []}))
            return 1
        return emit(remote(a, 'restore', b'CLAUDE_CODE_OAUTH_TOKEN=' + secret + b'\n'))
    probe = remote(a, 'probe')
    try:
        s = json.loads(probe.stdout)
        if not isinstance(s, dict) or s.get('status') not in ['ready', 'missing', 'failed'] or not isinstance(s.get('core'), bool) and s.get('status') != 'failed':
            raise ValueError()
    except ValueError:
        return emit(probe)
    if a.action == 'probe' or probe.returncode != 0 or s.get('status') == 'ready':
        return emit(probe)
    if s.get('core') is True:
        return emit(remote(a, 'restore'))
    argv = [sys.executable, str(Path(__file__).resolve()), 'deliver', *sys.argv[2:]]
    p = subprocess.run([a.wrapper, 'inject-stdin', a.reference, '--', *argv], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=240)
    if not p.stdout:
        p = subprocess.CompletedProcess([], 1, json.dumps({'status': 'failed', 'attempted': False, 'error': 'existing credential owner refused delivery; run with-one-password-token check', 'started': []}).encode())
    return emit(p)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, subprocess.TimeoutExpired):
        print(json.dumps({'status': 'failed', 'attempted': True, 'error': 'restore transport failed; inspect before retrying', 'started': []}))
        raise SystemExit(1)
