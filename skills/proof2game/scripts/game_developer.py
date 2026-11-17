#!/usr/bin/env python3
"""Export a verified game script as a bilingual macOS game."""
import argparse
from datetime import date
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import quote, unquote, urlsplit

import manuscript
from sources import published_by


class Rejected(ValueError):
    pass


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()


def braced(text, start):
    """Read a literal balanced group, preserving TeX bytes inside it."""
    if start >= len(text) or text[start] != '{':
        return None
    depth = 1
    for i in range(start + 1, len(text)):
        escaped = 0
        j = i - 1
        while j >= 0 and text[j] == '\\':
            escaped += 1
            j -= 1
        if escaped % 2:
            continue
        if text[i] == '{':
            depth += 1
        elif text[i] == '}':
            depth -= 1
            if not depth:
                return text[start + 1:i], i + 1
    return None


def macro_definitions(text):
    pattern = r'\\(?:newcommand|renewcommand|providecommand)\*?\s*(?:\{\\([A-Za-z]+)\}|\\([A-Za-z]+))\s*(?:\[(\d)\]\s*)?(?:\[[^\]]*\]\s*)?(?=\{)'
    for m in re.finditer(pattern, text):
        group = braced(text, m.end())
        if group:
            yield dict(name=m[1] or m[2], args=int(m[3] or 0), body=group[0], start=m.start(), end=group[1])


def math_macros(files):
    """Expose simple literal mathematical aliases; full original TeX is retained."""
    result = {}
    for name, data in files.items():
        if Path(name).suffix not in ('.tex', '.sty'):
            continue
        text = manuscript.uncomment(data.decode('utf-8'))
        for macro in macro_definitions(text):
            if macro['name'].startswith('MS') or re.search(r'\\(?:if|input|include|def|newcommand|begin|end|write|csname)', macro['body']):
                continue
            result['\\' + macro['name']] = macro['body']
        for m in re.finditer(r'\\DeclareMathOperator(\*?)\s*\{\\([A-Za-z]+)\}\s*(?=\{)', text):
            group = braced(text, m.end())
            if group:
                result['\\' + m[2]] = '\\operatorname' + m[1] + '{' + group[0] + '}'
    return result


def referenced_images(text, files):
    images = []
    for m in re.finditer(r'\\includegraphics\*?\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}', manuscript.uncomment(text)):
        for suffix in ('', '.png', '.jpg', '.jpeg', '.webp'):
            name = m[1].strip() + suffix
            if name in files and Path(name).suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp'):
                if 'snapshot/' + name not in images:
                    images.append('snapshot/' + name)
                break
    return images


def eligibility(main, approval=None):
    main = Path(main).resolve(strict=True)
    approval = Path(approval or main.with_name('approval.json')).resolve(strict=True)
    data = approval.read_bytes()
    record = json.loads(data)
    clean, full = manuscript.parse(main)
    component_ids = record.get('components') if isinstance(record, dict) else None
    expected_ids = {component['id'] for component in full['components']}
    if not isinstance(record, dict) or record.get('schema') != 1 or any((
        record.get('snapshot_digest') != clean['snapshot_digest'],
        not isinstance(component_ids, list) or len(component_ids) != len(expected_ids) or
        any(not isinstance(cid, str) or cid not in expected_ids for cid in component_ids) or
        len(set(component_ids)) != len(component_ids),
        'cutoff' not in record,
        record.get('math_review') != 'pass',
        record.get('proof_obligations') != 'closed',
        record.get('route_review') != 'pass',
    )):
        raise Rejected('The delivery certificate must close mathematical and route reviews for this exact active script.')
    project_type, cutoff = record.get('project_type'), record.get('cutoff')
    if project_type == 'public':
        try:
            if date.fromisoformat(cutoff).isoformat() != cutoff:
                raise ValueError(cutoff)
        except (ValueError, TypeError) as exc:
            raise Rejected('A public literature delivery needs the exact public version date.') from exc
    elif project_type != 'unpublished' or cutoff is not None:
        raise Rejected('Invalid project type or publication cutoff in the delivery certificate.')
    return clean, full, approval, data, record


