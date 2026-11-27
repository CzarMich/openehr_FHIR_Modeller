#!/usr/bin/env python3
"""Dependency-free requirement/path drift gate; JSON-compatible YAML is the source index."""
import argparse,glob,json,re,sys
from pathlib import Path

ID=re.compile(r'REQ-([FN])([1-9][0-9]*)\b')

def matrix(records):
    lines=['| Requirement | Scope | Implementation | Source | Verification |','|---|---|---|---|---|']
    for row in records:
        paths=', '.join('`'+path+'`' for path in row.get('packages',[]))
        tests=', '.join('`'+path+'`' for path in row.get('tests',[]))
        lines.append(f"| {row['id']} | {row['title']} | {row.get('implementation','planned')} | {paths} | {tests} |")
    return '\n'.join(lines)+'\n'

def check(root, render=False):
    errors=[]
    try:
        records=json.loads((root/'docs/traceability.yaml').read_text())['requirements']
        requirements=(root/'docs/requirements.md').read_text()
        rendered=(root/'docs/traceability.md').read_text()
    except (OSError,ValueError,KeyError) as error:return ['Cannot read the requirement index: '+str(error)]
    known=set()
    for row in records:
        identity=row.get('id','')
        if not ID.fullmatch(identity) or identity in known:errors.append('Invalid or duplicate requirement: '+identity)
        known.add(identity)
        if not isinstance(row.get('title'),str) or not row['title'].strip():errors.append(identity+': title required')
        if row.get('status') not in ['draft','stable','deprecated']:errors.append(identity+': invalid status')
        if row.get('implementation') not in ['planned','partial','landed','deferred']:errors.append(identity+': invalid implementation state')
        paths=[row.get('canonical','')]+row.get('packages',[])+row.get('tests',[])+row.get('plans',[])
        if not row.get('packages'):errors.append(identity+': implementation paths required')
        if row.get('implementation')=='landed' and not row.get('tests'):errors.append(identity+': landed work needs verification paths')
        for path in paths:
            if not isinstance(path,str) or not path or Path(path).is_absolute() or '..' in Path(path).parts or not glob.glob(str(root/path)):
                errors.append(identity+': missing/invalid path '+str(path))
        for adr in row.get('adr',[]):
            if not re.fullmatch(r'[0-9]{4}',str(adr)) or len(list((root/'docs/decisions').glob(str(adr)+'-*.md')))!=1:errors.append(identity+': ADR not uniquely resolved: '+str(adr))
    stated={match.group() for match in ID.finditer(requirements)}
    if known!=stated:errors.append('Requirement/index identifier drift: '+', '.join(sorted(known.symmetric_difference(stated))))
    for area in ['F','N']:
        values=sorted(int(ID.fullmatch(value).group(2)) for value in known if ID.fullmatch(value) and ID.fullmatch(value).group(1)==area)
        if values and values!=list(range(1,values[-1]+1)):errors.append('Requirement numbering gap in '+area)
    marker='<!-- generated-requirements -->'
    if marker not in rendered:errors.append('Generated matrix marker missing')
    else:
        expected=rendered.split(marker,1)[0]+marker+'\n\n'+matrix(records)
        if render and not errors:(root/'docs/traceability.md').write_text(expected)
        elif rendered!=expected:errors.append('Human matrix drift; run python3 scripts/spec-check.py --render')
    return errors

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1]);parser.add_argument('--render',action='store_true');args=parser.parse_args()
    errors=check(args.root.resolve(),args.render)
    if errors:
        for error in errors:print(error,file=sys.stderr)
        return 1
    print('Requirement identifiers, implementation/test paths, ADRs and matrix are consistent.');return 0
if __name__=='__main__':raise SystemExit(main())
