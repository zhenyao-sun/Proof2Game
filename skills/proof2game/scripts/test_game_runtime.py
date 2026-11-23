"""Recipient-side game HTTP, progression, durability and bridge protocol regression tests.

A controlled command-line executable replaces Codex here; these tests do not
claim real model availability or mathematical quality.
"""
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import threading
import time

RUNTIME = Path(__file__).resolve().parents[1] / 'assets/game-runtime/server.mjs'
RUNTIME_MODULES = ('guide-diagram.mjs', 'level-tree.mjs')

FAKE_CLI = r'''#!/usr/bin/env python3
import json, os, pathlib, sys, time
args=sys.argv[1:]
if args==['--version']:
    print('codex-cli controlled-test');sys.exit(0)
if args==['exec','--help']:
    print('--ignore-user-config --output-schema --ephemeral --image');sys.exit(0)
if args==['login','status']:
    if os.environ.get('FAKE_LOGIN_CONFIG_ERROR'):
        print('Error loading configuration: config.toml: invalid type',file=sys.stderr);sys.exit(1)
    print('Logged in');sys.exit(0)
assert args[0]=='exec' and '--ignore-user-config' in args and '--ephemeral' in args
assert args[args.index('--model')+1]=='gpt-6.1-terra'
assert args[args.index('-c')+1]=='model_reasoning_effort="medium"'
assert args[args.index('--sandbox')+1]=='read-only'
prompt=sys.stdin.read()
ctx=json.loads(prompt.split('CONTEXT DATA:\n')[1])
assert ctx['language'] in ['English', '中文']
assert 'original English manuscript' in prompt
assert ('temporary symbol' in prompt)==(ctx.get('mode')=='guide')
with open('calls.jsonl','a') as f:f.write(json.dumps(ctx)+'\n')
if ctx['player_message']=='SLOW' or (
    ctx['player_message']=='SWITCH' and ctx['language']=='English'
):time.sleep(2)
if os.environ.get('FAKE_DELAY_UNDERSTAND') and ctx['action']=='understand':time.sleep(.7)
pathlib.Path('last-prompt.json').write_text(json.dumps(ctx))
pathlib.Path('last-args.json').write_text(json.dumps(args))
if ctx['player_message']=='FAIL' or (ctx['action']=='understand' and pathlib.Path('fail-next-passage').is_file()):
    print(json.dumps({'type':'error','message':'Synthetic provider failure'}));sys.exit(1)
phase='goal_confirmation' if ctx['action']=='understand' else 'step'
u={'kind':'none','scope':'partial','description':'','quote':''}
msg=ctx['player_message'] or ''
if msg=='I understand B, but B is unconvincing.':u={'kind':'confirm','scope':'partial','description':'B','quote':msg}
if msg=='I actually did not understand B.':u={'kind':'correct','scope':'partial','description':'B','quote':msg}
if msg=='I understand this whole level.':u={'kind':'confirm','scope':'level','description':'The whole current level','quote':msg}
if msg=='UNBOUND':u={'kind':'confirm','scope':'level','description':'whole','quote':'I understand this whole level.'}
if msg=='MODEL COMPLETES':u={'kind':'confirm','scope':'level','description':'whole','quote':''}
if ctx['action']=='understand' and os.environ.get('FAKE_BUTTON_CONFIRMATION'):
    u={'kind':'confirm','scope':'level','description':'whole level','quote':'I understood this entire level.'}
answer={'message':'Welcome. A redesigned passage: \\(x=x\\).','phase':phase,'step_goal':('This level is clear; confirm the whole level when ready.' if phase=='goal_confirmation' else 'Do you understand this passage?'),'understanding':u}
u['level_id']=ctx['level']['id'] if u['kind']!='none' else None
if msg=='I understand another level.':u={'kind':'confirm','scope':'level','description':'Another level','quote':msg,'level_id':'b'}
if msg=='The entire Proof of Two even integers level is clear to me. I am confirming only that proof level. I am not confirming this Settings and Conventions level.':u={'kind':'confirm','scope':'level','description':'Only the proof, not the current level','quote':msg,'level_id':'pa'}
if msg=='Unknown level.':u={'kind':'confirm','scope':'level','description':'Unknown level','quote':msg,'level_id':'not-a-level'}
answer['understanding']=u
if ctx.get('mode')=='chat':answer={'message':'A response to your question.','understanding':u}
if ctx['language']=='中文':
    answer['message']='这一步给出等式 \(x=x\)。' if ctx.get('mode')=='guide' else '这是对你的问题的回答。'
    if ctx.get('mode')=='guide':answer['step_goal']='理解这一小步。'
schema=json.loads(pathlib.Path(args[args.index('--output-schema')+1]).read_text())
assert 'diagram' in schema['required']
answer['diagram']=None
if msg in ['Show this with a diagram.', 'Invalid diagram.', 'Draw a blueberry.']:
    answer['message']=''
    answer['diagram']={'alt':'Two points joined by an arrow.', 'elements':[
        {'kind':'line','x1':100,'y1':200,'x2':530,'y2':200,'arrow':True,'color':'ink'},
        {'kind':'label','x':100,'y':160,'text':'x < y','color':'blue'},
    ]}
    if msg=='Draw a blueberry.':
        answer['diagram']={'alt':'A blueberry.', 'elements':[
            {'kind':'circle','x':320,'y':200,'radius':75,'color':'blue'}
        ]}
    if msg=='Invalid diagram.':answer['diagram']['elements'][0]['x1']='0" onclick="alert(1)'
pathlib.Path(args[args.index('--output-last-message')+1]).write_text(json.dumps(answer))
print(json.dumps({'type':'turn.completed'}))
'''