def resource_closure(main, full):
    """Read only the same resources that were bound during snapshot validation."""
    main = Path(main).resolve()
    root = main.parent
    resources = full['resources']
    names = {main.name, *(c['path'] for c in full['components']), *resources}
    files = {}
    for name in sorted(names):
        source = manuscript.local_file(root, name)
        if source.suffix.lower() not in ('.tex', '.sty', '.cls', '.def', '.cfg', '.clo', '.bib', '.png', '.jpg', '.jpeg', '.webp'):
            raise Rejected('Unsupported game resource: ' + name + '. Game figures must be PNG, JPEG or WebP.')
        data = source.read_bytes()
        if name in resources and sha(data) != resources[name]:
            raise Rejected('Verified resource changed before packaging: ' + name)
        if source.suffix.lower() in ('.tex', '.sty', '.cls', '.def', '.cfg', '.clo', '.bib') and (
                root.as_posix().encode() in data or
                re.search(rb'(?i)mathmatician|mathematician-plugin|mathematician[ -]skill|\.mathematician[/\\]', data)):
            raise Rejected('Manuscript contains a local path or private workflow detail: ' + name)
        files[name] = data
    return files


DISPLAY = re.compile(r'\\begin\{(align\*?|alignat\*?|flalign\*?|equation\*?|gather\*?|multline\*?)\}[\s\S]*?\\end\{\1\}|\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]')
LABEL = re.compile(r'\\label\s*\{([^{}]+)\}')


def display_rows(text):
    """Split top-level amsmath rows, leaving nested aligned/matrix rows intact."""
    start, braces, environments = 0, 0, []
    for token in re.finditer(r'\\(begin|end)\{([^{}]+)\}|(?<!\\)[{}]|\\\\(?:\[[^\]]*\])?', text):
        value = token[0]
        if token[1] == 'begin':
            environments.append(token[2])
        elif token[1] == 'end':
            if environments and environments[-1] == token[2]:
                environments.pop()
        elif value == '{':
            braces += 1
        elif value == '}':
            braces -= 1
        elif value.startswith('\\\\') and not braces and not environments:
            yield text[start:token.start()], value
            start = token.end()
    yield text[start:], ''


def numbered_display(match, cid, index):
    """Temporary labels recover actual numbers for otherwise-unlabelled rows."""
    original = match[0]
    numbered = bool(match[1] and not match[1].endswith('*'))
    if match[1]:
        opening, closing = '\\begin{' + match[1] + '}', '\\end{' + match[1] + '}'
    else:
        opening, closing = ('$$', '$$') if original.startswith('$$') else ('\\[', '\\]')
    body = original[len(opening):-len(closing)]
    rows = list(display_rows(body)) if match[1] and match[1].removesuffix('*') in ('align', 'alignat', 'flalign', 'gather') else [(body, '')]
    output, keys = [], []
    for row_index, (row, separator) in enumerate(rows, 1):
        labels = LABEL.findall(manuscript.uncomment(row))
        has_number = (numbered and not re.search(r'\\(?:nonumber|notag)\b', row)) or re.search(r'\\tag\*?\s*\{', row)
        if not labels and row.strip() and has_number:
            key = f'display:{cid}:{index}' + (f':{row_index}' if len(rows) > 1 else '')
            row += '\\label{' + key + '}'
            labels = [key]
        keys.extend(labels)
        output.append(row + separator)
    if not keys:
        keys = [f'display:{cid}:{index}']
    return opening + ''.join(output) + closing, keys


