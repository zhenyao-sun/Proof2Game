#!/usr/bin/env python3
"""Compile the manuscript's literal TeX assembly to an ordered dependency graph."""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path


class Invalid(ValueError):
    """The script could not be interpreted or verified structurally."""


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def uncomment(s):
    # Preserve offsets into the original assembly for exact adjacent prose.
    # A percent is escaped only after an odd run of backslashes.
    chars=list(s)
    for match in re.finditer('%',s):
        pos=match.start();slashes=0
        while pos>0 and s[pos-1]=='\\':
            slashes+=1;pos-=1
        if slashes % 2 == 0:
            end=s.find('\n',match.start())
            if end<0:end=len(s)
            chars[match.start():end]=' '*(end-match.start())
    return ''.join(chars)

def equation_labels(text):
    """Identify literal display-math labels, not labels merely named eq:... .
    Comments do not establish label type; primary component labels remain result
    references even if repeated within a display. This is syntax, not proof checking.
    """
    displays={'equation','align','alignat','flalign','gather','multline','subequations'}
    stack=[]; occurrences={}
    tokens=r'\\(begin|end|label|tag\*?)\s*\{([^}]+)\}|\\([\[\]])'
    for token in re.finditer(tokens,uncomment(text)):
        command,value,bracket=token.groups()
        if bracket:command,value=('begin','[]') if bracket=='[' else ('end','[]')
        if command=='begin':
            stack.append({'name':value,'closed':False,'tagged':False})
        elif command=='end':
            if stack and stack[-1]['name']==value:stack.pop()['closed']=True
            else:stack.clear()
        elif command.startswith('tag'):
            for frame in reversed(stack):
                if frame['name'].removesuffix('*') in displays or frame['name']=='[]':
                    frame['tagged']=True;break
        elif command=='label':occurrences.setdefault(value,[]).append(tuple(stack))
    labels=set()
    for label,contexts in occurrences.items():
        if len(contexts)!=1:continue  # Ambiguous declarations never grant exemptions.
        frames=contexts[0]
        if not frames or not all(f['closed'] for f in frames):continue
        if any((f['name'] in displays or
                (f['tagged'] and (f['name']=='[]' or f['name'].removesuffix('*') in displays)))
               for f in frames):labels.add(label)
    return labels

ARITY = {'MScomponent': 6, 'MSnode': 2, 'MSendnode': 0, 'section': 1, 'subsection': 1,
         'subsubsection': 1, 'MSdecomposition': 2}
ASSEMBLY = re.compile(r'\\(' + '|'.join(ARITY) + r')\b')
LABEL = re.compile(r'\\label\s*\{([^{}]+)\}')
REFERENCE = re.compile(r'\\(?:ref|eqref|autoref)\s*\{([^{}]+)\}')
CITATION = re.compile(r'\\(?:cite|cites|citep|citet|citeauthor|citeyear)\*?(?:\s*\[[^\]]*\])*\s*\{([^{}]+)\}')
AT = re.compile(r'[A-Za-z][A-Za-z0-9:_-]*')
DYNAMIC = re.compile(
    r'\\(?:if(?!f\b)[A-Za-z@]*|else|fi|csname|endcsname|def|gdef|edef|xdef|let|futurelet|catcode|'
    r'expandafter|newcommand|renewcommand|providecommand|newenvironment|renewenvironment)\b'
)
RAW_INPUT = re.compile(r'\\(?:input|include|import|subimport|subfile|bibliography|addbibresource)\b')
RESOURCE = re.compile(
    r'\\(includegraphics\*?|input|include|usepackage|RequirePackage|documentclass|LoadClass)'
    r'(?:\s*\[[^\]]*\])*\s*\{([^{}]+)\}'
)
DEFAULT_REQUIRED = ('Main Results', 'Detailed Proofs')
THEOREM_KIND = re.compile(r'[A-Za-z][A-Za-z0-9]*')


def group(text, index):
    while index < len(text) and text[index].isspace():
        index += 1
    if index >= len(text) or text[index] != '{':
        raise Invalid('Expected literal braced TeX argument.')
    start = index + 1
    depth = 1
    index = start
    while index < len(text):
        char = text[index]
        if char == '\\':
            index += 2
            continue
        if char == '{':
            depth += 1
        elif char == '}':
            depth -= 1
            if not depth:
                return text[start:index], index + 1
        index += 1
    raise Invalid('Unbalanced literal TeX argument.')


