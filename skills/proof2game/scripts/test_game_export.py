"""Exercise the author-side archive boundary with real saveable artifacts."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

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

    @unittest.skipUnless(sys.platform == 'darwin' and shutil.which('pdflatex'), 'Requires macOS with TeX')
    def test_public_game_zips_same_script_chinese_and_exact_cited_pdf_page(self):
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
            'citation_key': 'fixture', 'id': 'reference', 'complete': True, 'pdf_path': original.name,
            'sha256': game.sha(original.read_bytes()), 'page_count': 2,
            'authors': ['Ada Example'], 'title': 'A synthetic note', 'version': 'v1', 'edition': 'preprint',
            'public_date': '2026-02-15', 'cited_locations_physical_pages': {'Lemma 1': [2]},
        }
        bindings = self.root / 'sources.json'
        bindings.write_text(json.dumps({'sources': [dict(good_source, public_date='2026-04-15')]}))
        with self.assertRaisesRegex(game.Rejected, 'publication cutoff'):
            game.make_game(self.main, source_bindings=bindings, verify_numbering=False)
        bindings.write_text(json.dumps({'sources': [good_source, dict(good_source, citation_key='uncited')]}))
        output = self.root / 'game.zip'
        result = game.export(self.main, output, source_bindings=bindings, translation=translation)
        self.assertEqual(result['approval_snapshot_digest'], record['snapshot_digest'])
        with zipfile.ZipFile(output) as archive:
            data = json.loads(archive.read('game.json'))
            self.assertEqual(data['approval_snapshot_digest'], record['snapshot_digest'])
            self.assertEqual(data['app_name'], 'Proof2Game')
            self.assertIn(b'<title>Proof2Game</title>', archive.read('index.html'))
            self.assertIn(b'Proof2Game game', archive.read('START.md'))
            self.assertIn(b'PROOF2GAME_CODEX', archive.read('START.md'))
            self.assertEqual([level['id'] for level in data['levels']], record['components'])
            self.assertNotIn('title', data)
            self.assertNotIn('authors', data)
            self.assertEqual(data['chinese']['levels']['main']['title'], '正性')
            self.assertEqual(data['references'][0]['authors'], ['Ada Example'])
            self.assertEqual(data['references'][0]['locations'][0]['page'], 2)
            self.assertEqual(archive.read('references/fixture.pdf'), original.read_bytes())
            self.assertEqual(archive.read('snapshot/main.tex'), self.main.read_bytes())
            self.assertNotIn('references/uncited.pdf', archive.namelist())
            self.assertEqual(archive.read('LICENSE-Proof2Game.txt'), (ASSETS.parents[2] / 'LICENSE').read_bytes())
            self.assertEqual(archive.read('vendor/fonts/OFL.txt'), (ASSETS / 'game-runtime/vendor/fonts/OFL.txt').read_bytes())
            self.assertNotIn('approval.json', archive.namelist())
            self.assertNotIn('sources.json', archive.namelist())


if __name__ == '__main__':
    unittest.main()