def verified_numbers(main, files, full):
    """Compile a private copy, never trust a stale author-side aux or guess counters."""
    text = files[Path(main).name].decode()
    hint = re.search(r'^%\s*!\s*TeX\s+program\s*=\s*(\w+)', text, re.I | re.M)
    engines = [hint[1].lower()] if hint else ['pdflatex', 'lualatex', 'xelatex']
    if any(name not in ('pdflatex', 'lualatex', 'xelatex') for name in engines):
        raise Rejected('Unsupported TeX engine directive for numbering verification.')
    engine = next((shutil.which(name) for name in engines if shutil.which(name)), None)
    if not engine:
        raise Rejected('Verified manuscript numbering requires an available TeX engine on the author computer; readiness checking does not require compilation.')
    with tempfile.TemporaryDirectory(prefix='proof2game-numbering-') as folder:
        root = Path(folder)
        instrumented = dict(files)
        for component in full['components']:
            index = 0
            def add_labels(match):
                nonlocal index
                index += 1
                return numbered_display(match, component['id'], index)[0]
            rendered = DISPLAY.sub(add_labels, manuscript.uncomment(component['text']))
            instrumented[component['path']] = rendered.encode()
        for name, data in instrumented.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        environment = dict(os.environ, openin_any='p', openout_any='p')
        for _ in range(3):
            try:
                result = subprocess.run([engine, '-no-shell-escape', '-interaction=nonstopmode',
                    '-halt-on-error', Path(main).name], cwd=root, capture_output=True, timeout=90, env=environment)
            except subprocess.TimeoutExpired as exc:
                raise Rejected('Private TeX numbering verification timed out.') from exc
            if result.returncode:
                log = result.stdout.decode(errors='replace')
                errors = [line for line in log.splitlines() if line.startswith('!')]
                raise Rejected('Private TeX numbering verification failed: ' + '\n'.join(errors[-3:]))
        aux = root / Path(main).with_suffix('.aux').name
        if not aux.is_file():
            raise Rejected('Private TeX compilation produced no reference numbers.')
        numbers = {}
        for match in re.finditer(r'\\newlabel\{([^{}]+)\}\{(?=\{)', aux.read_text()):
            group = braced(aux.read_text(), match.end())
            if group and group[0]:
                number = group[0]
                while number.startswith('{'):
                    outer = braced(number, 0)
                    if not outer or outer[1] != len(number):
                        break
                    number = outer[0]
                if match[1] in numbers and numbers[match[1]] != number:
                    raise Rejected('Ambiguous compiled reference number: ' + match[1])
                numbers[match[1]] = number
        return numbers


def source_references(files, source_bindings=None, references_dir=None, cutoff=None):
    """Resolve cited keys through explicit source bindings; never search by title."""
    text = '\n'.join(manuscript.uncomment(data.decode()) for name, data in files.items()
                     if Path(name).suffix in ('.tex', '.bib'))
    keys = set()
    for match in re.finditer(r'\\cite[A-Za-z]*\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^{}]+)\}', text):
        keys.update(key.strip() for key in match[1].split(',') if key.strip())
    if not keys:
        return [], {}
    paths = [Path(source_bindings).resolve()] if source_bindings else []
    if not source_bindings and references_dir:
        paths.extend(sorted(Path(references_dir).glob('*/source.json')))
    records = {}
    for path in paths:
        data = json.loads(path.read_text())
        rows = data.get('sources', [data]) if isinstance(data, dict) else data
        if not isinstance(rows, list):
            raise Rejected('Source bindings must contain source records.')
        for record in rows:
            if not isinstance(record, dict):
                raise Rejected('Source bindings must be objects.')
            key = record.get('citation_key') or record.get('id') or record.get('key')
            if not isinstance(key, str):
                raise Rejected('Source bindings need a string citation key.')
            if key not in keys:
                continue
            if record.get('complete') is not True:
                raise Rejected('Cited source intake is not complete: ' + key)
            if cutoff:
                public_date = record.get('public_date')
                try:
                    if not published_by(public_date, cutoff):
                        if not source_bindings:
                            continue
                        raise ValueError(public_date)
                except (TypeError, ValueError) as exc:
                    raise Rejected('Cited PDF version is not verified at the publication cutoff: ' + key) from exc
            if key in records:
                raise Rejected('Multiple eligible PDF versions need an explicit binding: ' + key)
            records[key] = (record, path.parent)
    missing = keys - records.keys()
    if missing:
        raise Rejected('Cited PDFs need explicit source bindings: ' + ', '.join(sorted(missing)))
    references, bundled = [], {}
    for key in sorted(keys):
        record, base = records[key]
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,99}', key) or '..' in key:
            raise Rejected('Unsafe citation key for PDF packaging: ' + key)
        source = Path(record.get('pdf_path') or record.get('pdf') or 'original.pdf')
        source = source if source.is_absolute() else base / source
        data = source.read_bytes()
        digest = sha(data)
        if not data.startswith(b'%PDF-') or digest != record.get('sha256'):
            raise Rejected('Cited PDF missing, invalid or changed: ' + key)
        pages = record.get('pages', record.get('page_count'))
        if type(pages) is not int or pages < 1:
            raise Rejected('Verified physical page count required for cited PDF: ' + key)
        file = 'references/' + key + '.pdf'
        authors = record.get('authors', [])
        if not isinstance(authors, list) or not all(isinstance(a, str) for a in authors):
            raise Rejected('Invalid source author attribution: ' + key)
        aliases = [key]
        surnames = [a.rsplit(' ', 1)[-1] for a in authors]
        if surnames:
            aliases.extend(['–'.join(surnames), '-'.join(surnames)])
        locators = record.get('cited_locations_physical_pages')
        if not isinstance(locators, dict) or not locators:
            raise Rejected('Verified physical citation locations are missing for: ' + key)
        locations = []
        for label, physical in locators.items():
            if not label.strip() or not isinstance(physical, list) or not physical or any(
                    type(p) is not int or not 1 <= p <= pages for p in physical):
                raise Rejected('Invalid cited physical page location: ' + key)
            locations.append(dict(label=label, page=physical[0], physical_pages=physical, match=re.escape(label)))
        references.append(dict(key=key, title=record.get('title') or key, authors=authors,
            edition=record.get('edition') or '', version=record.get('version') or '',
            public_date=record.get('public_date'), file=file,
            sha256=digest, pages=pages, aliases=list(dict.fromkeys(aliases)), default_page=locations[0]['page'],
            locations=locations, source_url=reference_url(record)))
        bundled[file] = data
    return references, bundled