def commands(text):
    """Literal structural commands in document order with raw replacement spans."""
    visible = uncomment(text)
    position = 0
    while match := ASSEMBLY.search(visible, position):
        name = match[1]
        position = match.end()
        arguments = []
        for _ in range(ARITY[name]):
            arg, position = group(visible, position)
            arguments.append(arg.strip())
        yield name, arguments, match.start(), position


def split_document(raw):
    visible = uncomment(raw)
    starts = list(re.finditer(r'\\begin\s*\{document\}', visible))
    finishes = list(re.finditer(r'\\end\s*\{document\}', visible))
    if len(starts) != 1 or len(finishes) != 1 or starts[0].end() > finishes[0].start():
        raise Invalid('Expected one explicit TeX document.')
    start, finish = starts[0], finishes[0]
    return raw[:start.end()], raw[start.end():finish.start()], raw[finish.start():]


def local_file(root, name, *, need=True):
    path = Path(name)
    if path.is_absolute() or not path.parts or any(part in ('..', '.') or part.startswith('.') for part in path.parts):
        raise Invalid(f'Expected a visible, project-relative file: {name}')
    if any(part in name for part in ('\\', '{', '}')):
        raise Invalid(f'Expected a literal relative filename: {name}')
    candidate = root / path
    resolved = candidate.resolve()
    if not resolved.is_relative_to(root):
        raise Invalid(f'File escapes the game script directory: {name}')
    if not resolved.is_file():
        if not need and not resolved.exists():
            return None
        raise Invalid(f'Required file is not present: {name}')
    return candidate


def resource_files(root, initial):
    """Read only explicitly invoked local support files, with their own local inputs."""
    resources = {}
    pending = list(initial)
    while pending:
        raw = pending.pop()
        visible = uncomment(raw)
        for match in RESOURCE.finditer(visible):
            command, values = match.groups()
            values = values.split(',') if command in ('usepackage', 'RequirePackage') else [values]
            for value in values:
                value = value.strip()
                if '#' in value:
                    continue  # Parameterized renderer macro, resolved by literal component declarations.
                suffix = Path(value).suffix
                if command.startswith('includegraphics'):
                    extensions = ('',) if suffix else ('.pdf', '.png', '.jpg', '.jpeg', '.mps', '.eps')
                elif command in ('usepackage', 'RequirePackage'):
                    extensions = ('',) if value.endswith('.sty') else ('.sty',)
                elif command in ('documentclass', 'LoadClass'):
                    extensions = ('',) if value.endswith('.cls') else ('.cls',)
                else:
                    extensions = ('',) if suffix else ('', '.tex')
                path = next((p for ext in extensions
                             if (p := local_file(root, value + ext, need=False))), None)
                if path is None:
                    if command.startswith('includegraphics'):
                        raise Invalid(f'Graphic not found: {value}; use a literal path relative to main.tex.')
                    if command in ('input', 'include'):
                        raise Invalid(f'TeX input not found in the game script directory: {value}')
                    continue  # TeX resolves distribution packages/classes at build time.
                name = path.relative_to(root).as_posix()
                if name in resources:
                    continue
                resources[name] = path.read_bytes()
                if not command.startswith('includegraphics'):
                    pending.append(resources[name].decode('utf-8'))
    return resources


def reference_ids(component, labels, byid, inline_labels):
    refs = []
    unknown = []
    for label in REFERENCE.findall(uncomment(component['text'])):
        dep = labels.get(label)
        if dep is None:
            if label not in inline_labels:
                unknown.append(label)
            continue
        if dep == component['id']:
            continue
        if component['type'] == 'proof' and dep == component['paired'] and label in byid[dep]['equation_labels']:
            # The displayed equation names this proof's own obligation.
            continue
        if dep not in refs:
            refs.append(dep)
    return refs, unknown


