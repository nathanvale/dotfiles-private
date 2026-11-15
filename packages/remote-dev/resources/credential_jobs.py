"""On-demand launchd ownership for the existing deployment CLI and native Git.

This is part of pilot-runtime, not a credential provider. It never reads a token.
Native Git and the deployment CLI retain credential delivery and replay fences.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shlex
import stat
import subprocess
import time


class Refused(RuntimeError):
    pass


def require(ok, message):
    if not ok:
        raise Refused(message)


def private_file(path, digest=None):
    path = Path(path)
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
            and not info.st_mode & 0o077, 'credential profile file custody refused')
    data = path.read_bytes()
    require(digest is None or hashlib.sha256(data).hexdigest() == digest,
            'credential profile revision changed')
    return data


def remaining(deadline):
    seconds = 120 if deadline is None else min(120, deadline - time.monotonic())
    require(seconds > 0, 'native first-cache readiness window expired')
    return seconds


def command(args, deadline=None):
    return subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, timeout=remaining(deadline), check=False)


def validate(a):
    data = private_file(a.credential_manifest, a.credential_manifest_sha256)
    manifest = json.loads(data)
    require(manifest['format'] == 1 and manifest['container'] == a.container,
            'credential profile targets another container')
    root = Path(a.credential_manifest).parent
    require(root.resolve() == root and root.stat().st_uid == os.getuid()
            and stat.S_IMODE(root.stat().st_mode) == 0o700,
            'credential profile directory custody refused')
    inputs = {row['path']: private_file(row['path'], row['sha256'])
              for row in manifest['inputs']}
    roles = {}
    for row in manifest['files']:
        job = plistlib.loads(private_file(row['path'], row['sha256']))
        require(row['role'] in ['cache', 'delivery'] and row['role'] not in roles,
                'credential job roles refused')
        require(job['Label'] == manifest['labels'][row['role']]
                and job['Label'].startswith('com.nathanvale.agents-pilot.')
                and job['KeepAlive'] is False and job['RunAtLoad'] is False
                and job['Umask'] == 63 and job['EnvironmentVariables']['SSH_AUTH_SOCK'] == '',
                'credential job policy changed')
        keys = {'Label', 'ProgramArguments', 'RunAtLoad', 'KeepAlive', 'Umask',
                'EnvironmentVariables', 'StandardOutPath', 'StandardErrorPath'}
        if row['role'] == 'delivery':
            keys.add('WorkingDirectory')
        require(set(job) == keys and job['EnvironmentVariables'] == {
            'HOME': str(Path.home()), 'PATH': '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
            'SSH_AUTH_SOCK': ''}, 'credential job launch properties refused')
        for key in ['StandardOutPath', 'StandardErrorPath']:
            log = Path(job[key])
            require(log.parent == root and not log.is_symlink(), 'credential job log custody refused')
            if log.exists():
                info = log.lstat()
                require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                        and not info.st_mode & 0o077, 'credential job log custody refused')
        roles[row['role']] = (row, job)
    require(set(roles) == {'cache', 'delivery'}, 'credential job pair is missing')
    argv = roles['delivery'][1]['ProgramArguments']
    require(len(argv) == 10 and argv[:2] == ['/usr/bin/caffeinate', '-dimsu']
            and argv[3] == '--no-env-file' and argv[5:8] == ['credential', 'serve', '--config']
            and argv[9] == '--json', 'credential job command changed')
    recipe = json.loads(inputs[argv[8]])
    require(recipe['bitbucketPolicy'] == 'refresh-while-running', 'credential cache policy changed')
    configs = {role: json.loads(inputs[recipe[role]]) for role in ['claude', 'codex', 'bitbucket']}
    expected = {'sshPath': a.ssh, 'sshHost': a.alias, 'dockerPath': a.docker,
                'dockerHost': a.endpoint, 'containerId': a.container,
                'uid': 1000, 'home': '/home/agent'}
    require(all(c['transport'] == expected for c in configs.values()),
            'credential transport binding changed')
    checkout = Path(roles['delivery'][1]['WorkingDirectory'])
    head = command(['/usr/bin/git', '-C', str(checkout), 'rev-parse', 'HEAD'])
    dirty = command(['/usr/bin/git', '-C', str(checkout), 'status', '--porcelain', '--untracked-files=no'])
    require(head.returncode == dirty.returncode == 0
            and head.stdout.decode().strip() == manifest['base_source'] and not dirty.stdout,
            'deployment source revision changed')
    require(Path(argv[4]) == checkout / 'src/cli.ts', 'credential job source changed')
    cache = configs['bitbucket']
    native = [a.docker, '--host', a.endpoint, 'exec', '-i', '--user', '1000',
              '--env', 'HOME=/home/agent', a.container, cache['cache']['gitPath'],
              'credential-cache--daemon', cache['cache']['socket']]
    require(roles['cache'][1]['ProgramArguments'] ==
            [a.ssh, '-o', 'ForwardAgent=no', '-o', 'BatchMode=yes', '-T', a.alias, shlex.join(native)],
            'native cache job command changed')
    return root, roles, configs, checkout


def jobs(labels, deadline=None):
    uid = command(['/bin/launchctl', 'manageruid'], deadline)
    require(uid.returncode == 0 and uid.stdout.decode().strip() == str(os.getuid()),
            'launchd user context is unavailable')
    manager = command(['/bin/launchctl', 'managername'], deadline)
    require(manager.returncode == 0 and manager.stdout.decode().strip() == 'Aqua',
            'credential jobs require the selected GUI login domain')
    listing = command(['/bin/launchctl', 'list'], deadline)
    require(listing.returncode == 0, 'launchd inventory is unavailable')
    found = {}
    # The installed launchctl manual documents these legacy three columns.
    # Never parse print/procinfo: their output explicitly is not an API.
    for line in listing.stdout.decode().splitlines():
        fields = line.split()
        if len(fields) != 3 or fields[2] not in labels:
            continue
        require(fields[2] not in found and (fields[0] == '-' or fields[0].isdecimal()),
                'launchd job identity is inconsistent')
        found[fields[2]] = None if fields[0] == '-' else int(fields[0])
    return found


def same_process(pid, argv, deadline=None):
    if not isinstance(pid, int) or pid < 1:
        return False
    seen = command(['/bin/ps', '-ww', '-p', str(pid), '-o', 'uid=', '-o', 'args='], deadline)
    values = seen.stdout.decode().strip().split(None, 1)
    return seen.returncode == 0 and len(values) == 2 and values == [str(os.getuid()), ' '.join(argv)]


def observe(a, configs, checkout, deadline=None):
    cache = configs['bitbucket']
    source = (checkout / 'packages/credential-delivery/git_cache.py').read_text()
    # Reuse the exact installed sender inspector. No get/store, owner lookup,
    # environment read or socket connection occurs in this observation.
    body = "namespace={'__name__':'credential_inspector'}\nexec(" + repr(source) + ",namespace)\n" + r'''
import json,os,pathlib,socket,stat,subprocess,sys
c=json.loads(sys.argv[1]);sender=json.loads(sys.argv[2]);cache=c['cache']
assert os.getuid()==c['transport']['uid'] and socket.gethostname()==cache['hostname']
parent=pathlib.Path(cache['socket']).parent;info=parent.lstat()
assert parent.resolve()==parent and stat.S_ISDIR(info.st_mode) and info.st_uid==os.getuid() and stat.S_IMODE(info.st_mode)==0o700
namespace['repository'](c)
core=json.loads(subprocess.check_output([sender['hcPath'],'server','status','--json']))
assert core['core']['id']==sender['coreId']
events=[]
for p in pathlib.Path('/proc').iterdir():
 if not p.name.isdecimal():continue
 try:
  if p.stat().st_uid==os.getuid():
   args=p.joinpath('cmdline').read_bytes().rstrip(b'\0').decode().split('\0')
   if args==[sender['hcPath'],'events','--label','herdr.credential=waiting','--json']:events.append(int(p.name))
 except (FileNotFoundError,ProcessLookupError):pass
present=os.path.lexists(cache['socket'])
proof=namespace['inspect'](c) if present else None
print(json.dumps({'cachePresent':present,'proof':proof,'eventListeners':events}))
'''
    config = {'transport': {'uid': 1000}, 'cache': cache['cache']}
    words = [a.docker, '--host', a.endpoint, 'exec', '-i', '--user', '1000', '--env',
             'HOME=/home/agent', a.container, cache['cache']['pythonPath'], '-I', '-c', body,
             json.dumps(config), json.dumps(configs['claude']['container'])]
    r = command([a.ssh, '-o', 'ForwardAgent=no', '-o', 'BatchMode=yes', '-T', a.alias,
                 shlex.join(words)], deadline)
    require(r.returncode == 0, 'native credential readiness inspection failed')
    return json.loads(r.stdout)


def write_owner(path, value):
    temp = path.with_name(path.name + '.' + str(os.getpid()))
    with temp.open('x', encoding='utf8') as f:
        os.chmod(temp, 0o600)
        json.dump(value, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp, path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def lease_ready(configs, since=None):
    path = Path(configs['bitbucket']['stateDirectory']) / 'cache-lease.journal.jsonl'
    if not path.exists():
        return False
    rows = [json.loads(x) for x in private_file(path).decode().splitlines() if x]
    return bool(rows and rows[-1].get('phase') == 'completed'
                and rows[-1].get('effectId') == 'effect.git-cache-lease'
                and 0 <= time.time() - path.stat().st_mtime < 900
                and (since is None or path.stat().st_mtime >= since))


def snapshot_matches(row):
    path = Path(row['path'])
    if row['sha256'] is None:
        require(not os.path.lexists(path), 'unreviewed prior outcome appeared')
    else:
        private_file(path, row['sha256'])


def admit_prior_outcomes(a, root, roles, configs, checkout):
    # This is an explicit, revision-bound operator admission, not a new token
    # replay fence. The pinned sender's journal owner still decides pending state.
    admission = json.loads(private_file(a.credential_manifest, a.credential_manifest_sha256))['priorOutcomes']
    require(admission['decision'] == 'reviewed-new-owner', 'prior outcomes require operator review')
    result_row = admission['result']
    prior = json.loads(private_file(result_row['path'], result_row['sha256']))['result']
    require(prior['commandIdentity'] == 'deployment.credential-serve'
            and prior['outcome'] in ['success', 'failed', 'refused']
            and prior['transactionState'] in ['completed', 'unchanged']
            and prior['effects']['inventoryComplete'] is True
            and not prior['effects']['uncertain'], 'prior delivery outcome is unresolved')
    directories = {c['stateDirectory'] for c in configs.values()}
    rows = admission['states']
    require(len(rows) == len(directories) == 3 and {r['path'] for r in rows} == directories,
            'prior journal owners changed')
    for row in rows:
        path = Path(row['path'])
        info = path.lstat()
        require(path.resolve() == path and stat.S_ISDIR(info.st_mode)
                and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700,
                'prior journal directory custody refused')
        files = row['files']
        require(len(files) == len({f['name'] for f in files})
                and {p.name for p in path.iterdir()} == {f['name'] for f in files},
                'prior journal inventory changed')
        for f in files:
            require(Path(f['name']).name == f['name'], 'prior journal path refused')
            private_file(path / f['name'], f['sha256'])
    expected = {str(root / 'restore-result.json')} | {
        roles['delivery'][1][k] for k in ['StandardOutPath', 'StandardErrorPath']}
    require(len(admission['logs']) == len(expected)
            and {r['path'] for r in admission['logs']} == expected, 'prior result inventory changed')
    for row in admission['logs']:
        snapshot_matches(row)
    # Reuse the exact pinned native journal reader. No claim, resolve, store or
    # token acquisition is performed. Locks and pending intents refuse startup.
    script = ("import { readdir } from 'node:fs/promises';import { join } from 'node:path';"
              + 'import { pendingJournalIntent } from ' + json.dumps((checkout / 'src/journal.ts').as_uri()) + ';'
              + 'for (const dir of ' + json.dumps(sorted(directories)) + ') {'
              + "for (const name of await readdir(dir)) {if(name.endsWith('.journal.lock'))process.exit(1);"
              + "if(name.endsWith('.journal.jsonl') && await pendingJournalIntent(join(dir,name.slice(0,-14))))process.exit(1);}}")
    bun = roles['delivery'][1]['ProgramArguments'][2]
    require(command([bun, '--no-env-file', '--eval', script]).returncode == 0,
            'native prior journal owner requires inspection')


def probe_ready(a, root, roles, configs, checkout, listing, seen):
    record_path = root / 'owned-jobs.json'
    records = json.loads(private_file(record_path)) if record_path.exists() else {}
    verified = all(records.get(role, {}).get('sha256') == row['sha256']
                   and records.get(role, {}).get('pid') == listing.get(job['Label'])
                   and same_process(listing.get(job['Label']), job['ProgramArguments'])
                   for role, (row, job) in roles.items())
    return {'credentials': bool(verified and seen['cachePresent']
                                and len(seen['eventListeners']) == 2 and lease_ready(configs)),
            'credentialsChanged': False, 'credentialEffects': {'completed': [], 'uncertain': []}}


def restore(a, bundle, probe=False):
    root, roles, configs, checkout = bundle
    effects = {'completed': [], 'uncertain': []}
    attempted = False
    deadline = None
    outcome_path = root / 'restore-result.json'

    def result(ready, error=None):
        return {'credentials': ready, 'credentialsChanged': bool(effects['completed']),
                'credentialEffects': {k: sorted(v) for k, v in effects.items()},
                'attempted': attempted, **({} if ready else {'status': 'failed', 'error': error})}

    def effect(name, argv):
        nonlocal attempted
        remaining(deadline)
        effects['uncertain'].append(name)
        # Persist intent before each native actuation. A crash cannot erase an
        # uncertain registration/start merely because no PID was returned.
        write_owner(outcome_path, result(False, 'credential startup in progress'))
        attempted = True
        reply = command(argv, deadline)
        require(reply.returncode == 0, 'credential job outcome requires inspection')
        return reply

    def completed(name):
        effects['uncertain'].remove(name)
        effects['completed'].append(name)
        write_owner(outcome_path, result(False, 'credential startup in progress'))

    try:
        listing = jobs([job['Label'] for _, job in roles.values()])
        seen = observe(a, configs, checkout)
        if probe:
            return probe_ready(a, root, roles, configs, checkout, listing, seen)
        lock = os.open(root / 'restore.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(lock, 'r+') as held:
            meta = os.fstat(held.fileno())
            require(meta.st_uid == os.getuid() and stat.S_IMODE(meta.st_mode) == 0o600,
                    'credential startup lock custody refused')
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            record_path = root / 'owned-jobs.json'
            require(not record_path.is_symlink(), 'credential ownership record custody refused')
            records = json.loads(private_file(record_path)) if record_path.exists() else {}
            started_at = time.time()
            admitted = False
            if outcome_path.exists():
                prior_startup = json.loads(private_file(outcome_path))
                if prior_startup.get('credentials') is not True:
                    admit_prior_outcomes(a, root, roles, configs, checkout)
                    admitted = True
            for role in ['cache', 'delivery']:
                row, job = roles[role]
                label = job['Label']
                listing = jobs([label], deadline)
                if label in listing:
                    old = records.get(role, {})
                    require(old.get('sha256') == row['sha256'] and old.get('pid') == listing[label]
                            and same_process(listing[label], job['ProgramArguments'], deadline),
                            'existing or stopped credential job requires operator inspection')
                    if role == 'cache':
                        require(observe(a, configs, checkout, deadline)['cachePresent'],
                                'existing cache owner is not ready')
                    continue
                seen = observe(a, configs, checkout, deadline)
                require(not seen['cachePresent'] if role == 'cache' else not seen['eventListeners'],
                        'unowned native credential processes require inspection')
                if not admitted:
                    admit_prior_outcomes(a, root, roles, configs, checkout)
                    admitted = True
                effect('registered:' + role, ['/bin/launchctl', 'bootstrap', 'gui/' + str(os.getuid()), row['path']])
                completed('registered:' + role)
                records[role] = {'sha256': row['sha256'], 'pid': None}
                write_owner(record_path, records)
                # Conservative: count from before the cache can be launched,
                # never from observation or from the delivery job's startup.
                if role == 'cache':
                    deadline = time.monotonic() + 30
                r = effect('started:' + role, ['/bin/launchctl', 'kickstart', '-p', 'gui/' + str(os.getuid()) + '/' + label])
                require(r.stdout.strip().isdigit(), 'credential job startup requires inspection')
                pid = int(r.stdout)
                require(same_process(pid, job['ProgramArguments'], deadline), 'credential process identity mismatch')
                remaining(deadline)
                records[role]['pid'] = pid
                write_owner(record_path, records)
                completed('started:' + role)
                if role == 'cache':
                    while True:
                        seen = observe(a, configs, checkout, deadline)
                        remaining(deadline)
                        if seen['cachePresent']:
                            break
                        require(same_process(pid, job['ProgramArguments'], deadline),
                                'native cache did not become ready')
                        time.sleep(min(0.2, remaining(deadline)))
            # Reused healthy owners get a readiness observation budget; a newly
            # launched cache always retains its original, unextended deadline.
            if deadline is None:
                deadline = time.monotonic() + 30
            while True:
                remaining(deadline)
                for role, (_, job) in roles.items():
                    require(same_process(records[role]['pid'], job['ProgramArguments'], deadline),
                            'credential owner stopped during readiness')
                seen = observe(a, configs, checkout, deadline)
                ready = lease_ready(configs, started_at if effects['completed'] else None)
                remaining(deadline)
                if seen['cachePresent'] and len(seen['eventListeners']) == 2 and ready:
                    outcome = result(True)
                    if attempted or admitted:
                        write_owner(outcome_path, outcome)
                    remaining(deadline)
                    return outcome
                time.sleep(min(0.2, remaining(deadline)))
    except Exception as e:
        outcome = result(False, str(e) if isinstance(e, Refused) else 'credential startup needs inspection')
        if attempted:
            try:
                write_owner(outcome_path, outcome)
            except Exception:
                # The pre-effect intent remains the conservative recovery record.
                pass
        return outcome