def reference_metadata(full, levels, numbers, seed=None):
    refs = dict(seed or {})
    byid = {level['id']: level for level in levels}
    for level in levels:
        level['number'] = level['order'] + 1
        level['equations'] = []
        if level['type'] in ('statement', 'proof'):
            key = ('ms:' if level['type'] == 'statement' else 'proof:') + level['id']
            if key not in numbers:
                raise Rejected('Compiled manuscript number missing: ' + key)
            refs[key] = dict(number=numbers[key], level_id=level['id'], kind=level['type'],
                             name=level['kind'] if level['type'] == 'statement' else 'Section')
        equations = manuscript.equation_labels(level['text'])
        for match in LABEL.finditer(manuscript.uncomment(level['text'])):
            key = match[1]
            if key not in numbers:
                raise Rejected('Compiled manuscript label missing: ' + key)
            if key in refs and refs[key]['level_id'] != level['id']:
                raise Rejected('Duplicate internal reference: ' + key)
            refs[key] = dict(number=numbers[key], level_id=level['id'],
                kind='equation' if key in equations else 'statement',
                name='Equation' if key in equations else level['kind'] or 'Theorem')
        for index, match in enumerate(DISPLAY.finditer(manuscript.uncomment(level['text'])), 1):
            _, keys = numbered_display(match, level['id'], index)
            for key in keys:
                if key not in refs:
                    refs[key] = dict(number=numbers.get(key, f'L{level["number"]:02d}.{index}'),
                                     level_id=level['id'], kind='equation', name='Equation')
            level['equations'].append(dict(index=index, references=keys))
    for level in levels:
        if level['type'] in ('statement', 'proof'):
            level['statement_number'] = numbers['ms:' + (level['id'] if level['type'] == 'statement' else level['paired'])]
    # Explicit structural labels in main.tex point to the first level in that
    # scope; the complete target remains its actual level page, not a new reader.
    for component in full['components']:
        for key in LABEL.findall(manuscript.uncomment(component['preceding_prose'])):
            number = numbers.get(key)
            if number and key not in refs and (component['location'] == number or component['location'].startswith(number + '.')):
                refs[key] = dict(number=numbers[key], level_id=component['id'], kind='section', name='Section')
    for level in levels:
        for key in re.findall(r'\\(?:ref|eqref|autoref)\s*\{([^{}]+)\}', manuscript.uncomment(level['text'])):
            if key not in refs:
                raise Rejected('Unresolved internal game reference: ' + key)
    return refs


def translation_input(structure, files):
    hashes = {name: sha(data) for name, data in files.items()}
    return dict(schema=1, source_digest=sha(canonical([structure, hashes])),
                files={name: data.decode('utf-8') for name, data in files.items()
                       if Path(name).suffix.lower() == '.tex'})