def dependency_cone(targets, byid):
    result = set()
    pending = list(targets)
    while pending:
        cid = pending.pop()
        if cid in result:
            continue
        result.add(cid)
        component = byid[cid]
        pending.extend([*component['ambient'], *component['references']])
        if component['paired']:
            pending.append(component['paired'])
    return result


def validate_dependencies(components, byid, all_nodes, targets, cone, unknown):
    for component in components:
        cid = component['id']
        if cid not in cone:
            continue
        if unknown[cid]:
            raise Invalid(f'{cid} has an unresolved reference: {unknown[cid][0]}')
        for dep in component['references']:
            referred = byid[dep]
            if referred['order'] >= component['order']:
                raise Invalid(f'{cid} uses {dep} before it is declared.')
            if referred['type'] == 'convention' and dep not in component['ambient']:
                raise Invalid(f'{cid} uses convention {dep} from outside its declared scope.')
        if component['type'] == 'statement' and component['section'] == 2:
            parent_proof = byid[byid[component['node']]['paired']]
            if cid not in parent_proof['deps']:
                raise Invalid(f'{cid} must be placed under its first direct user, not {parent_proof["id"]}.')

    nodes = {node['target']: node for node in all_nodes}
    closed = set()

    def check(component):
        missing = set(component['deps']) - closed
        if missing:
            raise Invalid(f'{component["id"]} uses an unclosed result or forms a cycle: {", ".join(sorted(missing))}.')

    # Iterative exit-order traversal has no artificial depth limit.
    visits = [(target, False) for target in reversed(targets)]
    while visits:
        target, leaving = visits.pop()
        node = nodes[target]
        if leaving:
            check(byid[byid[target]['paired']])
            closed.add(target)
        else:
            check(byid[target])
            for cid in dict.fromkeys(node['ambient'] + node['direct']):
                component = byid[cid]
                if component['type'] == 'convention' and cid in cone:
                    check(component)
            visits.append((target, True))
            visits.extend((child, False) for child in reversed(node['children']) if child in cone)



def nonempty_paragraphs(text):
    return [part.strip() for part in re.split(r'\n\s*\n', uncomment(text)) if part.strip()]


def preceding_proof_excerpt(text):
    paragraphs = nonempty_paragraphs(text)
    if len(paragraphs) > 1 and len(paragraphs[-1]) <= 700:
        return paragraphs[-1]
    return ''


def parse(main):
    clean, full, _, _ = read_assembly(main)
    return clean, full


