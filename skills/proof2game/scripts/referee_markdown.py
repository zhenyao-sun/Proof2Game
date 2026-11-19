"""Read the rendered structure of a mathematical referee report using Pandoc."""

import json
import re
import subprocess


SECTIONS = ("Summary", "Assessment", "Major Issues", "Minor Issues")
SMALL_NUMBERS = ("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen "
                 "fifteen sixteen seventeen eighteen nineteen").split()
TENS = "twenty thirty forty fifty sixty seventy eighty ninety".split()


def is_opening(paragraph, sentence):
    """Match the reported first sentence, including common mathematical abbreviations."""
    sentence = " ".join(sentence.split())
    if not paragraph.startswith(sentence) or not re.search(r"[.!?][”’'\"$)]*$", sentence):
        return False
    prose = re.sub(r"\$[^$]*\$", "math", sentence)
    abbreviations = {"e.g", "i.e", "et al", "cf", "resp", "eq", "eqs", "fig", "figs",
                     "prop", "thm", "sec", "no", "dr", "prof", "vs", "st"}
    for stop in re.finditer(r"[.!?][”’'\")]*\s+(?=[A-Z0-9“‘])", prose):
        before = prose[:stop.start()]
        term = re.search(r"[\w.]+$", before)
        if stop[0].startswith(".") and term and (
                term[0].lower() in abbreviations or before.lower().endswith("et al")
                or re.fullmatch(r"[A-Z]", term[0])):
            continue
        return False
    return True


def count_matches(sentence, count):
    """Check an explicit count in ordinary English and leave impact and meaning to Writer."""
    words = SMALL_NUMBERS.copy()
    for tens in TENS:
        words.extend([tens] + [f"{tens}-{unit}" for unit in SMALL_NUMBERS[1:10]])
    forms = {word: n for n, word in enumerate(words)}
    forms.update({"no": 0, "a single": 1, "one single": 1, "a": 1, "both": 2})
    if count >= len(words):
        return True  # The Writer reviews uncommon number phrases against the list.
    count_token = "|".join(re.escape(word).replace(r"\-", "[- ]") for word in forms)
    explicit = re.findall(rf"\b({count_token}|\d+) major (?:issue|problem|concern|gap)s?\b", sentence.lower())
    if explicit:
        values = [int(word) if word.isdigit() else forms.get(word, forms.get(word.replace(" ", "-")))
                  for word in explicit]
        return count in values
    if count == 0:
        return True
    options = [str(count), re.escape(words[count]).replace(r"\-", "[- ]")]
    if count == 1:
        options.extend(("a single", r"(?:a|an) (?:major|serious|substantial|decisive|unsupported|incorrect)"))
    elif count == 2:
        options.append("both")
    return re.search(r"\b(?:" + "|".join(options) + r")\b", sentence, re.IGNORECASE) is not None


def text_runs(node, *, italic=False, quoted=False):
    """Yield visible text with its emphasis and quotation context, including math."""
    if isinstance(node, list):
        for child in node:
            yield from text_runs(child, italic=italic, quoted=quoted)
    elif isinstance(node, dict) and "t" in node:
        kind, content = node["t"], node.get("c", [])
        if kind == "Str":
            yield content, italic, quoted
        elif kind in ("Space", "SoftBreak", "LineBreak"):
            yield " ", italic, quoted
        elif kind == "Math":
            yield "$" + content[1] + "$", italic, quoted
        elif kind == "Code":
            yield content[1], italic, quoted
        else:
            yield from text_runs(content, italic=italic or kind == "Emph",
                                 quoted=quoted or kind in ("BlockQuote", "Quoted"))


def visible_text(node):
    return " ".join("".join(text for text, _, _ in text_runs(node)).split())


def check_quotes(block):
    runs = list(text_runs(block))
    if any(quoted and not italic and text.strip() for text, italic, quoted in runs):
        raise ValueError("Italicize the complete original quotation, including quoted math.")
    # Pandoc represents straight quotation marks as Quoted nodes and preserves
    # literal typographic quotation marks in Str nodes.
    text = "".join(value for value, _, _ in runs)
    upright = "".join(" " * len(value) if italic else value for value, italic, _ in runs)
    for quote in re.finditer(r'“[^”]*”|‘[^’]*’', text):
        if upright[quote.start() + 1:quote.end() - 1].strip():
            raise ValueError("Italicize the full inline quotation from the original.")


def inspect(data):
    data.decode("utf-8")
    parsed = subprocess.run(
        ["pandoc", "--from=markdown+smart+tex_math_dollars", "--to=json"],
        input=data, capture_output=True, timeout=60, check=True,
    )
    sections = {}
    current = None
    for block in json.loads(parsed.stdout)["blocks"]:
        check_quotes(block)
        if block["t"] == "Header" and block["c"][0] == 2:
            title = visible_text(block)
            if title in sections:
                raise ValueError(f"Repeated referee section: {title}.")
            current = sections[title] = []
        elif current is not None:
            current.append(block)
    if tuple(sections) != SECTIONS:
        raise ValueError("Use the four level-two headings Summary, Assessment, Major Issues and Minor Issues in order.")
    for title, blocks in sections.items():
        if not visible_text(blocks):
            raise ValueError(f"Empty referee section: {title}.")

    leads = {}
    for title in SECTIONS[:2]:
        first = sections[title][0]
        if first["t"] != "Para":
            raise ValueError(f"Open {title} with its overall judgment in a sentence.")
        leads[title.lower()] = visible_text(first)

    counts = {}
    for severity, title in (("major", "Major Issues"), ("minor", "Minor Issues")):
        items = [item for block in sections[title] if block["t"] == "OrderedList" for item in block["c"][1]]
        for index, item in enumerate(items, 1):
            if not any(italic and text.strip() for text, italic, _ in text_runs(item)):
                raise ValueError(f"Missing italicized original excerpt in {severity} issue {index}.")
        counts[severity] = len(items)
    return {"opening_paragraphs": leads, "issue_counts": counts}