TRANSLATION_MATH = re.compile(
    DISPLAY.pattern + r'|\\\([\s\S]*?\\\)|(?<!\\)\$(?!\$)(?:\\.|[^$])*?(?<!\\)\$'
)
TRANSLATION_LINK = re.compile(
    r'\\(?:label|ref|eqref|autoref|pageref|cite[A-Za-z]*|input|include|includegraphics)\*?'
    r'\s*(?:\[[^\]]*\]\s*){0,2}\{[^{}]+\}(?:\*\{[^{}]*\})?'
)


def validate_translation(original, translated, main_name):
    """Check snapshot coverage and anchors; the translator judges semantic fidelity."""
    if not isinstance(translated, dict) or translated.get('schema') != 1 or (
            translated.get('source_digest') != original['source_digest']):
        raise Rejected('The Chinese translation does not match the current game script snapshot.')
    files = translated.get('files')
    if not isinstance(files, dict) or (
            files.keys() != original['files'].keys()):
        raise Rejected('The Chinese translation must include every game script TeX file.')
    chinese_prose = False
    for name, source in original['files'].items():
        target = files[name]
        if not isinstance(target, str) or (source.strip() and not target.strip()):
            raise Rejected('Missing Chinese translation of ' + name)
        if re.search(r'(?i)mathmatician|mathematician-plugin|mathematician[ -]skill|\.mathematician[/\\]', target):
            raise Rejected('The translation contains private workflow details in ' + name)
        src, dst = (manuscript.uncomment(s) for s in (source, target))
        for pattern in (TRANSLATION_MATH, TRANSLATION_LINK):
            if [m[0].strip() for m in pattern.finditer(src)] != [m[0].strip() for m in pattern.finditer(dst)]:
                raise Rejected('Chinese translation changed a formula, reference or resource command in ' + name)
        chinese_prose |= bool(re.search(r'[\u3400-\u9fff]', TRANSLATION_MATH.sub('', dst)))
    if not chinese_prose:
        raise Rejected('The supplied manuscript translation has no Chinese prose.')

    def structure(source):
        visible = manuscript.uncomment(source)
        start = visible.find(r'\begin{document}')
        end = visible.find(r'\end{document}', start)
        if start < 0 or end < 0:
            raise Rejected('Chinese translation must preserve the manuscript document boundaries.')
        return [(command, args) for command, args, _, _ in manuscript.commands(source[start:end])]

    english = structure(original['files'][main_name])
    chinese = structure(files[main_name])
    def structural_keys(commands):
        return [(command, args[:-1] if command == 'MScomponent' else args if command.startswith('MS') else [])
                for command, args in commands]
    if structural_keys(english) != structural_keys(chinese):
        raise Rejected('Chinese translation must retain the game script structure and component bindings.')
    level_titles = {args[0]: args[5] for command, args in chinese if command == 'MScomponent'}
    return dict(level_titles=level_titles, files=files)