def read_assembly(main):
    main = Path(main).resolve(strict=True)
    prefix, body, suffix = split_document(main.read_bytes().decode('utf-8'))
    visible_body = uncomment(body)
    if DYNAMIC.search(visible_body) or RAW_INPUT.search(visible_body):
        raise Invalid('Use literal canonical assembly in main.tex, and put renderer definitions in the preamble.')
    root = main.parent
    seen_sections, block_stack, targets, settings = [], [], [], []
    components, nodes, stack, events, byid = [], [], [], [], {}
    paths, node_targets = set(), set()
    roots = []
    section, block = 0, 0
    main_heading = DEFAULT_REQUIRED[0]
    next_start = 0
    settings_per_block = {}

    for command, args, start, end in commands(body):
        preceding = body[next_start:start]
        next_start = end
        event = {'start': start, 'end': end, 'command': command, 'node': stack[-1]['target'] if stack else None}
        events.append(event)
        if command == 'section':
            if stack or len(seen_sections) >= len(DEFAULT_REQUIRED) or args[0] != DEFAULT_REQUIRED[len(seen_sections)]:
                raise Invalid('Expected precisely Main Results followed by Detailed Proofs.')
            seen_sections.append(args[0])
            section += 1
            continue
        if command == 'subsection':
            if section != 1:
                raise Invalid('Detailed Proofs headings come from MSnode.')
            block += 1
            main_heading = args[0]
            block_stack.append(block)
            event['block'] = block
            continue
        if command in ('subsubsection', 'MSdecomposition'):
            raise Invalid('Use Main Results context subsections and the single Detailed Proofs tree.')
        if command == 'MSnode':
            target, adoption = args
            if section != 2 or target not in byid or byid[target]['type'] != 'statement':
                raise Invalid('A Detailed Proofs node must refer to an already declared statement.')
            if target in node_targets:
                raise Invalid(f'Duplicate proof node: {target}')
            node_targets.add(target)
            parent = stack[-1] if stack else None
            inherited = list(byid[target]['ambient'])
            if parent is None:
                if len(roots) >= len(targets) or targets[len(roots)] != target:
                    raise Invalid('Proof tree roots must follow Main Results statement order.')
                if not adoption.isascii() or not adoption.isdecimal() or int(adoption) != len(inherited):
                    raise Invalid(f'{target} must explicitly adopt its statement’s full Main Results prefix ({len(inherited)}).')
                roots.append(target)
                location = f'2.{len(roots)}'
            else:
                if adoption or not parent['proof'] or target not in parent['children']:
                    raise Invalid('Child nodes follow their parent proof and inherit the declaration context.')
                index = len(parent['expanded'])
                if index >= len(parent['children']) or target != parent['children'][index]:
                    raise Invalid('Child nodes must expand their statements in declaration order.')
                parent['expanded'].append(target)
                location = f'{parent["location"]}.{len(parent["expanded"])}'
            statement = byid[target]
            title_prefix = f'{statement["title"]}: ' if statement['title'] else ''
            node = {'target': target, 'ambient': inherited, 'children': [], 'expanded': [],
                    'direct': [], 'parent': parent['target'] if parent else None, 'proof': None,
                    'depth': len(stack) + 1, 'location': location,
                    'heading': f'{title_prefix}Proof of {statement["kind"]} {target}'}
            stack.append(node)
            nodes.append(node)
            event['node'] = target
            continue
        if command == 'MSendnode':
            if not stack:
                raise Invalid('Unmatched MSendnode.')
            node = stack.pop()
            if node['proof'] != byid[node['target']]['paired'] or node['expanded'] != node['children']:
                raise Invalid(f'{node["target"]} needs its paired proof and all child nodes in declaration order.')
            continue
        cid, kind_type, name, pair, kind, title = args
        if not AT.fullmatch(cid) or cid in byid:
            raise Invalid(f'Invalid or repeated component ID: {cid}')
        if kind_type not in ('convention', 'statement', 'proof'):
            raise Invalid(f'Unsupported component type: {kind_type}')
        if kind_type == 'statement':
            if not THEOREM_KIND.fullmatch(kind) or not AT.fullmatch(pair):
                raise Invalid(f'{cid} needs a theorem kind and a stable paired proof ID.')
        elif kind or title or (kind_type == 'convention' and pair) or (kind_type == 'proof' and not AT.fullmatch(pair)):
            raise Invalid(f'Malformed type, pair or metadata for {cid}.')
        source = local_file(root, name)
        if source.resolve() == main or source.resolve() in paths or source.suffix != '.tex':
            raise Invalid(f'{cid} needs its own distinct component .tex file.')
        paths.add(source.resolve())
        text = source.read_bytes().decode('utf-8')
        visible = uncomment(text)
        if DYNAMIC.search(visible) or RAW_INPUT.search(visible) or ASSEMBLY.search(visible):
            raise Invalid(f'{cid} contains unsupported nested assembly.')
        ambient = list(settings)
        location = '1' if block == 0 else f'1.{block}'
        heading = main_heading
        if section == 1:
            if kind_type == 'proof':
                raise Invalid('Proofs belong to Detailed Proofs.')
            if kind_type == 'convention':
                if block in settings_per_block or any(c['location'] == location for c in components):
                    raise Invalid('A Main Results convention must be the first and only convention of its block.')
                settings.append(cid)
                settings_per_block[block] = cid
            else:
                targets.append(cid)
            event['block'] = block
        elif section == 2 and stack:
            node = stack[-1]
            if node['proof']:
                raise Invalid('Each node has only a local convention, child statements, and its paired proof, in that order.')
            if kind_type == 'convention' and node['direct']:
                raise Invalid('A local convention must be the first direct input of its proof node.')
            ambient = list(node['ambient'])
            location = node['location']
            heading = node['heading']
            if kind_type == 'convention':
                node['ambient'].append(cid)
            elif kind_type == 'statement':
                node['children'].append(cid)
            else:
                if pair != node['target']:
                    raise Invalid(f'{cid} is not the proof of the current node target {node["target"]}.')
                node['proof'] = cid
            node['direct'].append(cid)
        else:
            raise Invalid('Components belong to Main Results or a Detailed Proofs node.')
        transition = uncomment(preceding) + '\n' + heading
        if components and kind_type == 'statement':
            previous = components[-1]
            excerpt = (preceding_proof_excerpt(previous['text']) if previous['type'] == 'proof'
                       else uncomment(previous['text']))
            transition += '\n' + previous['id'] + '\n' + excerpt
        component = {
            'id': cid, 'type': kind_type, 'path': source.relative_to(root).as_posix(), 'paired': pair or None,
            'kind': kind, 'title': title, 'order': len(components), 'section': section, 'location': location,
            'heading': heading, 'ambient': ambient, 'deps': [], 'digest': digest(text),
            'transition_digest': digest(transition), 'text': text,
            'preceding_prose': preceding, 'equation_labels': sorted(equation_labels(text)),
            'adoption_prefix': {'section1': sum(a in settings for a in ambient)},
        }
        if section == 2:
            component['node'] = stack[-1]['target']
        byid[cid] = component
        components.append(component)
        event['component'] = cid

    if tuple(seen_sections) != DEFAULT_REQUIRED or stack or roots != targets:
        raise Invalid('Both required sections, balanced nodes and one root per Main Results statement are required.')
    if any(index not in settings_per_block for index in block_stack):
        raise Invalid('Each numbered Main Results context block needs its own leading convention.')

    labels = {}
    declared_inline = LABEL.findall(visible_body)
    inline_labels = set(declared_inline)
    if len(inline_labels) != len(declared_inline):
        raise Invalid('Repeated label in the main.tex assembly.')
    for component in components:
        cid = component['id']
        kind_type = component['type']
        if component['paired']:
            partner = byid.get(component['paired'])
            expected = 'statement' if kind_type == 'proof' else 'proof'
            if not partner or partner['type'] != expected or partner['paired'] != cid:
                raise Invalid(f'{cid} does not have a unique reciprocal statement/proof pair.')
        registries = LABEL.findall(uncomment(component['text']))
        if kind_type != 'convention':
            registries.append(('ms:' if kind_type == 'statement' else 'proof:') + cid)
        for label in registries:
            if label in labels or label in inline_labels:
                raise Invalid(f'Duplicate TeX label: {label}')
            labels[label] = cid
    unknown = {}
    for component in components:
        cid = component['id']
        refs, unknown[cid] = reference_ids(component, labels, byid, inline_labels)
        component['references'] = refs
        deps = []
        for ref in refs:
            target = byid[ref]
            statement = target['paired'] if target['type'] == 'proof' else ref
            if target['type'] != 'convention' and statement not in deps:
                deps.append(statement)
        component['deps'] = deps
        component['reference_labels'] = {label: labels[label] for label in REFERENCE.findall(uncomment(component['text']))
                                         if label in labels}

    cone = dependency_cone(targets, byid)
    validate_dependencies(components, byid, nodes, targets, cone, unknown)
    selected = filtered_body(body, events, components, cone)
    common = resource_files(root, [prefix, selected])
    resources = dict(common)
    for component in components:
        if component['id'] in cone:
            rendering_files = resource_files(root, [component['text']])
            resources.update(rendering_files)
        else:
            # An inactive branch may refer to an unavailable figure. It stays
            # outside this review and will be checked if readmitted.
            rendering_files = {}
        bound = {name: hashlib.sha256(data).hexdigest() for name, data in (common | rendering_files).items()}
        component['renderer_digest'] = digest(json.dumps([prefix, bound], sort_keys=True))
    shared = {
        'schema': 1, 'validated': True, 'validation_scope': 'literal TeX assembly and dependency order',
        'main_digest': digest(prefix + body + suffix), 'targets': targets, 'nodes': nodes,
        'main_results': [c['id'] for c in components if c['section'] == 1],
        'cone': [c['id'] for c in components if c['id'] in cone],
        'open_obligations': [c['id'] for c in components if c['id'] in cone and c['type'] == 'proof'
                             and (not uncomment(c['text']).strip() or re.search(r'\\MSgap\b', uncomment(c['text'])))],
        'resources': {name: hashlib.sha256(data).hexdigest() for name, data in resources.items()},
    }
    private = ('text', 'preceding_prose', 'equation_labels', 'reference_labels')
    clean = dict(shared, components=[{k: v for k, v in c.items() if k not in private} for c in components])
    clean['snapshot_digest'] = digest(json.dumps(clean, sort_keys=True))
    full = dict(clean, components=components)
    return clean, full, (prefix, body, suffix, events), resources


