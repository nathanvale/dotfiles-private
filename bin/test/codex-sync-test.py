#!/usr/bin/env python3
"""Process proof for shared setup, using a native-command double only for installs."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import tomllib
import unittest

REPO = Path(__file__).resolve().parents[2]
FAKE_CODEX = r'''#!/usr/bin/env python3
import json,os,pathlib,subprocess,sys,tomllib
h=pathlib.Path(os.environ['HOME']);cfg=h/'.codex/config.toml';state=h/'native-plugins.json'
args=sys.argv[1:]
if args==['--version']:print('codex-cli 0.162.0');sys.exit(0)
d=tomllib.loads(cfg.read_text()) if cfg.exists() else {}
installed=json.loads(state.read_text()) if state.exists() else []
if args[:2]==['plugin','list']:print(json.dumps({'installed':installed}));sys.exit(0)
if os.environ.get('SYNC_TEST_FAIL') and args[:2]==['plugin','add']:
 print('secret-native-stderr',file=sys.stderr);sys.exit(41)
if args[:3]==['plugin','marketplace','add']:
 source=args[3];name='personal' if '/config/agents/plugins' in source else 'compound-engineering-plugin'
 value={'source_type':'local' if name=='personal' else 'git','source':source}
 if '--ref' in args:value['ref']=args[args.index('--ref')+1]
 d.setdefault('marketplaces',{})[name]=value
elif args[:2]==['plugin','add']:
 selector=args[2];versions={'personal@personal':'0.4.0','connectors@personal':'0.7.0','proof@personal':'0.1.0','my-second-brain-playground@personal':'0.17.5','compound-engineering@compound-engineering-plugin':'3.24.0'}
 installed=[p for p in installed if p['pluginId']!=selector]+[{'pluginId':selector,'version':versions[selector],'enabled':True}]
 d.setdefault('plugins',{})[selector]={'enabled':True}
else:sys.exit(42)
text=subprocess.check_output(['bun','-e','process.stdout.write(Bun.TOML.stringify(JSON.parse(await Bun.stdin.text())))'],input=json.dumps(d),text=True)
cfg.write_text(text);state.write_text(json.dumps(installed));print('{}')
'''


class SyncProcessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / 'home'
        self.root = Path(self.tmp.name) / 'dotfiles'
        self.home.mkdir();self.root.mkdir()
        for file in ('setup.sh','bin/dotfiles/codex_sync.py','config/agents/codex/shared.toml'):
            dst=self.root/file;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(REPO/file,dst)
        for name in ('personal','connectors','proof','my-second-brain-playground'):
            file=Path('config/agents/plugins')/name/'.codex-plugin/plugin.json'
            dst=self.root/file;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(REPO/file,dst)
        self.binary=self.home/'.codex/packages/standalone/current/bin/codex'
        self.binary.parent.mkdir(parents=True);self.binary.write_text(FAKE_CODEX);self.binary.chmod(0o700)
        self.cfg=self.home/'.codex/config.toml'
        self.original='''# Local settings and credentials must survive semantically.
model = "gpt-5.6-sol"
model_reasoning_effort = "low"
notify = ["/different/home/local-notify"]
[features]
memories = false
[mcp_servers.local]
command = "/local/bin/mcp"
env = { TEST_TOKEN = "private-marker" }
[projects."/local/project"]
trust_level = "trusted"
[plugins."unrelated@local"]
enabled = false
'''
        self.cfg.write_text(self.original)
        self.env={**os.environ,'HOME':str(self.home),'CODEX_HOME':str(self.home/'.codex'),'XDG_STATE_HOME':str(self.home/'.local/state')}
        self.env.pop('DOTFILES_PROFILE',None)

    def tearDown(self):self.tmp.cleanup()

    def invoke(self,*args,expected=0,extra=None):
        result=subprocess.run(['bash',str(self.root/'setup.sh'),'codex',*args,'--json'],env={**self.env,**(extra or {})},text=True,capture_output=True,timeout=45)
        self.assertEqual(result.returncode,expected,(result.stdout,result.stderr))
        self.assertEqual(result.stderr,'')
        self.assertNotIn('private-marker',result.stdout)
        self.assertNotIn('secret-native-stderr',result.stdout)
        return json.loads(result.stdout)

    def test_preview_does_not_write_any_state(self):
        reply=self.invoke('--preview')
        self.assertEqual(reply['status'],'drift');self.assertEqual(reply['effects'],'none')
        self.assertEqual(self.cfg.read_text(),self.original)
        self.assertFalse((self.home/'.local/state').exists())
        self.assertFalse((self.home/'.dotfiles_state').exists())
        self.assertFalse((self.home/'native-plugins.json').exists())

    def test_apply_preserves_local_settings_and_is_repeatable(self):
        reply=self.invoke('--apply');self.assertEqual(reply['status'],'synced')
        after=tomllib.loads(self.cfg.read_text())
        self.assertEqual(after['model'],'gpt-6.1-sol');self.assertEqual(after['model_reasoning_effort'],'high')
        self.assertEqual(after['features'],{'memories':False,'hooks':True})
        before=tomllib.loads(self.original)
        for key in ('mcp_servers','projects','notify'):self.assertEqual(after[key],before[key])
        self.assertEqual(after['plugins']['unrelated@local'],{'enabled':False})
        native=json.loads((self.home/'native-plugins.json').read_text())
        self.assertEqual({p['pluginId'] for p in native},{'personal@personal','connectors@personal','proof@personal','my-second-brain-playground@personal','compound-engineering@compound-engineering-plugin'})
        backup=Path(reply['backup'])/'config.toml.before'
        self.assertEqual(backup.read_text(),self.original);self.assertEqual(backup.stat().st_mode & 0o777,0o600)
        text=self.cfg.read_text();self.assertEqual(self.invoke('--apply')['status'],'synced');self.assertEqual(self.cfg.read_text(),text)
        self.assertEqual(self.invoke('--check')['status'],'synced')

    def test_native_failure_is_partial_and_private(self):
        reply=self.invoke('--apply',expected=1,extra={'SYNC_TEST_FAIL':'1'})
        self.assertEqual(reply['effects'],'partial');self.assertEqual(reply['status'],'error')
        self.assertEqual((Path(reply['backup'])/'config.toml.before').read_text(),self.original)
        self.assertEqual(tomllib.loads(self.cfg.read_text())['mcp_servers']['local']['env']['TEST_TOKEN'],'private-marker')

    def test_check_returns_failure_for_missing_plugins(self):
        reply=self.invoke('--check',expected=1)
        self.assertEqual(reply['status'],'drift');self.assertEqual(len(reply['drift']['plugins']),5)

    def test_symlink_config_is_refused(self):
        original=self.home/'original.toml';self.cfg.rename(original);self.cfg.symlink_to(original)
        reply=self.invoke('--apply',expected=1);self.assertEqual(reply['effects'],'none')
        self.assertEqual(original.read_text(),self.original)

    def test_shared_permissions_are_refused_before_mutation(self):
        declaration=self.root/'config/agents/codex/shared.toml'
        declaration.write_text(declaration.read_text().replace('[config]','[config]\nsandbox_mode = "danger-full-access"'))
        reply=self.invoke('--apply',expected=1);self.assertEqual(reply['effects'],'none')
        self.assertEqual(self.cfg.read_text(),self.original)


if __name__=='__main__':unittest.main(verbosity=2)