def make_game(main, approval=None, source_bindings=None, references_dir=None,
              verify_numbering=True, translation=None, model='gpt-6.1-sol', reasoning='medium'):
    clean, full, checkpoint, state_bytes, record = eligibility(main, approval)
    main = Path(main).resolve()
    files = resource_closure(main, full)
    references, reference_files = source_references(files, source_bindings, references_dir, record['cutoff'])
    byid = {c['id']: c for c in full['components']}
    levels = []
    for c in full['components']:
        if c['type'] == 'proof':
            parent, target = c['paired'], byid[c['paired']]
        else:
            parent, target = c.get('node'), c
        context_text = '\n'.join(byid[x]['text'] for x in c['ambient'])
        levels.append(dict(id=c['id'], type=c['type'], title=target['title'] or '',
            kind=target['kind'] if c['type'] != 'convention' else 'Convention',
            paired=c['paired'], parent=parent, order=len(levels), manuscript_order=c['order'],
            location=c['location'], structural_path=c['location'], section_title=c['heading'],
            source_file='snapshot/' + c['path'], text=c['text'], component_tex=c['text'],
            statement=target['text'],
            images=referenced_images(c['text'] + '\n' + target['text'] + '\n' + context_text, files),
            context=[dict(id=x, text=byid[x]['text']) for x in c['ambient']]))
    level_byid = {level['id']: level for level in levels}
    # Attach each canonical convention to the entrance of its existing scope.
    for c in full['components']:
        if c['type'] != 'convention':
            continue
        level = level_byid[c['id']]
        if c['section'] == 1:
            roots = [other for other in full['components'] if other['section'] == 1
                     and other['type'] == 'statement' and c['id'] in other['ambient']]
            shared = [byid[x] for x in c['ambient'] if byid[x]['type'] == 'convention'
                      and byid[x]['location'] == '1']
            level['parent'] = shared[-1]['id'] if shared else None
            level['owner'] = roots[0]['id'] if roots else None
            for other in roots:
                settings = [x for x in other['ambient'] if byid[x]['section'] == 1]
                if settings and settings[-1] == c['id']:
                    level_byid[other['id']]['parent'] = c['id']
        else:
            owner_id = c['node']
            owner = level_byid[owner_id]
            level['owner'], level['parent'] = owner_id, owner['parent']
            owner['parent'] = c['id']
        level['title'] = c['heading']
    for level in levels:
        if level['type'] == 'convention':
            level['title'] = 'Convention'
    numbers = verified_numbers(main, files, full) if verify_numbering else None
    internal = reference_metadata(full, levels, numbers) if numbers is not None else {}
    if numbers is not None:
        for c in full['components']:
            if c['type'] == 'convention' and c['section'] != 1:
                target = byid[c['node']]
                heading = f'Proof of {target["kind"]} {numbers["ms:" + target["id"]]}'
                if target['title']:
                    heading += ' · ' + target['title']
                level_byid[c['id']]['section_title'] = heading
    # A second parse/check catches concurrent source/checkpoint/resource changes.
    final = manuscript.parse(main)[0]
    if final != clean or checkpoint.read_bytes() != state_bytes:
        raise Rejected('Manuscript or review checkpoint changed during generation; retry after research is stable.')
    if resource_closure(main, full) != files:
        raise Rejected('Manuscript resources changed during generation.')
    if source_references(files, source_bindings, references_dir, record['cutoff']) != (references, reference_files):
        raise Rejected('Cited PDF bindings or bytes changed during generation.')
    source_hashes = {'snapshot/' + p: sha(data) for p, data in files.items()}
    hashes = dict(source_hashes)
    chinese = None
    if translation is not None:
        original = translation_input(clean['snapshot_digest'], files)
        translated = validate_translation(original, translation, main.name)
        translated_files = {'translation/zh/' + name: sha(text.encode())
                            for name, text in translated['files'].items()}
        hashes.update(translated_files)
        localized_levels = {}
        for level in levels:
            target = level['paired'] if level['type'] == 'proof' else level['id']
            source_file = level['source_file'].removeprefix('snapshot/')
            localized_levels[level['id']] = dict(
                title=translated['level_titles'][target],
                text=manuscript.uncomment(translated['files'][source_file]),
            )
        chinese = dict(files=sorted(translated_files),
                       levels=localized_levels)
    ref_hashes = {p: sha(data) for p, data in reference_files.items()}
    if sum(Path(p).suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp') for p in hashes) > 20:
        raise Rejected('More than 20 figure attachments require a supported larger-context loader; no figures were silently omitted.')
    # Progress imports bind to the canonical script and its exact citations.
    binding = sha(canonical(dict(structure=clean['snapshot_digest'], files=source_hashes,
                                 references=references, layout='canonical-components-v1',
                                 project_type=record['project_type'], cutoff=record['cutoff'],
                                 original_sha256=record.get('original_sha256'))))
    game = dict(schema=1, id=binding, app_name='Proof2Game', language='English',
        model=model, reasoning_effort=reasoning, snapshot_digest=binding,
        approval_snapshot_digest=clean['snapshot_digest'],
        project_type=record['project_type'], cutoff=record['cutoff'],
        levels=levels, snapshot_files=hashes, math_macros=math_macros(files),
        references=references, reference_files=ref_hashes, internal_references=internal,
        images=[p for p in sorted(hashes) if Path(p).suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp')],
        manuscript=dict(main='snapshot/' + main.name, files=sorted(source_hashes)))
    if chinese is not None:
        game['chinese'] = chinese
    return game, files, reference_files


def public_reference_url(value):
    if not isinstance(value, str) or any(char.isspace() or ord(char) < 32 for char in value):
        return ''
    try:
        url = urlsplit(value)
    except ValueError:
        return ''
    if url.scheme == 'https' and url.hostname and url.username is None and url.password is None:
        return value
    return ''


def reference_url(record):
    source = public_reference_url(record.get('record_url') or record.get('source_url'))
    doi = record.get('doi')
    if not doi:
        # Some completed intake records include the DOI in their verified version label.
        match = re.search(r'\bDOI (10[.][0-9]{4,9}/[^\s]+)$', record.get('version') or '', re.IGNORECASE)
        doi = match[1] if match else None
    if not doi and source:
        parsed = urlsplit(source)
        if parsed.hostname in ('doi.org', 'dx.doi.org', 'link.springer.com',
                               'onlinelibrary.wiley.com'):
            match = re.search(r'/((?:10[.][0-9]{4,9})/[^\s]+)$', unquote(parsed.path))
            doi = match[1] if match else None
    if doi:
        if not isinstance(doi, str) or not re.fullmatch(r'10[.][0-9]{4,9}/[^\s]+', doi):
            raise Rejected('Invalid DOI for citation: ' + record['citation_key'])
        return 'https://doi.org/' + quote(doi, safe='/():;')
    return source


def paper_metadata(record, metadata):
    if record['project_type'] != 'public':
        return None
    digest = record.get('original_sha256')
    if (not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest) or
            not isinstance(metadata, dict) or metadata.get('sha256') != digest):
        raise Rejected('Public game needs paper metadata bound to the approved original SHA-256.')
    title, authors, version = (metadata.get(key) for key in ('title', 'authors', 'version'))
    if (not isinstance(title, str) or not title.strip() or
            not isinstance(version, str) or not version.strip() or
            not isinstance(authors, list) or not authors or
            not all(isinstance(author, str) and author.strip() for author in authors)):
        raise Rejected('Public game needs the exact original title, authors and version.')
    return dict(title=title.strip(), authors=[author.strip() for author in authors], version=version.strip())


def export_pages(output, game, content, script, verify_delivery):
    """Stage a static site with game data and a launch page. Publication is separate."""
    for ref in game['references']:
        if not ref['source_url']:
            raise Rejected('A DOI or official HTTPS source link is required for: ' + ref['key'])
        ref.pop('sha256', None)
    game['distribution'] = 'pages'
    game['reference_files'] = {}
    data = {'game.json': canonical(game), **content}
    release = (script.parents[3] / 'VERSION').read_text(encoding='ascii').strip()
    if not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+', release):
        raise Rejected('Pages export requires a numbered Proof2Game release.')
    manifest = dict(schema=1, connector=release, files={
        name: dict(sha256=sha(payload), size=len(payload)) for name, payload in sorted(data.items())
    })
    if 'paper' in game:
        manifest['paper'] = game['paper']
    if len(data) > 2048 or sum(map(len, data.values())) > 128 * 1024 * 1024:
        raise Rejected('This game exceeds the Pages launch data limit.')
    assets = script.parents[1] / 'assets/pages-launch'
    with tempfile.TemporaryDirectory(prefix='.proof2game-pages-', dir=output.parent) as td:
        stage = Path(td) / 'site'
        shutil.copytree(assets, stage)
        (stage / '.nojekyll').touch()
        for name, payload in data.items():
            if (name != 'game.json' and not name.startswith(('snapshot/', 'translation/zh/'))) or any(
                not part or part.startswith('.') or any(c in '%\\?#' or ord(c) < 32 for c in part)
                for part in name.split('/')
            ):
                raise Rejected('Unsupported filename for Pages export: ' + name)
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
        (stage / 'proof2game.json').write_bytes(canonical(manifest) + b'\n')
        verify_delivery()
        if output.exists():
            raise Rejected('Output already exists; select a new name.')
        stage.rename(output)


def export(main, output, approval=None, source_bindings=None, references_dir=None, translation=None,
           model='gpt-6.1-sol', reasoning='medium', *, paper=None):
    if sys.platform != 'darwin':
        raise Rejected('Proof2Game generation is supported on macOS.')
    output = Path(output).resolve()
    if output.suffix.lower() == '.zip':
        raise Rejected('Output must be a new directory for the hosted game.')
    if output.exists():
        raise Rejected('Output already exists; select a new name to preserve the previous delivery.')
    if translation is None:
        raise Rejected('Export needs the complete Chinese translation. Use --prepare-translation first.')
    _, _, _, _, record = eligibility(main, approval)
    attribution = paper_metadata(record, paper)
    game, files, _ = make_game(main, approval, source_bindings, references_dir,
                                            translation=translation, model=model, reasoning=reasoning)
    if attribution is not None:
        game['paper'] = attribution
    chinese_files = {'translation/zh/' + name: source.encode()
                     for name, source in translation['files'].items()}
    if {name: sha(data) for name, data in chinese_files.items()} != {
            name: game['snapshot_files'][name] for name in game['chinese']['files']}:
        raise Rejected('The Chinese translation changed before packaging.')
    def verify_delivery():
        current, _, _, _, _ = eligibility(main, approval)
        if current['snapshot_digest'] != game['approval_snapshot_digest']:
            raise Rejected('The approved game script changed before delivery.')

    result = dict(ok=True, output=str(output), game_id=game['id'], levels=len(game['levels']),
                  approval_snapshot_digest=game['approval_snapshot_digest'], snapshot_files=len(files),
                  manuscript_preserved=True, runtime_validation='pending')
    script = Path(__file__).resolve()
    runtime = script.parents[1] / 'assets/game-runtime'
    release_license = script.parents[3] / 'LICENSE'
    if not release_license.is_file():
        raise Rejected('The Proof2Game release license is missing from the installation.')
    required = ('server.mjs', 'guide-diagram.mjs', 'index.html', 'app.js', 'style.css', 'vendor/katex.min.js',
                'vendor/katex.min.css', 'vendor/auto-render.min.js', 'vendor/LICENSE-KaTeX.txt',
                'vendor/fonts/OFL.txt')
    if not all((runtime / name).is_file() for name in required):
        raise Rejected('The installed game runtime is incomplete.')
    output.parent.mkdir(parents=True, exist_ok=True)
    export_pages(output, game, {'snapshot/' + name: data for name, data in files.items()} | chinese_files,
                 script, verify_delivery)
    return dict(result, distribution='pages', published=False)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--main', required=True)
    p.add_argument('--output')
    p.add_argument('--approval', help='Delivery certificate (default: approval.json beside the verified script).')
    p.add_argument('--references', help='The project references/ directory.')
    p.add_argument('--source-bindings', help='JSON records for the exact selected citation versions and page locations.')
    p.add_argument('--tutor-model', default='gpt-6.1-sol', help='The player tutor model.')
    p.add_argument('--tutor-reasoning', default='medium', choices=('low', 'medium', 'high', 'xhigh', 'max', 'ultra'))
    p.add_argument('--translation', help='Complete Chinese translation JSON from the mathematics translator.')
    action = p.add_mutually_exclusive_group()
    p.add_argument('--pages', action='store_true', help=argparse.SUPPRESS)
    p.add_argument('--paper-metadata', help='Exact original title, authors, version and original SHA-256 (public projects).')
    action.add_argument('--check', action='store_true', help='Read-only eligibility check; no website.')
    action.add_argument('--prepare-translation', action='store_true',
                        help='Print the eligible snapshot’s translation input JSON without generating a website.')
    args = p.parse_args()
    try:
        if args.prepare_translation:
            clean, full, _, _, _ = eligibility(args.main, args.approval)
            files = resource_closure(args.main, full)
            result = translation_input(clean['snapshot_digest'], files)
        elif args.check:
            game, _, _ = make_game(args.main, args.approval, args.source_bindings,
                                    args.references, verify_numbering=False)
            result = dict(ok=True, levels=len(game['levels']), snapshot_digest=game['snapshot_digest'],
                          approval_snapshot_digest=game['approval_snapshot_digest'])
        else:
            if not args.output:
                p.error('--output is required to export a game')
            if not args.translation:
                p.error('--translation is required to export a game')
            translation = json.loads(Path(args.translation).read_text(encoding='utf-8'))
            result = export(args.main, args.output, args.approval, args.source_bindings,
                            args.references, translation, args.tutor_model, args.tutor_reasoning,
                            paper=json.loads(Path(args.paper_metadata).read_text(encoding='utf-8'))
                            if args.paper_metadata else None)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (Rejected, manuscript.Invalid, OSError, ValueError) as exc:
        print(json.dumps(dict(ok=False, error=str(exc)), ensure_ascii=False))
        raise SystemExit(2)


if __name__ == '__main__':
    main()