def cited_keys(text):
    return {key.strip() for cluster in CITATION.findall(uncomment(text))
            for key in cluster.split(',') if key.strip()}


def filtered_body(body, events, components, cone):
    """Remove inactive inputs, whole inactive subtrees and empty Main Results blocks."""
    active = set(cone)
    blocks = {int(c['location'].split('.')[1]) for c in components
              if c['id'] in active and c['section'] == 1 and '.' in c['location']}
    parts = []
    position = 0
    for event in events:
        command = event['command']
        start, end = event['start'], event['end']
        keep = event.get('node') is None or event['node'] in active
        if command == 'subsection':
            keep = event['block'] in blocks
        if command == 'MScomponent':
            keep = event['component'] in active
        if keep:
            parts.append(body[position:end])
        else:
            # Keep inter-command line endings separated. Do not retain prose
            # attached to a discarded declaration or entire proof node.
            parts.append('\n')
        position = end
    parts.append(body[position:])
    return ''.join(parts)


def prune_bibliography(body, keep):
    """Filter inline amsrefs bibliography entries while preserving their order."""
    apparent = uncomment(body)
    pattern = re.compile(r'\\bib\b')
    kept = []
    position = 0
    while match := pattern.search(apparent, position):
        key, end = group(apparent, match.end())
        _, end = group(apparent, end)
        _, end = group(apparent, end)
        kept.append(body[position:match.start()])
        if key.strip() in keep:
            kept.append(body[match.start():end])
        position = end
    kept.append(body[position:])
    return ''.join(kept)


