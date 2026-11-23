"""Exercise the hosted website export boundary with real saveable artifacts."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import game_developer as game
import manuscript


ASSETS = Path(__file__).resolve().parents[1] / 'assets'


class GameExportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='proof2game-export-check-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.script = self.root / 'script'
        self.script.mkdir()
        self.main = self.script / 'main.tex'
        shutil.copyfile(ASSETS / 'script-template.tex', self.main)
        shutil.copytree(ASSETS / 'script-example', self.script / 'components')
        self.approval = self.script / 'approval.json'

    def approve(self):
        clean, full = manuscript.parse(self.main)
        record = {
            'schema': 1, 'snapshot_digest': clean['snapshot_digest'], 'components': clean['cone'],
            'project_type': 'public', 'cutoff': '2026-02-28', 'math_review': 'pass',
            'proof_obligations': 'closed', 'route_review': 'pass',
        }
        self.approval.write_text(json.dumps(record))
        return record, full

    def translation(self, record, full):
        result = game.translation_input(record['snapshot_digest'], game.resource_closure(self.main, full))
        for name, source in result['files'].items():
            result['files'][name] = (source.replace('Main Results', '主要结果')
                                      .replace('Detailed Proofs', '详细证明')
                                      .replace('Positivity', '正性'))
        return result

    def test_eligibility_checks_exact_active_script_and_route(self):
        assigned, _ = self.approve()
        self.assertEqual(game.eligibility(self.main)[0]['snapshot_digest'], assigned['snapshot_digest'])
        changed = self.script / 'components' / 'setting.tex'
        changed.write_text(changed.read_text() + '\nA clarified convention.\n')
        with self.assertRaisesRegex(game.Rejected, 'exact active script'):
            game.eligibility(self.main)
        assigned, _ = self.approve()
        assigned['route_review'] = 'invalidated'
        self.approval.write_text(json.dumps(assigned))
        with self.assertRaisesRegex(game.Rejected, 'route'):
            game.eligibility(self.main)

    def test_proofs_branch_to_declared_children_in_manuscript_play_order(self):
        components = self.script / 'components'
        for name in ('outer-setting', 'inner-setting', 'upper-bound', 'upper-bound-proof'):
            (components / (name + '.tex')).write_text('All values are real.\n')
        source = self.main.read_text()
        prefix, _, proofs = source.partition(r'\section{Detailed Proofs}')
        _, bibliography, suffix = proofs.partition(r'\begin{bibdiv}')
        self.main.write_text(prefix + r'''\section{Detailed Proofs}
\MSnode{main}{1}
\MScomponent{outer-setting}{convention}{components/outer-setting.tex}{}{}{}
\MScomponent{lower-bound}{statement}{components/lower-bound.tex}{lower-bound-proof}{Lemma}{A nonnegative square}
\MScomponent{upper-bound}{statement}{components/upper-bound.tex}{upper-bound-proof}{Lemma}{}
\MScomponent{main-proof}{proof}{components/main-proof.tex}{main}{}{}
\MSnode{lower-bound}{}
\MScomponent{inner-setting}{convention}{components/inner-setting.tex}{}{}{}
\MScomponent{lower-bound-proof}{proof}{components/lower-bound-proof.tex}{lower-bound}{}{}
\MSendnode
\MSnode{upper-bound}{}
\MScomponent{upper-bound-proof}{proof}{components/upper-bound-proof.tex}{upper-bound}{}{}
\MSendnode
\MSendnode
''' + bibliography + suffix)
        main_proof = components / 'main-proof.tex'
        main_proof.write_text(main_proof.read_text() + r'Use also Lemma~\ref{ms:upper-bound}.')
        record, _ = self.approve()
        levels = game.make_game(self.main, verify_numbering=False)[0]['levels']
        self.assertEqual([level['id'] for level in levels], record['components'])
        self.assertEqual([(level['id'], level['parent']) for level in levels], [
            ('setting', None), ('main', 'setting'), ('outer-setting', 'main'),
            ('lower-bound', 'main-proof'), ('upper-bound', 'main-proof'),
            ('main-proof', 'outer-setting'), ('inner-setting', 'lower-bound'),
            ('lower-bound-proof', 'inner-setting'), ('upper-bound-proof', 'upper-bound'),
        ])
        self.assertEqual({level['id']: level['owner'] for level in levels if 'owner' in level}, {
            'setting': 'main', 'outer-setting': 'main', 'inner-setting': 'lower-bound',
        })

    def test_main_results_share_their_cumulative_settings(self):
        source = self.main.read_text()
        components = self.script / 'components'
        for index, name in enumerate(('second', 'third'), 2):
            setting = name + '-setting'
            proof = name + '-proof'
            for component in (setting, name, proof):
                (components / (component + '.tex')).write_text('All values are real.\n')
            source = source.replace(r'\section{Detailed Proofs}', '\n'.join([
                rf'\subsection{{{name}}}',
                rf'\MScomponent{{{setting}}}{{convention}}{{components/{setting}.tex}}{{}}{{}}{{}}',
                rf'\MScomponent{{{name}}}{{statement}}{{components/{name}.tex}}{{{proof}}}{{Theorem}}{{}}',
                r'\section{Detailed Proofs}',
            ]))
            source = source.replace(r'\begin{bibdiv}', '\n'.join([
                rf'\MSnode{{{name}}}{{{index}}}',
                rf'\MScomponent{{{proof}}}{{proof}}{{components/{proof}.tex}}{{{name}}}{{}}{{}}',
                r'\MSendnode', r'\begin{bibdiv}',
            ]))
        self.main.write_text(source)
        self.approve()
        levels = game.make_game(self.main, verify_numbering=False)[0]['levels']
        self.assertEqual([(level['id'], level['parent']) for level in levels[:6]], [
            ('setting', None), ('main', 'setting'), ('second-setting', 'setting'),
            ('second', 'second-setting'), ('third-setting', 'second-setting'), ('third', 'third-setting'),
        ])
        self.assertEqual([level['owner'] for level in levels if level['type'] == 'convention'],
                         ['main', 'second', 'third'])

    @unittest.skipUnless(sys.platform == 'darwin' and shutil.which('pdflatex'), 'Requires macOS with TeX')
    def test_public_site_preserves_script_attribution_and_cited_locations(self):
        main_text = self.main.read_text()
        record_tex = r'\bib{fixture}{article}{author={Ada, Example},title={A synthetic note},date={2026}}'
        self.main.write_text(main_text.replace(r'\end{biblist}', record_tex + '\n' + r'\end{biblist}'))
        proof = self.script / 'components' / 'main-proof.tex'
        proof.write_text(proof.read_text() + r'Compare \cite{fixture}*{Lemma 1}.' + '\n')
        record, full = self.approve()
        translation = self.translation(record, full)

        article = self.root / 'reference.tex'
        article.write_text(
            r'\documentclass{article}\begin{document}First page.\newpage Lemma 1.\end{document}' + '\n'
        )
        subprocess.run(['pdflatex', '-no-shell-escape', '-halt-on-error', 'reference.tex'],
                       cwd=self.root, input=b'', capture_output=True, timeout=30, check=True)
        original = self.root / 'reference.pdf'
        good_source = {
            'citation_key': 'fixture', 'id': 'reference', 'pdf_path': original.name,
            'sha256': game.sha(original.read_bytes()), 'page_count': 2,
            'authors': ['Ada Example'], 'title': 'A synthetic note', 'version': 'v1', 'edition': 'preprint',
            'public_date': '2026-02', 'cited_locations_physical_pages': {'Lemma 1': [2]},
            'record_url': 'https://example.test/synthetic-note',
        }
        bindings = self.root / 'sources.json'
        bindings.write_text(json.dumps({'sources': [dict(good_source, public_date='2026-04-15')]}))
        with self.assertRaisesRegex(game.Rejected, 'publication cutoff'):
            game.make_game(self.main, source_bindings=bindings, verify_numbering=False)
        bindings.write_text(json.dumps({'sources': [dict(good_source, public_date='2026')]}))
        with self.assertRaisesRegex(game.Rejected, 'publication cutoff'):
            game.make_game(self.main, source_bindings=bindings, verify_numbering=False)
        bindings.write_text(json.dumps({'sources': [dict(good_source, sha256='0' * 64)]}))
        with self.assertRaisesRegex(game.Rejected, 'PDF missing, invalid or changed'):
            game.make_game(self.main, source_bindings=bindings, verify_numbering=False)
        bindings.write_text(json.dumps({'sources': [dict(good_source, complete=False)]}))
        game.make_game(self.main, source_bindings=bindings, verify_numbering=False)
        bindings.write_text(json.dumps({'sources': [good_source, dict(good_source, citation_key='uncited')]}))
        site = self.root / 'site'
        with self.assertRaisesRegex(game.Rejected, 'metadata'):
            game.export(self.main, site, source_bindings=bindings, translation=translation)
        record['original_sha256'] = 'a' * 64
        self.approval.write_text(json.dumps(record))
        paper = dict(title='Exact paper', authors=['Ada Example'], version='v1',
                     sha256=record['original_sha256'])
        bindings.write_text(json.dumps({'sources': [dict(good_source, doi='10.1234/abc'),
                                                      dict(good_source, citation_key='uncited')]}))
        page_result = game.export(self.main, site, source_bindings=bindings, translation=translation, paper=paper)
        self.assertEqual(page_result['approval_snapshot_digest'], record['snapshot_digest'])
        public_game = json.loads((site / 'game.json').read_bytes())
        self.assertEqual((public_game['model'], public_game['reasoning_effort']), ('deepseek-flash', 'medium'))
        self.assertEqual(public_game['paper'], {k: v for k, v in paper.items() if k != 'sha256'})
        self.assertEqual([level['id'] for level in public_game['levels']], record['components'])
        self.assertEqual(public_game['chinese']['levels']['main']['title'], '正性')
        self.assertEqual((site / 'snapshot/main.tex').read_bytes(), self.main.read_bytes())
        self.assertEqual(public_game['reference_files'], {})
        self.assertEqual(public_game['references'][0]['source_url'], 'https://doi.org/10.1234/abc')
        self.assertEqual(game.reference_url(good_source), good_source['record_url'])
        self.assertEqual(public_game['references'][0]['locations'][0]['page'], 2)
        self.assertFalse(any(site.rglob('*.pdf')))
        self.assertFalse((site / 'sources.json').exists())
        self.assertFalse((site / 'approval.json').exists())
        manifest = json.loads((site / 'proof2game.json').read_bytes())
        self.assertEqual(manifest['paper'], public_game['paper'])
        self.assertEqual(manifest['launch_mode'], 'browser')
        for filename in game.BROWSER_FILES:
            self.assertTrue((site / filename).is_file(), filename)
        for filename in ('ai-connection.mjs', 'save-store.mjs'):
            self.assertTrue(any('./' + filename + '?v=' + manifest['connector'] in module.read_text()
                                for module in site.glob('*.mjs')), filename)
        for retired_asset in ('illustration-tools.mjs', 'guide-diagram.mjs'):
            self.assertFalse((site / retired_asset).exists())
            self.assertNotIn(retired_asset, manifest['files'])
        portrait = Path(game.__file__).resolve().parents[3] / 'docs/agents/tutor.webp'
        self.assertEqual((site / 'tutor.webp').read_bytes(), portrait.read_bytes())
        self.assertFalse((site / 'server.mjs').exists())
        self.assertFalse((site / 'launch.js').exists())
        for name, entry in manifest['files'].items():
            data = (site / name).read_bytes()
            self.assertEqual(entry, {'size': len(data), 'sha256': game.sha(data)})

        if os.environ.get('PROOF2GAME_CHECK_BROWSERS') == '1':
            subprocess.run(['node', Path(__file__).with_name('check_export_in_browsers.js'), site],
                           check=True, timeout=180)


if __name__ == '__main__':
    unittest.main()