@unittest.skipUnless(shutil.which('node'), 'Node.js is unavailable')
class GameRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='proof2game-test-')
        self.root = Path(self.temp.name)
        shutil.copyfile(RUNTIME, self.root/'server.mjs')
        for name in RUNTIME_MODULES:
            shutil.copyfile(RUNTIME.with_name(name), self.root/name)
        (self.root/'index.html').write_text('<html>game</html>')
        (self.root/'app.js').write_text('')
        (self.root/'style.css').write_text('')
        (self.root/'snapshot').mkdir()
        (self.root/'snapshot/main.tex').write_text('Snapshot manuscript content')
        self.game = {
            'schema': 1, 'id': 'test-game', 'title': 'Paper',
            'snapshot_digest': 'bound-snapshot', 'model': 'gpt-6.1-terra', 'reasoning_effort': 'medium',
            'snapshot_files': {'snapshot/main.tex': hashlib.sha256((self.root/'snapshot/main.tex').read_bytes()).hexdigest()},
            'manuscript': {'main': 'snapshot/main.tex', 'files': ['snapshot/main.tex']},
            'levels': [
                {'id': 'a', 'type': 'statement', 'paired': 'pa', 'text': 'A', 'title': 'A', 'order': 0},
                {'id': 'b', 'type': 'statement', 'paired': 'pb', 'text': 'B', 'title': 'B', 'order': 1},
                {'id': 'pa', 'type': 'proof', 'paired': 'a', 'text': 'Proof A', 'title': 'Proof A', 'order': 2},
                {'id': 'pb', 'type': 'proof', 'paired': 'b', 'text': 'Proof B', 'title': 'Proof B', 'order': 3},
            ],
        }
        (self.root/'game.json').write_text(json.dumps(self.game))
        cli = self.root/'fake-codex'
        cli.write_text(FAKE_CLI)
        cli.chmod(0o700)
        self.env = dict(os.environ, PROOF2GAME_CODEX=str(cli))
        self.proc = None
        self.start()

    def tearDown(self):
        self.stop()
        self.temp.cleanup()

    def start(self):
        self.proc = subprocess.Popen(['node', str(self.root/'server.mjs'), '--no-open'], cwd=self.root,
                                     env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        line = self.proc.stdout.readline()
        if not line:
            self.fail(self.proc.stderr.read())
        self.url = json.loads(line)['url']
        self.port = int(self.url.rsplit(':', 1)[1])
        status, headers, _ = self.call('GET', '/', authenticated=False)
        self.assertEqual(status, 200)
        self.cookie = headers['Set-Cookie'].split(';')[0]
        self.payload = self.get()

    def stop(self):
        if self.proc:
            self.proc.terminate()
            self.proc.communicate(timeout=10)
            self.proc = None

    def call(self, method, route, body=None, authenticated=True, origin=True):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        headers = {}
        if authenticated:
            headers['Cookie'] = self.cookie
        if body is not None:
            headers['Content-Type'] = 'application/json'
        if origin:
            headers['Origin'] = self.url
        connection.request(method, route, json.dumps(body) if body is not None else None, headers)
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def get(self):
        status, _, body = self.call('GET', '/api/game')
        self.assertEqual(status, 200)
        return json.loads(body)

    def action(self, action, level_id='a', **extra):
        request = {'action': action, 'level_id': level_id,
                   'expected_revision': self.payload['progress']['revision'], **extra}
        status, _, body = self.call('POST', '/api/action', request)
        result = json.loads(body)
        if status == 200:
            self.payload = result
        return status, result

    def enable_bilingual(self):
        self.stop()
        translation = self.root/'translation/zh'
        translation.mkdir(parents=True)
        files = []
        levels = {}
        for level in self.game['levels']:
            name = level['id']+'.tex'
            level['source_file'] = 'snapshot/'+name
            (self.root/level['source_file']).write_text(level['text'])
            self.game['snapshot_files'][level['source_file']] = hashlib.sha256(
                (self.root/level['source_file']).read_bytes()).hexdigest()
            file = translation/name
            file.write_text('这是一段中文原稿。')
            relative = file.relative_to(self.root).as_posix()
            files.append(relative)
            self.game['snapshot_files'][relative] = hashlib.sha256(file.read_bytes()).hexdigest()
            levels[level['id']] = dict(text=file.read_text(), title='陈述 '+level['id'])
        self.game['chinese'] = dict(title='论文', files=files, levels=levels)
        (self.root/'game.json').write_text(json.dumps(self.game))
        self.start()

    def choose_guide(self):
        self.assertEqual(self.action('mode', mode='guide')[0], 200)

    def finish(self, level):
        self.assertEqual(self.action('mode', level, mode='guide')[0], 200)
        for action in ['start', 'understand', 'complete']:
            self.assertEqual(self.action(action, level)[0], 200)

    def test_legacy_game_keeps_english_without_chinese_snapshot(self):
        self.assertEqual(self.payload['progress']['language'], 'English')
        self.assertEqual(self.payload['progress']['revision'], 0)
        self.assertEqual(self.payload['progress']['levels'], {})
        self.assertFalse((self.root/'player-save.json').exists())
        before = self.get()['progress']
        self.assertEqual(self.action('language', language='中文')[0], 400)
        self.assertEqual(self.get()['progress'], before)
        self.assertEqual(self.action('message', message='What is the statement?')[0], 200)
        self.assertEqual(self.calls()[-1]['language'], 'English')
        self.choose_guide()
        self.assertEqual(self.action('start')[0], 200)
        self.assertEqual(self.calls()[-1]['language'], 'English')

    def test_bilingual_switch_preserves_progress_and_history_and_survives_restart(self):
        self.enable_bilingual()
        self.assertEqual(self.payload['progress']['language'], 'English')
        self.assertFalse((self.root/'player-save.json').exists())
        self.action('start')
        self.action('understand')
        self.action('understand_all')
        self.action('mode', mode='chat')
        self.action('message', message='An English question')
        self.assertEqual(self.action('save_create')[0], 200)
        manual = self.payload['saves'][0]['id']
        before = self.get()['progress']
        self.assertEqual(self.action('language', language='invalid')[0], 400)
        self.assertEqual(self.action('language', language='中文')[0], 200)
        after = self.get()['progress']
        self.assertEqual(after['levels'], before['levels'])
        self.assertEqual(after['completed'], before['completed'])
        self.assertEqual(self.payload['game']['chinese']['levels']['a']['text'], '这是一段中文原稿。')
        self.assertEqual(self.action('message', message='What is the statement?')[0], 200)
        self.assertIn('回答', self.payload['progress']['levels']['a']['chat']['messages'][-1]['content'])
        self.assertEqual(self.calls()[-1]['language'], '中文')
        self.assertEqual(self.calls()[-1]['manuscript'][0]['text'], 'Snapshot manuscript content')
        self.choose_guide()
        self.assertEqual(self.action('start', level_id='b')[0], 200)
        self.assertIn('等式', self.payload['progress']['levels']['b']['messages'][-1]['content'])
        self.stop()
        self.start()
        self.assertEqual(self.payload['progress']['language'], '中文')
        self.assertEqual(self.action('save_load', save_id=manual)[0], 200)
        self.assertEqual(self.payload['progress']['language'], '中文')
        self.assertEqual(self.payload['progress']['levels'], before['levels'])
        self.assertEqual(self.action('language', language='English')[0], 200)
        self.assertEqual(self.action('message', message='Switch back')[0], 200)
        self.assertEqual(self.calls()[-1]['language'], 'English')

    def test_switch_during_reply_keeps_one_player_turn_and_rejects_old_answer(self):
        self.enable_bilingual()
        self.action('mode', mode='chat')
        revision = self.payload['progress']['revision']
        result = []
        worker = threading.Thread(target=lambda: result.append(self.call('POST', '/api/action', {
            'action':'message','level_id':'a','mode':'chat','message':'SWITCH',
            'request_id':'pending-message','expected_revision':revision})))
        worker.start()
        self.addCleanup(worker.join, 10)
        for _ in range(100):
            if any(call['player_message']=='SWITCH' for call in self.calls()):
                break
            time.sleep(.02)
        self.assertTrue(any(call['player_message']=='SWITCH' for call in self.calls()))
        self.assertEqual(self.action('language', language='中文', request_id='switch')[0], 200)
        worker.join(10)
        self.assertFalse(worker.is_alive())
        self.assertEqual(result[0][0], 200)
        progress = self.get()['progress']
        messages = progress['levels']['a']['chat']['messages']
        self.assertEqual(len(messages), 2)
        self.assertEqual(messages[0]['content'], 'SWITCH')
        self.assertIn('回答', messages[1]['content'])
        self.assertEqual(progress['language'], '中文')
        self.assertEqual([call['language'] for call in self.calls() if call['player_message']=='SWITCH'],
                         ['English','中文'])
        status, _, _ = self.call('POST', '/api/action', {
            'action':'language','level_id':'a','language':'中文','request_id':'switch','expected_revision':revision})
        self.assertEqual(status, 200)

    def test_legacy_language_and_nested_history_are_preserved_but_not_resumed(self):
        self.action('start');self.stop()
        file=self.root/'player-save.json';old=json.loads(file.read_text())
        old['language']='中文';old['levels']['a']['mode']='guide'
        old['levels']['a']['return_stack']=[0]
        old['levels']['a']['messages'][0]['branch_complete']=True
        data=json.dumps(old).encode();file.write_bytes(data)
        self.start();self.assertEqual(file.read_bytes(),data)
        self.assertEqual(self.payload['progress']['language'],'English')
        self.assertEqual(self.guide_state()['messages'],old['levels']['a']['messages'])
        self.action('message',message='Move on')
        self.assertNotIn('return_stack',self.guide_state())
        self.assertNotIn('confirmation_state',self.calls()[-1])
        count=len(self.calls());self.action('understand')
        self.assertEqual(len(self.calls()),count+1)
        self.assertEqual(self.guide_state()['messages'][0],old['levels']['a']['messages'][0])

    def test_village_reveals_only_unlocked_manuscript_components(self):
        self.assertEqual(self.payload['level_status'], {'a': 'open', 'b': 'hidden', 'pa': 'hidden', 'pb': 'hidden'})
        self.choose_guide()
        self.finish('a')
        self.assertEqual(self.payload['level_status'], {'a': 'complete', 'b': 'open', 'pa': 'hidden', 'pb': 'hidden'})
        self.assertEqual(self.action('start', 'pa')[0], 403)
        self.finish('b')
        self.assertEqual(self.payload['level_status']['pa'], 'open')
        self.finish('pa')
        self.finish('pb')
        self.assertEqual(len(self.payload['progress']['completed']), 4)

    def test_separate_step_and_whole_goal_confirmation(self):
        self.choose_guide()
        self.assertEqual(self.action('complete')[0], 409)
        self.assertEqual(self.action('start')[0], 200)
        self.assertEqual(self.action('complete')[0], 409)
        self.assertEqual(self.action('understand')[0], 200)
        self.assertEqual(self.payload['progress']['completed'], [])
        self.assertEqual(self.action('complete')[0], 200)
        self.assertEqual(self.payload['progress']['completed'], ['a'])

    def test_login_status_configuration_error_does_not_block_clean_exec(self):
        self.stop()
        self.env['FAKE_LOGIN_CONFIG_ERROR'] = '1'
        self.start()
        self.assertIsNone(self.payload['connection']['authenticated'])
        self.choose_guide()
        self.assertEqual(self.action('start')[0], 200)
        self.assertIs(self.payload['connection']['authenticated'], True)

    def test_codex_environment_executable_is_used_without_override(self):
        self.stop()
        executable = self.env.pop('PROOF2GAME_CODEX')
        self.env['CODEX_CLI_PATH'] = executable
        self.start()
        self.assertEqual(self.payload['connection']['cli_source'], 'codex_environment')
        self.assertEqual(self.payload['connection']['cli_version'], 'codex-cli controlled-test')
        self.choose_guide()
        self.assertEqual(self.action('start')[0], 200)

    def test_explicit_executable_override_wins(self):
        self.stop()
        other = self.root/'other-codex'
        other.write_text('#!/bin/sh\nexit 1\n')
        other.chmod(0o700)
        self.env['CODEX_CLI_PATH'] = str(other)
        self.start()
        self.assertEqual(self.payload['connection']['cli_source'], 'explicit_override')
        self.assertTrue(self.payload['connection']['available'])
        self.choose_guide()
        self.assertEqual(self.action('start')[0], 200)

    def test_previous_override_is_used_when_proof2game_override_is_absent(self):
        self.stop()
        self.env['MATHGROVE_CODEX'] = self.env.pop('PROOF2GAME_CODEX')
        self.start()
        self.assertEqual(self.payload['connection']['cli_version'], 'codex-cli controlled-test')
        self.assertEqual(self.action('start')[0], 200)

    def test_missing_explicit_override_is_reported_without_fallback(self):
        self.stop()
        self.env['CODEX_CLI_PATH'] = self.env['PROOF2GAME_CODEX']
        self.env['MATHGROVE_CODEX'] = self.env['PROOF2GAME_CODEX']
        self.env['PROOF2GAME_CODEX'] = str(self.root/'missing-executable')
        self.start()
        self.assertEqual(self.payload['connection']['cli_source'], 'explicit_override')
        self.assertFalse(self.payload['connection']['available'])

    def test_manuscript_images_are_attached_and_privately_served(self):
        self.stop()
        image = self.root/'snapshot/figure.png'
        image.write_bytes(bytes.fromhex('89504e470d0a1a0a'))
        self.game['snapshot_files']['snapshot/figure.png'] = hashlib.sha256(image.read_bytes()).hexdigest()
        self.game['manuscript']['files'].append('snapshot/figure.png')
        (self.root/'game.json').write_text(json.dumps(self.game))
        self.start()
        self.choose_guide()
        self.assertEqual(self.action('start')[0], 200)
        context = json.loads((self.root/'last-prompt.json').read_text())
        args = json.loads((self.root/'last-args.json').read_text())
        self.assertEqual(context['image_attachments'], ['snapshot/figure.png'])
        self.assertTrue(context['manuscript'][0]['attached_image'])
        self.assertEqual(args[args.index('--image')+1], str(image.resolve()))
        self.assertEqual(self.call('GET', '/snapshot/figure.png')[0], 200)
        self.assertEqual(self.call('GET', '/snapshot/figure.png', authenticated=False)[0], 401)
        image.write_bytes(b'changed')
        self.assertEqual(self.call('GET', '/snapshot/figure.png')[0], 409)

    def test_excess_figures_are_rejected_instead_of_omitted(self):
        self.stop()
        for i in range(21):
            image = self.root/f'snapshot/figure-{i}.png'
            image.write_bytes(b'image')
            name = f'snapshot/figure-{i}.png'
            self.game['snapshot_files'][name] = hashlib.sha256(image.read_bytes()).hexdigest()
            self.game['manuscript']['files'].append(name)
        (self.root/'game.json').write_text(json.dumps(self.game))
        process = subprocess.run(['node', str(self.root/'server.mjs'), '--no-open'], cwd=self.root, env=self.env, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(process.returncode, 0)
        self.assertIn('No figures were omitted', process.stderr)

    def test_tutor_context_and_model_cannot_complete_without_player_confirmation(self):
        self.action('start');self.assertEqual(self.calls()[-1]['available_confirmation'],'passage_or_level')
        self.action('understand');self.assertEqual(self.guide_state()['phase'],'goal_confirmation')
        self.assertEqual(self.payload['progress']['completed'],[])
        self.action('complete');self.assertEqual(self.payload['progress']['completed'],['a'])
        self.action('message',message='A follow-up')
        self.assertTrue(self.calls()[-1]['level_completed'])

    def test_failed_tutor_rolls_back_history_and_revision(self):
        self.choose_guide()
        self.action('start')
        before = self.get()['progress']
        self.assertEqual(self.action('message', message='FAIL')[0], 500)
        self.assertEqual(self.get()['progress'], before)
        self.stop()
        self.start()
        self.assertEqual(self.payload['progress'], before)

    def test_save_revisit_and_other_level_context(self):
        self.choose_guide()
        self.finish('a')
        self.action('mode', 'b', mode='guide')
        self.action('start', 'b')
        self.action('message', 'a', message='These steps are easy; take a bigger step.')
        context = json.loads((self.root/'last-prompt.json').read_text())
        self.assertIn('b', context['other_level_conversations'])
        self.assertIn('Snapshot manuscript content', context['manuscript'][0]['text'])
        before = self.get()['progress']
        self.stop()
        self.start()
        self.assertEqual(self.payload['progress'], before)
        self.assertEqual(self.payload['progress']['completed'], ['a'])
        self.assertTrue((self.root/'player-save.json.backup').is_file())

    def test_stale_actions_and_retry_idempotence(self):
        self.choose_guide()
        revision = self.payload['progress']['revision']
        self.assertEqual(self.action('start', request_id='unique-start')[0], 200)
        before = self.payload['progress']
        status, _, body = self.call('POST', '/api/action', {'action': 'start', 'level_id': 'a', 'expected_revision': revision, 'request_id': 'unique-start'})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['progress'], before)
        self.assertEqual(self.action('message', message='Another action', expected_revision=revision)[0], 409)
        self.assertEqual(self.action('message', message='Other', request_id='unique-start')[0], 409)

    def test_private_routes_and_origin_guards(self):
        self.assertEqual(self.call('GET', '/api/game', authenticated=False)[0], 401)
        self.assertEqual(self.call('POST', '/api/action', {'action': 'language'}, origin=False)[0], 403)
        for route in ['/game.json', '/snapshot/main.tex', '/player-save.json', '/vendor/../game.json', '/vendor/../../index.html']:
            self.assertIn(self.call('GET', route)[0], [400, 404])
        connection = http.client.HTTPConnection('127.0.0.1', self.port)
        connection.request('POST', '/api/action', '{}', {'Cookie': self.cookie, 'Origin': 'https://elsewhere.example', 'Content-Type': 'application/json'})
        response = connection.getresponse()
        self.assertEqual(response.status, 403)
        response.read()
        connection.close()

    def test_snapshot_modification_rejected_during_play(self):
        self.choose_guide()
        before = self.payload['progress']
        (self.root/'snapshot/main.tex').write_text('Changed while running')
        self.assertEqual(self.action('start')[0], 409)
        self.assertEqual(self.get()['progress'], before)

    def test_snapshot_modification_rejected_on_restart(self):
        self.stop()
        (self.root/'snapshot/main.tex').write_text('Changed')
        process = subprocess.run(['node', str(self.root/'server.mjs'), '--no-open'], cwd=self.root, env=self.env, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(process.returncode, 0)
        self.assertIn('snapshot was changed', process.stderr)

    def test_corrupt_save_is_preserved_and_reported(self):
        self.choose_guide()
        self.stop()
        (self.root/'player-save.json').write_text('broken save')
        process = subprocess.run(['node', str(self.root/'server.mjs'), '--no-open'], cwd=self.root, env=self.env, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual((self.root/'player-save.json').read_text(), 'broken save')
        self.assertIn('has been preserved', process.stderr)

    def guide_state(self):
        return self.get()['progress']['levels']['a']

    def calls(self):
        file = self.root/'calls.jsonl'
        return [json.loads(line) for line in file.read_text().splitlines()] if file.exists() else []

    def wait_for(self, predicate):
        deadline = time.monotonic()+5
        while time.monotonic()<deadline:
            if predicate(): return
            time.sleep(.02)
        self.fail('Timed out waiting for controlled local test state')

    def test_guide_default_and_separate_cross_mode_context(self):
        self.action('start');self.assertEqual(self.calls()[-1]['mode'],'guide')
        guide=self.guide_state()['messages']
        self.action('mode',mode='chat');self.action('message',message='A general question')
        self.assertEqual(self.guide_state()['messages'],guide)
        self.assertIn('guide_conversation',self.calls()[-1])
        self.action('understand_all');self.action('start','b')
        self.assertEqual(self.calls()[-1]['mode'],'guide')
        self.action('mode','b',mode='chat');self.stop();self.start()
        self.assertEqual(self.payload['progress']['levels']['b']['mode'],'chat')

    def test_feedback_discards_draft_and_never_replays_or_creates_parent_agenda(self):
        self.action('start');old=self.guide_state()['messages'][0]
        for message in ['What is B?','This intuition is unconvincing. Move on.','A follow-up']:
            self.assertEqual(self.action('message',message=message)[0],200)
            self.assertNotIn('return_stack',self.guide_state())
        count=len(self.calls());self.action('understand')
        self.assertEqual(len(self.calls()),count+1)
        self.assertNotEqual(self.guide_state()['messages'][-1].get('kind'),'resume_confirmation')
        self.assertEqual(self.guide_state()['messages'][0],old)
        self.assertEqual(self.payload['progress']['completed'],[])

    def test_partial_confirmation_preserves_scope_and_disagreement(self):
        self.action('start');self.action('message',message='I understand B, but B is unconvincing.')
        events=self.guide_state()['understanding']
        self.assertEqual(events[-1]['description'],'B');self.assertEqual(events[-1]['scope'],'partial')
        self.assertEqual(self.payload['progress']['completed'],[])
        self.action('message',message='What was B again?')
        self.assertEqual(self.guide_state()['understanding'],events)
        self.assertEqual(self.calls()[-1]['confirmed_understanding'],events)
        self.action('message',message='I actually did not understand B.')
        self.assertEqual(self.guide_state()['understanding'][-1]['kind'],'correct')
        self.assertEqual(self.guide_state()['understanding'][0],events[0])

    def test_natural_whole_confirmation_completes_in_both_modes_and_can_be_withdrawn(self):
        for mode in ['guide','chat']:
            with self.subTest(mode=mode):
                self.action('mode',mode=mode)
                before=self.get()['progress']['completed']
                self.action('message',message='I understand this whole level.')
                self.assertEqual(self.payload['progress']['completed'],['a'])
                key='chat_undoable_messages' if mode=='chat' else 'undoable_messages'
                self.action('undo_message',target_id=self.payload[key]['a']['target_id'])
                self.assertEqual(self.payload['progress']['completed'],before)
        self.action('message',message='I understand this whole level.')
        self.action('message',message='I actually did not understand B.')
        self.assertEqual(self.payload['progress']['completed'],['a'])
        self.assertEqual(self.payload['level_status']['b'],'open')

    def test_other_level_confirmation_does_not_complete_current_or_unlock_other_level(self):
        for mode in ['guide','chat']:
            self.action('mode',mode=mode)
            self.assertEqual(self.action('message',message='I understand another level.')[0],200)
            self.assertEqual(self.payload['progress']['completed'],[])
            self.assertEqual(self.payload['level_status']['b'],'hidden')
            state=self.guide_state() if mode=='guide' else self.guide_state()['chat']
            self.assertEqual(state['understanding'][-1]['level_id'],'b')
        before=self.get()['progress']
        self.assertEqual(self.action('message',message='Unknown level.')[0],500)
        self.assertEqual(self.get()['progress'],before)

    def test_foreign_proof_confirmation_explicitly_excluding_active_level_does_not_clear_it(self):
        self.action('mode',mode='chat')
        message='The entire Proof of Two even integers level is clear to me. I am confirming only that proof level. I am not confirming this Settings and Conventions level.'
        self.assertEqual(self.action('message',message=message)[0],200)
        self.assertEqual(self.payload['progress']['completed'],[])
        self.assertEqual(self.payload['level_status']['pa'],'hidden')
        event=self.guide_state()['chat']['understanding'][-1]
        self.assertEqual(event['level_id'],'pa');self.assertEqual(event['quote'],message)
        self.assertIn({'id':'pa','type':'proof','title':'Proof A'},self.calls()[-1]['level_index'])

    def test_model_confirmation_must_be_current_message_bound(self):
        self.action('start');before=self.get()['progress']
        for message in ['UNBOUND','MODEL COMPLETES']:
            self.assertEqual(self.action('message',message=message)[0],500)
            self.assertEqual(self.get()['progress'],before)

    def test_button_confirmation_is_authoritative_for_a_prefetched_reply(self):
        self.stop()
        self.env['FAKE_BUTTON_CONFIRMATION'] = '1'
        self.start()
        self.assertEqual(self.action('start')[0], 200)
        before = self.guide_state()
        self.action('prefetch')
        self.wait_for(lambda: len(self.calls()) == 2)
        self.assertEqual(self.guide_state(), before)
        status, result = self.action('understand', request_id='understood-passage')
        self.assertEqual(status, 200)
        self.assertEqual(len(self.calls()), 2)
        guide = result['progress']['levels']['a']
        self.assertEqual([m['role'] for m in guide['messages']], ['assistant', 'user', 'assistant'])
        self.assertEqual([e['scope'] for e in guide['understanding']], ['passage'])
        self.assertEqual(guide['phase'], 'goal_confirmation')
        self.assertEqual(result['progress']['completed'], [])
        self.assertEqual(result['level_status']['a'], 'open')
        self.assertEqual(self.action('undo_action', target_id=result['undo']['id'])[0], 200)
        self.assertEqual(self.guide_state()['messages'], before['messages'])
        self.assertFalse(self.guide_state().get('understanding'))

    def test_retry_after_provider_failure_and_restart_preserves_one_passage_and_one_undo(self):
        self.assertEqual(self.action('start')[0], 200)
        before = self.guide_state()
        (self.root/'fail-next-passage').touch()
        status, _ = self.action('understand', request_id='explicit-passage')
        self.assertGreaterEqual(status, 400)
        pending = self.get()
        guide = pending['progress']['levels']['a']
        self.assertEqual(guide['phase'], 'awaiting_continuation')
        self.assertEqual([m['role'] for m in guide['messages']], ['assistant', 'user'])
        self.assertEqual([e['scope'] for e in guide['understanding']], ['passage'])
        self.stop()
        (self.root/'fail-next-passage').rename(self.root/'provider-restored')
        self.start()
        self.assertEqual(self.guide_state(), guide)
        status, result = self.action('continue', request_id='retry-continuation')
        self.assertEqual(status, 200)
        resumed = result['progress']['levels']['a']
        self.assertEqual([m['role'] for m in resumed['messages']], ['assistant', 'user', 'assistant'])
        self.assertEqual(resumed['understanding'], guide['understanding'])
        self.assertEqual(result['progress']['completed'], [])
        self.assertEqual(result['undo'], pending['undo'])
        self.assertEqual(self.action('continue', request_id='retry-continuation')[0], 200)
        self.assertEqual(len(self.calls()), 3)
        self.assertEqual(self.action('undo_action', target_id=result['undo']['id'])[0], 200)
        self.assertEqual(self.guide_state()['messages'], before['messages'])
        self.assertFalse(self.guide_state().get('understanding'))

    def test_completed_level_and_whole_component_confirmation_need_no_guide_permission(self):
        self.assertEqual(self.action('understand_all')[0], 200)
        self.assertEqual(self.payload['progress']['completed'], ['a'])
        self.assertEqual(self.guide_state()['understanding'][-1]['scope'],'level')
        self.action('message', message='A follow-up')
        self.assertEqual(self.payload['progress']['completed'], ['a'])

    def test_opening_prefetch_is_invisible_reused_after_mode_choice_and_page_reentry(self):
        before = self.get()['progress']
        self.action('prefetch'); self.action('prefetch')
        self.wait_for(lambda: len(self.calls())==1)
        self.assertEqual(self.get()['progress'], before)
        _, headers, _ = self.call('GET', '/', authenticated=False)
        self.cookie = headers['Set-Cookie'].split(';')[0]
        self.action('mode', mode='guide')
        self.assertEqual(self.action('start')[0], 200)
        self.assertEqual(len(self.calls()), 1)

    def test_mode_only_switch_keeps_valid_next_prediction_until_a_question(self):
        self.choose_guide();self.action('start')
        self.action('prefetch');self.wait_for(lambda:len(self.calls())==2)
        self.action('mode',mode='chat');self.action('mode',mode='guide')
        self.action('understand')
        self.assertEqual(len(self.calls()),2)

    def test_next_prefetch_reuses_inflight_generation_and_invalidates_on_question(self):
        self.stop(); self.env['FAKE_DELAY_UNDERSTAND']='1'; self.start()
        self.choose_guide(); self.action('start')
        before = self.get()['progress']
        self.action('prefetch'); self.action('prefetch')
        self.wait_for(lambda: len(self.calls())==2)
        self.assertEqual(self.get()['progress'], before)
        self.action('understand')
        self.assertEqual(len(self.calls()), 2)
        self.action('message', message='two children')
        self.action('prefetch')
        self.wait_for(lambda: len(self.calls())==4)
        self.action('message', message='A different question')
        self.assertEqual(self.calls()[-1]['player_message'], 'A different question')
        self.assertNotIn('return_stack',self.guide_state())

    def test_pending_and_answered_prompt_withdrawal_preserves_state_and_editable_draft(self):
        self.choose_guide(); self.action('start')
        before = self.guide_state()
        result=[]
        worker=threading.Thread(target=lambda: result.append(self.action('message',message='SLOW')))
        worker.start()
        self.wait_for(lambda: bool(self.get()['pending_message']))
        pending=self.get()['pending_message']
        self.assertEqual(self.action('undo_message', target_id=pending['target_id'])[0], 200)
        worker.join(5); self.assertFalse(worker.is_alive())
        self.assertEqual(result[0][0], 409)
        restored=self.guide_state()
        self.assertEqual(restored['messages'],before['messages'])
        self.assertEqual(restored['draft'],'SLOW')
        self.assertFalse(self.get()['connection']['busy'])
        self.action('message',message='Edited prompt')
        target=self.payload['undoable_messages']['a']['target_id']
        self.action('undo_message',target_id=target)
        self.assertEqual(self.guide_state()['messages'],before['messages'])
        self.assertEqual(self.guide_state()['draft'],'Edited prompt')

    def test_undo_history_survives_restart_and_import_then_rewinds_across_levels(self):
        self.assertEqual(self.action('start')[0], 200)
        self.assertEqual(self.action('message', message='First question')[0], 200)
        self.assertEqual(self.action('understand_all')[0], 200)
        self.assertEqual(self.action('mode', 'b', mode='chat')[0], 200)
        self.assertEqual(self.action('message', 'b', mode='chat', message='Second question')[0], 200)
        self.assertEqual(self.action('save_create')[0], 200)
        saved = self.payload['saves'][0]['id']
        exported = json.loads(self.call('GET', '/api/saves/'+saved+'/download')[2])
        self.stop(); self.start()
        self.assertEqual(self.payload['undo']['action'], 'message')
        self.assertEqual(self.action('save_import', save=exported)[0], 200)
        def undo(action, level):
            latest = self.payload['undo']
            self.assertEqual((latest['action'], latest['level_id']), (action, level))
            self.assertEqual(self.action('undo_action', target_id=latest['id'])[0], 200)
        undo('message', 'b')
        b = self.get()['progress']['levels']['b']
        self.assertEqual(b['chat']['messages'], [])
        self.assertEqual(b['chat']['draft'], 'Second question')
        undo('mode', 'b')
        self.assertNotIn('b', self.get()['progress']['levels'])
        undo('understand_all', 'a')
        self.assertEqual(self.payload['level_status']['b'], 'hidden')
        self.assertNotIn('understanding', self.get()['progress']['levels']['a'])
        undo('message', 'a')
        self.assertEqual(self.guide_state()['draft'], 'First question')
        self.assertEqual(len(self.guide_state()['messages']), 1)
        undo('start', 'a')
        self.assertIsNone(self.payload['undo'])
        self.assertEqual(self.get()['progress']['levels'], {})
        self.assertEqual(len(exported['progress']['undo_history']), 5)
        self.assertEqual(json.loads(self.call('GET', '/api/saves/'+saved+'/download')[2]), exported)

    def test_bundled_pdf_uses_native_route_range_and_integrity(self):
        self.stop()
        (self.root/'references').mkdir()
        pdf=self.root/'references/source.pdf'; pdf.write_bytes(b'%PDF-1.4 example')
        digest=hashlib.sha256(pdf.read_bytes()).hexdigest()
        self.game['references']=[{'key':'Source','file':'references/source.pdf','sha256':digest,'pages':1}]
        self.game['reference_files']={'references/source.pdf':digest}
        (self.root/'game.json').write_text(json.dumps(self.game)); self.start()
        status,headers,body=self.call('GET','/references/source.pdf')
        self.assertEqual(status,200);self.assertEqual(headers['Content-Type'],'application/pdf')
        self.assertTrue(headers['Content-Disposition'].startswith('inline'))
        self.assertEqual(body,pdf.read_bytes())
        self.assertEqual(self.call('GET','/references/source.pdf',authenticated=False)[0],401)
        connection=http.client.HTTPConnection('127.0.0.1',self.port)
        connection.request('GET','/references/source.pdf',headers={'Cookie':self.cookie,'Range':'bytes=0-4'})
        response=connection.getresponse(); self.assertEqual(response.status,206)
        self.assertEqual(response.read(),b'%PDF-');connection.close()
        pdf.write_bytes(b'changed')
        self.assertEqual(self.call('GET','/references/source.pdf')[0],409)

    def test_conventions_open_in_order_and_shared_hierarchy_is_supported(self):
        self.stop()
        conventions=[{'id':'c0','type':'convention','paired':None,'owner':'a','parent':None,'text':'Shared','title':'Main Results'},
                     {'id':'c1','type':'convention','paired':None,'owner':'a','parent':'c0','text':'Local','title':'A local scope'}]
        self.game['levels'][0]['parent']='c1'
        self.game['levels']=conventions+self.game['levels']
        (self.root/'game.json').write_text(json.dumps(self.game)); self.start()
        self.assertEqual(self.payload['level_status']['c0'],'open')
        self.assertEqual(self.action('start', 'c0')[0], 200)
        context = json.loads((self.root/'last-prompt.json').read_text())
        self.assertEqual(context['level']['title'], 'Convention')
        self.assertEqual(context['level']['id'], 'c0')
        self.assertEqual(context['manuscript'], [])
        self.assertNotIn('other_level_conversations', context)
        self.assertEqual([level['title'] for level in context['level_index'][:2]], ['Convention', 'Convention'])
        self.assertEqual(self.action('understand_all','a')[0],403)
        self.action('understand_all','c0');self.assertEqual(self.payload['level_status']['c1'],'open')
        self.action('understand_all','c1');self.assertEqual(self.payload['level_status']['a'],'open')

    def test_invalid_saved_branch_flag_is_preserved_and_rejected(self):
        self.choose_guide();self.action('start');self.stop()
        file=self.root/'player-save.json';value=json.loads(file.read_text())
        value['levels']['a']['messages'][-1]['branch_complete']='false'
        file.write_text(json.dumps(value))
        process=subprocess.run(['node',str(self.root/'server.mjs'),'--no-open'],cwd=self.root,env=self.env,capture_output=True,text=True,timeout=10)
        self.assertNotEqual(process.returncode,0);self.assertIn('invalid conversation',process.stderr)
        self.assertEqual(json.loads(file.read_text()),value)
    def test_independent_manual_saves_load_download_delete_and_restart(self):
        self.action('start');original=self.get()['progress'];self.assertEqual(self.action('save_create',label='First')[0],200)
        first=self.payload['saves'][0]['id'];self.action('understand_all')
        self.action('save_create',label='Second');second=next(x['id'] for x in self.payload['saves'] if x['label']=='Second')
        revision=self.payload['progress']['revision']
        self.assertEqual(self.action('save_load',save_id=first)[0],200)
        self.assertGreater(self.payload['progress']['revision'],revision)
        self.assertEqual(self.payload['progress']['completed'],original['completed'])
        self.assertEqual(self.guide_state()['messages'],original['levels']['a']['messages'])
        self.assertEqual(len(self.payload['saves']),2)
        status,headers,body=self.call('GET','/api/saves/'+second+'/download')
        self.assertEqual(status,200);saved=json.loads(body)
        self.assertEqual(saved['progress']['completed'],['a'])
        self.assertTrue(headers['Content-Disposition'].startswith('attachment'))
        self.assertTrue(list((self.root/'recovery-saves').glob('*.json')))
        self.action('save_delete',save_id=first);self.assertEqual(len(self.payload['saves']),1)
        self.assertTrue(list((self.root/'deleted-saves').glob(first+'-*.json')))
        before=self.get()['progress'];self.stop();self.start()
        self.assertEqual(self.payload['progress'],before);self.assertEqual(self.payload['saves'][0]['id'],second)
        self.assertEqual(self.call('GET','/api/saves/'+first+'/download')[0],404)

    def test_export_import_replaces_no_merge_and_preserves_backups(self):
        self.action('start');status,headers,body=self.call('GET','/api/save/export');self.assertEqual(status,200)
        export=json.loads(body);self.action('understand_all');self.action('message','b',message='B question')
        before=json.loads(self.call('GET','/api/save/export')[2])['progress'];self.assertEqual(self.action('save_import',save=export)[0],200)
        after=self.payload['progress'];self.assertNotIn('b',after['levels'])
        self.assertGreater(after['revision'],before['revision']);self.assertEqual(after['completed'],[])
        backups=[json.loads(p.read_text())['progress'] for p in (self.root/'recovery-saves').glob('*.json')]
        self.assertIn(before,backups)
        self.assertEqual(self.payload['progress']['recent_actions'] if 'recent_actions' in self.payload['progress'] else [],[])

    def test_guide_diagram_stays_in_its_step_after_revisit_restart_and_portable_import(self):
        self.assertEqual(self.action('start')[0], 200)
        self.assertEqual(self.action('message', message='Show this with a diagram.')[0], 200)
        history = self.guide_state()['messages']
        step = history[2]
        self.assertEqual(step['content'], '')
        self.assertIn('understand', step['step_goal'])
        self.assertEqual(step['image']['alt'], 'Two points joined by an arrow.')
        self.assertIn('x &lt; y', step['image']['svg'])
        self.assertNotIn('image', history[0])
        self.assertEqual(self.action('understand_all')[0], 200)
        self.assertEqual(self.action('start')[0], 200)
        self.assertEqual(self.guide_state()['messages'][:3], history)
        self.assertEqual(self.action('save_create')[0], 200)
        save_id = self.payload['saves'][0]['id']
        for route in ('/api/save/export', f'/api/saves/{save_id}/download'):
            status, _, body = self.call('GET', route)
            self.assertEqual(status, 200)
            exported = json.loads(body)
            self.assertEqual(exported['progress']['levels']['a']['messages'][2], step)
        self.stop()
        self.start()
        self.assertEqual(self.guide_state()['messages'][2], step)
        self.stop()
        original_root = self.root
        self.root = original_root/'clean-install'
        self.root.mkdir()
        for name in ('server.mjs', *RUNTIME_MODULES, 'index.html', 'app.js', 'style.css', 'game.json'):
            shutil.copyfile(original_root/name, self.root/name)
        shutil.copytree(original_root/'snapshot', self.root/'snapshot')
        shutil.copyfile(original_root/'fake-codex', self.root/'fake-codex')
        (self.root/'fake-codex').chmod(0o700)
        self.env['PROOF2GAME_CODEX'] = str(self.root/'fake-codex')
        self.start()
        self.assertEqual(self.payload['progress']['levels'], {})
        self.assertEqual(self.action('save_import', save=exported)[0], 200)
        self.assertEqual(self.guide_state()['messages'][2], step)
        self.assertFalse((self.root/'calls.jsonl').exists(), 'restoring the picture needs no new tutor call')

    def test_regular_chat_renders_requested_drawing_and_saves_it(self):
        self.assertEqual(self.action('mode', mode='chat')[0], 200)
        self.assertEqual(self.action('message', mode='chat', message='Draw a blueberry.')[0], 200)
        step = self.guide_state()['chat']['messages'][-1]
        self.assertEqual(step['content'], '')
        self.assertEqual(step['image']['alt'], 'A blueberry.')
        self.assertIn('<circle ', step['image']['svg'])
        self.assertNotIn('step_goal', step)
        self.assertEqual(self.payload['progress']['completed'], [])
        status, _, body = self.call('GET', '/api/save/export')
        self.assertEqual(status, 200)
        exported = json.loads(body)
        self.stop()
        self.start()
        self.assertEqual(self.guide_state()['chat']['messages'][-1], step)
        self.assertEqual(self.action('save_import', save=exported)[0], 200)
        self.assertEqual(self.guide_state()['chat']['messages'][-1], step)

    def test_invalid_guide_diagram_and_unsafe_import_preserve_progress(self):
        self.action('start')
        original = self.get()['progress']
        self.assertEqual(self.action('message', message='Invalid diagram.')[0], 500)
        self.assertEqual(self.get()['progress'], original)
        self.action('message', message='Show this with a diagram.')
        original = self.get()['progress']
        unsafe = json.loads(json.dumps(original))
        image = unsafe['levels']['a']['messages'][2]['image']
        image['svg'] = image['svg'].replace('</svg>', '<script>alert(1)</script></svg>')
        self.assertEqual(self.action('save_import', save=unsafe)[0], 400)
        self.assertEqual(self.get()['progress'], original)

    def test_current_download_preserves_previous_release_save_format(self):
        self.assertEqual(self.action('understand_all')[0], 200)
        status, headers, body = self.call('GET', '/api/save/export')
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-Disposition'], 'attachment; filename="proof2game-current.json"')
        saved = json.loads(body)
        self.assertEqual(saved['kind'], 'mathgrove-save')
        self.assertEqual(saved['schema'], 1)
        target = self.payload['undo']['id']
        self.assertEqual(self.action('undo_action', target_id=target)[0], 200)
        old_save = dict(saved, label='Previous release export')
        self.assertEqual(self.action('save_import', save=old_save)[0], 200)
        self.assertEqual(self.payload['progress']['completed'], ['a'])
        self.assertEqual(self.payload['undo']['id'], target)
        old_save['snapshot_digest'] = 'other-script-snapshot'
        self.assertEqual(self.action('save_import', save=old_save)[0], 400)
        self.assertEqual(self.payload['progress']['completed'], ['a'])

    def test_bad_and_cross_snapshot_imports_leave_everything_unchanged(self):
        self.action('start');original=self.get()['progress'];disk=(self.root/'player-save.json').read_bytes()
        for wrong in [None,[],{},dict(original,game_id='other'),dict(original,completed=['b']),dict(original,levels=[]),dict(original,levels={'a':{'messages':[], 'phase':None, '__proto__':{}}})]:
            self.assertEqual(self.action('save_import',save=wrong)[0],400)
            self.assertEqual(self.get()['progress'],original);self.assertEqual((self.root/'player-save.json').read_bytes(),disk)
        self.assertFalse((self.root/'recovery-saves').exists())
        self.assertEqual(self.action('save_load',save_id='../player-save')[0],400)
        self.assertEqual(self.action('save_delete',save_id='not-an-id')[0],400)

    def test_realistic_large_history_import_and_download_is_not_truncated(self):
        value=self.get()['progress'];value['levels']={'a':{'messages':[{'role':'user','content':'large history '*20000}],'phase':None,'mode':'chat'}}
        self.assertEqual(self.action('save_import',save=value)[0],200)
        self.assertEqual(self.guide_state()['messages'],value['levels']['a']['messages'])
        status,_,body=self.call('GET','/api/save/export');self.assertEqual(status,200)
        self.assertEqual(json.loads(body)['progress']['levels'],value['levels'])

    def test_restore_cancels_pending_turn_and_preparation_without_late_commit(self):
        self.action('start');self.action('save_create');saved_id=self.payload['saves'][0]['id'];result=[]
        worker=threading.Thread(target=lambda:result.append(self.action('message',message='SLOW')));worker.start()
        self.wait_for(lambda:bool(self.get()['pending_message']))
        self.assertEqual(self.action('save_load',save_id=saved_id)[0],200);restored=self.get()['progress']
        worker.join(5);self.assertFalse(worker.is_alive());self.assertEqual(result[0][0],409)
        self.assertEqual(self.get()['progress'],restored)
        count=len(self.calls());self.action('prefetch');self.wait_for(lambda:len(self.calls())>count)
        self.action('save_load',save_id=saved_id);restored=self.get()['progress'];time.sleep(.1)
        self.assertEqual(self.get()['progress'],restored)

    def test_restore_previous_load_import_and_undo_manual_deletion(self):
        self.action('save_create')
        initial = self.payload['saves'][0]
        self.action('understand_all')
        self.action('save_load', save_id=initial['id'])
        self.assertEqual(self.payload['progress']['completed'], [])
        self.action('save_recover', recovery_id=self.payload['save_recovery']['id'])
        self.assertEqual(self.payload['progress']['completed'], ['a'])
        saved = json.loads(self.call('GET', '/api/saves/'+initial['id']+'/download')[2])
        self.action('save_import', save=saved)
        recovery = self.payload['save_recovery']['id']
        self.stop()
        self.start()
        self.assertEqual(self.action('save_recover', recovery_id=recovery)[0], 200)
        self.assertEqual(self.payload['progress']['completed'], ['a'])
        self.action('save_delete', save_id=initial['id'])
        self.assertFalse(self.payload['saves'])
        self.action('save_undelete', recovery_id=self.payload['save_recovery']['id'])
        self.assertEqual(self.payload['saves'], [initial])
        self.assertEqual(json.loads(self.call('GET', '/api/saves/'+initial['id']+'/download')[2]), saved)

    def test_corrupt_manual_record_does_not_block_current_game_and_can_be_deleted(self):
        self.action('save_create');save_id=self.payload['saves'][0]['id'];before=self.get()['progress']
        record=self.root/'manual-saves'/f'{save_id}.json';record.write_text('broken record')
        current=self.get();self.assertEqual(current['progress'],before)
        self.assertIn('error',current['saves'][0])
        self.assertEqual(self.action('save_load',save_id=save_id)[0],500)
        self.assertEqual(self.get()['progress'],before)
        self.assertEqual(self.action('save_delete',save_id=save_id)[0],200)
        self.assertEqual(self.payload['saves'],[])
        self.assertEqual(next((self.root/'deleted-saves').glob('*.json')).read_text(),'broken record')

    def test_invalid_withdrawal_metadata_is_not_imported(self):
        self.action('start');self.action('message',message='A question');value=self.get()['progress']
        value['levels']['a']['messages'][-2]['before_completed']=['b']
        before=self.get()['progress'];self.assertEqual(self.action('save_import',save=value)[0],400)
        self.assertEqual(self.get()['progress'],before)

    def test_manual_save_preserves_valid_next_preparation(self):
        self.action('start');self.action('prefetch')
        self.wait_for(lambda:len(self.calls())==2)
        self.assertEqual(self.action('save_create')[0],200)
        self.action('understand');self.assertEqual(len(self.calls()),2)

    def test_manual_save_deletion_preserves_valid_next_preparation_and_rejects_busy(self):
        self.action('start');self.action('save_create');save_id=self.payload['saves'][0]['id']
        self.action('prefetch');self.wait_for(lambda:len(self.calls())==2)
        self.assertEqual(self.action('save_delete',save_id=save_id)[0],200)
        self.action('understand');self.assertEqual(len(self.calls()),2)
        self.action('save_create');save_id=self.payload['saves'][0]['id'];result=[]
        worker=threading.Thread(target=lambda:result.append(self.action('message',message='SLOW')));worker.start()
        self.wait_for(lambda:bool(self.get()['pending_message']))
        self.assertEqual(self.action('save_delete',save_id=save_id)[0],409)
        self.assertEqual(len(self.get()['saves']),1)
        target=self.get()['pending_message']['target_id'];self.action('undo_message',target_id=target)
        worker.join(5);self.assertFalse(worker.is_alive())

    def test_save_routes_require_local_cookie_and_origin_and_ids_are_idempotent(self):
        self.assertEqual(self.call('GET','/api/saves',authenticated=False)[0],401)
        self.assertEqual(self.call('GET','/api/save/export',authenticated=False)[0],401)
        revision=self.payload['progress']['revision'];self.action('save_create',request_id='one-save')
        status,_,body=self.call('POST','/api/action',{'action':'save_create','level_id':'a','expected_revision':revision,'request_id':'one-save'})
        self.assertEqual(status,200);self.assertEqual(len(json.loads(body)['saves']),1)
        self.assertEqual(self.action('save_create',request_id='one-save',label='different')[0],409)
        self.assertEqual(self.call('POST','/api/action',{'action':'save_import','save':self.get()['progress']},origin=False)[0],403)



if __name__ == '__main__':
    unittest.main()