def materialize_snapshot(source_main, destination):
    """Write the current dependency cone and its resources to an empty destination."""
    source_main = Path(source_main).resolve(strict=True)
    current, full, (prefix, body, suffix, events), resources = read_assembly(source_main)
    destination = Path(destination).resolve()
    if destination == source_main.parent:
        raise Invalid('Use an isolated snapshot directory.')
    if destination.exists() and (not destination.is_dir() or any(destination.iterdir())):
        raise Invalid('Use a new or empty snapshot directory.')
    if not current['targets']:
        raise Invalid('A game or manuscript snapshot requires at least one active target.')
    active = [c for c in full['components'] if c['id'] in current['cone']]
    selected = filtered_body(body, events, full['components'], current['cone'])
    # Citations belong to active components, retained prose or renderer support.
    # Citation commands inside bibliography entries must not preserve those entries.
    bibliography = re.search(r'\\begin\s*\{bibdiv\}', uncomment(selected))
    narrative = selected[:bibliography.start()] if bibliography else selected
    kept_sources = [prefix, narrative, *(c['text'] for c in active)]
    kept_sources.extend(data.decode('utf-8') for name, data in resources.items()
                        if Path(name).suffix.lower() in ('.tex', '.sty', '.cls'))
    citations = set().union(*(cited_keys(text) for text in kept_sources))
    assembled = prefix + prune_bibliography(selected, citations) + suffix
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.proof2game-snapshot-', dir=destination.parent) as scratch:
        staged = Path(scratch) / 'snapshot'
        staged.mkdir()
        for item in active:
            path = staged / item['path']
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(item['text'], encoding='utf-8')
        for name, data in resources.items():
            path = staged / name
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.exists() and path.read_bytes() != data:
                raise Invalid(f'TeX component conflicts with a rendering input: {name}')
            path.write_bytes(data)
        (staged / 'main.tex').write_text(assembled, encoding='utf-8')
        filtered, _ = parse(staged / 'main.tex')
        if filtered['targets'] != current['targets'] or filtered['cone'] != current['cone']:
            raise Invalid('Filtered assembly changed mathematical reachability.')
        if [c['id'] for c in filtered['components']] != current['cone']:
            raise Invalid('Filtered assembly retained components outside the dependency cone.')
        if parse(source_main)[0]['snapshot_digest'] != current['snapshot_digest']:
            raise Invalid('Game script changed while the snapshot was being prepared.')
        os.rename(staged, destination)
    return destination / 'main.tex'


