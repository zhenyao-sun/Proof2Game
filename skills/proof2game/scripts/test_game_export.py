"""Exercise the hosted website export boundary with real saveable artifacts."""
import json
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
            'citation_key': 'fixture', 'id': 'reference', 'complete': True, 'pdf_path': original.name,
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
        for name, entry in manifest['files'].items():
            data = (site / name).read_bytes()
            self.assertEqual(entry, {'size': len(data), 'sha256': game.sha(data)})


if __name__ == '__main__':
    unittest.main()
