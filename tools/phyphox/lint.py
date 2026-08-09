#!/usr/bin/env python3
"""Static checks for .phyphox experiment files.

Catches the failure modes that only show up as a silent load error on the phone:
misspelled buffer names, formula placeholders that point past the input list,
analysis modules that do not exist, and views bound to nothing.
"""
import re
import sys
import xml.etree.ElementTree as ET

# modules seen in the official phyphox experiments and the wiki reference
MODULES = {
    "add", "subtract", "multiply", "divide", "power", "log", "gausssmooth", "abs",
    "sin", "cos", "tan", "sinh", "cosh", "tanh", "asin", "acos", "atan", "atan2",
    "first", "max", "min", "threshold", "append", "fft", "autocorrelation",
    "differentiate", "integrate", "crosscorrelation", "rangefilter", "subrange",
    "ramp", "const", "count", "average", "median", "binning", "if", "timer",
    "timer2", "formula", "round", "map", "reduce", "sort", "loess", "match",
    "interpolate", "split",
}
VIEW_ELEMENTS = {
    "value", "graph", "info", "edit", "button", "separator", "toggle", "slider",
    "dropdown", "image", "camera-gui", "depth-gui",
}


def literal(el):
    """True if this input carries an inline value rather than a buffer name."""
    return el.get("type") in ("value", "empty")


def check(path):
    problems, warnings = [], []
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as e:
        return [f"XML is not well formed: {e}"], []

    if root.tag != "phyphox":
        problems.append(f"root element is <{root.tag}>, expected <phyphox>")
    if not root.get("version"):
        problems.append("root element has no version attribute")

    declared, sizes = set(), {}
    for c in root.findall("./data-containers/container"):
        name = (c.text or "").strip()
        if not name:
            problems.append("a <container> has no name")
            continue
        if name in declared:
            problems.append(f"container '{name}' declared twice")
        declared.add(name)
        sizes[name] = c.get("size", "1")

    used = set()

    def buffer_ref(el, where):
        name = (el.text or "").strip()
        if literal(el):
            return
        if not name:
            problems.append(f"{where}: <{el.tag}> has neither a buffer name nor type=value/empty")
            return
        used.add(name)
        if name not in declared:
            problems.append(f"{where}: '{name}' is not declared in <data-containers>")

    # ---- input / output hardware blocks
    for section in ("input", "output"):
        for dev in root.findall(f"./{section}/*"):
            for el in dev.findall(".//output") + dev.findall(".//input"):
                buffer_ref(el, f"<{section}><{dev.tag}>")

    # ---- analysis
    analysis = root.find("./analysis")
    if analysis is None:
        warnings.append("no <analysis> block")
    else:
        for i, mod in enumerate(analysis):
            if mod.tag is ET.Comment:
                continue
            where = f"analysis module #{i+1} <{mod.tag}>"
            if mod.tag not in MODULES:
                problems.append(f"{where}: unknown analysis module")
            ins = mod.findall("./input")
            for el in ins + mod.findall("./output"):
                buffer_ref(el, where)
            if mod.tag == "formula":
                f = mod.get("formula")
                if not f:
                    problems.append(f"{where}: no formula attribute")
                    continue
                refs = [int(m) for m in re.findall(r"\[(\d+)_?\]", f)]
                if not refs:
                    warnings.append(f"{where}: formula references no inputs")
                for r in refs:
                    if r < 1 or r > len(ins):
                        problems.append(
                            f"{where}: formula uses [{r}] but only {len(ins)} inputs are given")
                for j in range(1, len(ins) + 1):
                    if j not in refs:
                        warnings.append(f"{where}: input #{j} is never used by the formula")
                # scientific notation is not part of the documented grammar
                if re.search(r"\d[eE][-+]?\d", f):
                    problems.append(f"{where}: formula uses scientific notation, which is not documented as supported")
                if f.count("(") != f.count(")"):
                    problems.append(f"{where}: unbalanced parentheses in formula")

    # ---- views
    views = root.findall("./views/view")
    if not views:
        warnings.append("no <view> defined")
    for v in views:
        label = v.get("label", "?")
        for el in v:
            if el.tag is ET.Comment:
                continue
            if el.tag not in VIEW_ELEMENTS:
                problems.append(f"view '{label}': unknown element <{el.tag}>")
            for io in el.findall("./input") + el.findall("./output"):
                buffer_ref(io, f"view '{label}' <{el.tag}>")
            if el.tag == "graph":
                axes = {i.get("axis") for i in el.findall("./input")}
                if not {"x", "y"} <= axes:
                    problems.append(f"view '{label}': graph is missing an x or y input")
            if el.tag == "value" and not el.findall("./input"):
                problems.append(f"view '{label}': <value label='{el.get('label')}'> has no input")

    # ---- export
    for s in root.findall("./export/set"):
        for d in s.findall("./data"):
            name = (d.text or "").strip()
            used.add(name)
            if name not in declared:
                problems.append(f"export set '{s.get('name')}': '{name}' is not declared")

    for name in sorted(declared - used):
        warnings.append(f"container '{name}' (size {sizes[name]}) is declared but never used")

    return problems, warnings


if __name__ == "__main__":
    failed = False
    for path in sys.argv[1:]:
        problems, warnings = check(path)
        print(f"\n=== {path.split('/')[-1]} ===")
        for w in warnings:
            print(f"  warn  {w}")
        for p in problems:
            print(f"  FAIL  {p}")
        if not problems:
            print(f"  ok    no errors ({len(warnings)} warnings)")
        failed |= bool(problems)
    sys.exit(1 if failed else 0)