def filter_snapshot(source_main, output_main):
    output_main = Path(output_main)
    if output_main.name != 'main.tex':
        raise Invalid('A filtered snapshot uses main.tex as its structural authority.')
    return parse(materialize_snapshot(source_main, output_main.parent))[0]


GATES = {
    'convention': ('opening', 'expression', 'self_contained', 'mathematics', 'sources', 'reuse'),
    'statement': ('expression', 'self_contained', 'mathematics', 'sources', 'reuse'),
    'proof': ('expression', 'decomposition', 'self_contained', 'mathematics', 'sources', 'reuse'),
}


def review_payload(main, cid, gate):
    """Supply only the manuscript context needed by this independent review gate."""
    snap, full = parse(main)
    byid = {component['id']: component for component in full['components']}
    component = byid.get(cid)
    if not component or gate not in GATES[component['type']]:
        raise Invalid('Unknown review component or inapplicable gate.')

    def item(component_id):
        return {'id': component_id, 'text': uncomment(byid[component_id]['text'])}

    body = uncomment(component['text'])
    deps = component['deps']
    if gate == 'opening':
        paragraphs = nonempty_paragraphs(body)
        body = paragraphs[0] if paragraphs else ''
        labels = set(REFERENCE.findall(body))
        deps = [dep for dep in deps if any(
            component['reference_labels'].get(label) == dep for label in labels)]
    out = {
        'component': cid, 'type': component['type'], 'gate': gate,
        'snapshot_digest': snap['snapshot_digest'], 'component_digest': component['digest'],
        'source_blind': gate not in ('sources', 'reuse'), 'heading': component['heading'],
        'location': component['location'], 'adoption_prefix': component['adoption_prefix'],
        'adoption': [{'id': cid, 'location': byid[cid]['location']} for cid in component['ambient']],
        'current_text': body, 'ambient': [item(dep) for dep in component['ambient']],
        'direct_statement_interfaces': [item(dep) for dep in deps],
    }
    if component['type'] == 'proof':
        out['paired_statement'] = item(component['paired'])
    if component['type'] == 'statement':
        if gate in ('sources', 'reuse'):
            out['paired_proof_limited_application_check'] = item(component['paired'])
        if gate == 'expression':
            out['statement_navigation'] = {
                'kind': component['kind'], 'title': component['title'],
                'proof_location': byid[component['paired']]['location'],
            }
            out['adjacent_prose'] = uncomment(component['preceding_prose'])
            if component['order']:
                previous = full['components'][component['order'] - 1]
                if previous['type'] == 'proof':
                    excerpt = preceding_proof_excerpt(previous['text'])
                    if excerpt:
                        out['preceding_proof_transition_excerpt'] = excerpt
                    else:
                        out['adjacent_proof'] = (
                            'Supply a minimal transition excerpt only if necessary; omit the earlier proof as a whole.'
                        )
                else:
                    out['preceding_component'] = item(previous['id'])
    return out


def pdf_text(pdf):
    converter = shutil.which('pdftotext')
    if converter:
        result = subprocess.run([converter, str(pdf), '-'], capture_output=True, text=True, timeout=90)
        if not result.returncode and result.stdout.strip():
            return result.stdout
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise Invalid('PDF navigation checks require pdftotext or the pypdf Python package.') from exc
    with pdf.open('rb') as stream:
        return '\n'.join(page.extract_text() or '' for page in PdfReader(stream).pages)


def adoption_sentence(locations):
    if not locations:
        return ''
    parts = []
    if locations[0] == '1':
        parts.append('Section 1')
        locations = locations[1:]
    if len(locations) == 1:
        parts.append('Subsection ' + locations[0])
    elif locations:
        parts.append('Subsections ' + locations[0] + '–' + locations[-1])
    return 'We adopt the settings of ' + ' and '.join(parts) + '.'


