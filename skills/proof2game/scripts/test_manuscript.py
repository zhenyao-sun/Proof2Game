import json
import shutil
import tempfile
import unittest
from pathlib import Path

import manuscript


ASSETS = Path(__file__).resolve().parents[1] / 'assets'


class ManuscriptTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.main = self.root / 'main.tex'
        shutil.copyfile(ASSETS / 'script-template.tex', self.main)
        shutil.copytree(ASSETS / 'script-example', self.root / 'components')

    def insert(self, marker, added):
        text = self.main.read_text()
        self.assertIn(marker, text)
        self.main.write_text(text.replace(marker, added + '\n' + marker, 1))

    def add_second_root(self):
        self.insert(r'\section{Detailed Proofs}', r'''
\subsection{An additional assumption}
\MScomponent{extra-context}{convention}{components/extra-context.tex}{}{}{}
\MScomponent{second}{statement}{components/second.tex}{second-proof}{Proposition}{}
''')
        self.insert(r'\begin{bibdiv}', r'''
\MSnode{second}{2}
\MScomponent{second-proof}{proof}{components/second-proof.tex}{second}{}{}
\MSendnode
''')
        (self.root / 'components/extra-context.tex').write_text('Here all variables are real.\n')
        (self.root / 'components/second.tex').write_text('For \\(x=0\\), the previous bound is attained.\n')
        (self.root / 'components/second-proof.tex').write_text(
            r'Substitute zero in Theorem~\ref{ms:main}, and use Lemma~\ref{ms:lower-bound}.'
        )

    def add_retired_branch(self):
        self.insert(r'\MScomponent{lower-bound}{statement}', r'''
\MScomponent{retired}{statement}{components/retired.tex}{retired-proof}{Lemma}{}
''')
        self.insert(r'\MSnode{lower-bound}{}', r'''
\MSnode{retired}{}
\MScomponent{retired-proof}{proof}{components/retired-proof.tex}{retired}{}{}
\MSendnode
''')
        self.insert(r'\end{biblist}', r'''
\bib{kept}{article}{title={Kept publication}, date={2020}}
\bib{unused}{article}{title={Unused publication}, date={1990}}
''')
        (self.root / 'components/retired.tex').write_text(r'Old route \cite{unused}.')
        (self.root / 'components/retired-proof.tex').write_text(
            r'An obsolete figure \includegraphics{missing.png} and \ref{never-declared}.'
        )
        proof = self.root / 'components/lower-bound-proof.tex'
        proof.write_text(proof.read_text() + r' See also \cite{kept}.')

    def test_shared_dependencies_and_cumulative_context(self):
        self.add_second_root()
        clean, full = manuscript.parse(self.main)
        self.assertEqual(clean['targets'], ['main', 'second'])
        self.assertEqual(clean['main_results'], ['setting', 'main', 'extra-context', 'second'])
        self.assertEqual(clean['cone'].count('lower-bound'), 1)
        byid = {item['id']: item for item in full['components']}
        self.assertEqual(byid['second-proof']['deps'], ['main', 'lower-bound'])
        self.assertEqual(byid['second-proof']['ambient'], ['setting', 'extra-context'])
        self.assertEqual(byid['main-proof']['ambient'], ['setting'])
        self.assertEqual(byid['lower-bound-proof']['location'], '2.1.1')

    def test_retired_branch_never_enters_deliverable(self):
        self.add_retired_branch()
        clean, _ = manuscript.parse(self.main)
        self.assertNotIn('retired', clean['cone'])
        self.assertIn('retired', [item['id'] for item in clean['components']])
        snapshot = manuscript.materialize_snapshot(self.main, self.root / 'delivery')
        self.assertIn(r'\bib{kept}', snapshot.read_text())
        self.assertNotIn('retired', snapshot.read_text())
        self.assertNotIn(r'\bib{unused}', snapshot.read_text())
        self.assertFalse((snapshot.parent / 'components/retired.tex').exists())
        self.assertTrue((self.root / 'components/retired.tex').is_file())
        clean_snapshot, _ = manuscript.parse(snapshot)
        self.assertEqual(clean_snapshot['cone'], clean['cone'])
        self.assertEqual(clean_snapshot['nodes'][1]['location'], '2.1.1')

    def test_active_asset_bound_and_copied_only_if_used(self):
        picture = self.root / 'linked.png'
        picture.write_bytes(b'figure data')
        (self.root / 'unrelated.png').write_bytes(b'unrelated data')
        component = self.root / 'components/lower-bound-proof.tex'
        component.write_text(component.read_text() + r'\includegraphics{linked.png}')
        old, _ = manuscript.parse(self.main)
        picture.write_bytes(b'edited data')
        new, _ = manuscript.parse(self.main)
        self.assertNotEqual(old['snapshot_digest'], new['snapshot_digest'])
        snapshot = manuscript.materialize_snapshot(self.main, self.root / 'delivery')
        self.assertEqual((snapshot.parent / 'linked.png').read_bytes(), b'edited data')
        self.assertFalse((snapshot.parent / 'unrelated.png').exists())

    def test_rejects_circular_and_misplaced_active_dependencies(self):
        proof = self.root / 'components/lower-bound-proof.tex'
        old = proof.read_text()
        proof.write_text(r'By Theorem~\ref{ms:main}, the claim follows.')
        with self.assertRaisesRegex(manuscript.Invalid, 'unclosed result or forms a cycle'):
            manuscript.parse(self.main)
        proof.write_text(old)
        self.add_retired_branch()
        proof.write_text(r'By Lemma~\ref{ms:retired}, the claim follows.')
        with self.assertRaisesRegex(manuscript.Invalid, 'placed under its first direct user'):
            manuscript.parse(self.main)
        proof.write_text(old)
        main_proof = self.root / 'components/main-proof.tex'
        main_proof.write_text(r'By Lemma~\ref{ms:retired}, the claim follows.')
        with self.assertRaisesRegex(manuscript.Invalid, 'retired-proof has an unresolved reference'):
            manuscript.parse(self.main)

    def test_detects_gap_without_confusing_local_paired_formula_for_dependency(self):
        target = self.root / 'components/main.tex'
        target.write_text(r'\begin{equation}x=1\label{eq:main}\end{equation}')
        proof = self.root / 'components/main-proof.tex'
        proof.write_text(proof.read_text() + r' To prove \eqref{eq:main}, use \MSgap{an actual argument}.')
        clean, full = manuscript.parse(self.main)
        self.assertEqual(clean['open_obligations'], ['main-proof'])
        byid = {item['id']: item for item in full['components']}
        self.assertEqual(byid['main-proof']['deps'], ['lower-bound'])

    def test_opening_packet_withholds_hidden_body_and_proof(self):
        setting = self.root / 'components/setting.tex'
        setting.write_text('% CONFIDENTIAL COMMENT\nPublic mathematical opening.\n\nHIDDEN SECOND PARAGRAPH.')
        opening = manuscript.review_payload(self.main, 'setting', 'opening')
        self.assertEqual(opening['current_text'], 'Public mathematical opening.')
        self.assertNotIn('CONFIDENTIAL', json.dumps(opening))
        self.assertNotIn('HIDDEN', json.dumps(opening))
        self.assertTrue(opening['source_blind'])
        expression = manuscript.review_payload(self.main, 'setting', 'expression')
        self.assertIn('HIDDEN SECOND PARAGRAPH', expression['current_text'])
        statement = manuscript.review_payload(self.main, 'main', 'mathematics')
        self.assertNotIn('paired_proof_limited_application_check', statement)
        sources = manuscript.review_payload(self.main, 'main', 'sources')
        self.assertFalse(sources['source_blind'])
        self.assertNotIn('paired_proof_limited_application_check', sources)

    def test_materializes_over_empty_caller_directory(self):
        destination = self.root / 'delivery'
        destination.mkdir()
        result = manuscript.materialize_snapshot(self.main, destination)
        self.assertEqual(result, destination.resolve() / 'main.tex')
        self.assertTrue(result.is_file())
        with self.assertRaisesRegex(manuscript.Invalid, 'new or empty'):
            manuscript.materialize_snapshot(self.main, destination)

    @unittest.skipUnless(shutil.which('pdflatex'), 'requires local TeX')
    def test_rendered_navigation_after_filtering(self):
        try:
            import pypdf  # noqa: F401
        except ImportError:
            if not shutil.which('pdftotext'):
                self.skipTest('requires PDF text extraction')
        self.add_second_root()
        self.add_retired_branch()
        numbers = manuscript.verify_numbering(self.main)
        self.assertEqual(numbers['ms:second'], '1.2')
        self.assertEqual(numbers['proof:main-proof'], '2.1')
        self.assertEqual(numbers['proof:lower-bound-proof'], '2.1.1')
        self.assertNotIn('proof:retired-proof', numbers)


if __name__ == '__main__':
    unittest.main()