def verify_numbering(main):
    """Compile a private copy and check actual PDF reference and navigation text."""
    main = Path(main).resolve(strict=True)
    old = main.read_text(encoding='utf-8')
    hint = re.search(r'^%\s*!\s*TeX\s+program\s*=\s*(\w+)', old, re.I | re.M)
    engines = [hint[1].lower()] if hint else ['pdflatex', 'lualatex', 'xelatex']
    if any(name not in ('pdflatex', 'lualatex', 'xelatex') for name in engines):
        raise Invalid('Unsupported TeX program for PDF navigation verification.')
    engine = next((path for candidate in engines if (path := shutil.which(candidate))), None)
    if not engine:
        raise Invalid('PDF navigation verification needs a local TeX installation.')
    unknown_references = re.compile(
        r'(?:^LaTeX Warning: (?:Reference|Citation) .+ undefined|There were undefined references)'
        r'|(?:Package [^ ]+ Warning: Undefined citation)', re.M
    )
    with tempfile.TemporaryDirectory(prefix='proof2game-numbering-') as folder:
        # The work draft may contain archived sources and gaps. Compile the
        # exact assembly a player will receive and compare its new numbering.
        compiled = materialize_snapshot(main, Path(folder) / 'build')
        _, full = parse(compiled)
        build = compiled.parent
        environment = dict(os.environ, openin_any='p', openout_any='p')
        for _ in range(3):
            try:
                run = subprocess.run([engine, '-no-shell-escape', '-interaction=nonstopmode',
                                      '-halt-on-error', compiled.name], cwd=build,
                                     capture_output=True, text=True, timeout=90, env=environment)
            except subprocess.TimeoutExpired as exc:
                raise Invalid('Game script compilation timed out.') from exc
            if run.returncode:
                errors = [line for line in run.stdout.splitlines() if line.startswith('!')]
                raise Invalid('Game script did not compile: ' + '\n'.join(errors[-4:]))
        if unknown_references.search(run.stdout):
            raise Invalid('The compiled PDF has an unresolved reference or citation.')
        aux = compiled.with_suffix('.aux').read_text(encoding='utf-8')
        numbers = {}
        for match in re.finditer(r'\\newlabel\{([^{}]+)\}\{(?=\{)', aux):
            number, _ = group(aux, match.end())
            if match[1] in numbers:
                raise Invalid('PDF compilation produced an ambiguous label: ' + match[1])
            numbers[match[1]] = number
        rendered = re.sub(r'\s+', ' ', pdf_text(compiled.with_suffix('.pdf')))
        nodes = {node['target']: node for node in full['nodes']}
        byid = {component['id']: component for component in full['components']}
        for component in full['components']:
            if component['type'] != 'statement':
                continue
            cid, paired, kind = component['id'], component['paired'], component['kind']
            target_number = numbers.get('ms:' + cid)
            location = numbers.get('proof:' + paired)
            if not target_number or location != nodes[cid]['location']:
                raise Invalid(f'Wrong or missing proof navigation numbers for {cid}.')
            level = 'Sub' + 'sub' * (location.count('.') - 1) + 'section'
            text = f'The proof of {kind} {target_number} is given in {level} {location}.'
            if text not in rendered:
                raise Invalid(f'Missing or malformed compiled navigation: {text}')
            if component['section'] == 1:
                adoption = adoption_sentence([byid[dep]['location'] for dep in component['ambient']])
                if adoption and adoption not in rendered:
                    raise Invalid(f'Missing or malformed compiled adoption for {cid}: {adoption}')
        return numbers


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('inspect', 'payload', 'snapshot', 'verify-pdf'))
    parser.add_argument('main', type=Path)
    parser.add_argument('--component')
    parser.add_argument('--gate')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    try:
        if args.command == 'snapshot':
            if args.output is None:
                parser.error('snapshot requires --output DIRECTORY')
            result = {'main': str(materialize_snapshot(args.main, args.output))}
        elif args.command == 'payload':
            result = review_payload(args.main, args.component, args.gate)
        elif args.command == 'verify-pdf':
            result = {'numbers': verify_numbering(args.main)}
        else:
            result, _ = parse(args.main)
    except (OSError, ValueError) as exc:
        parser.exit(2, f'{exc}\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
