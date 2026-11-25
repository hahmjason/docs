"""금오정밀 기준정보 조회 앱 데이터 반영.
사용: python build.py <02_기준정보.xlsx> <01_수주납품대장.xlsx> <03_창고재고.xlsx> [index.html]
엑셀은 모두 읽기 전용으로 연다(원본 수정 없음). 필요: pip install openpyxl
"""
import json, re, sys
from collections import Counter, defaultdict
import openpyxl

def sheet(path, name):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    rows = list(wb[name].iter_rows(values_only=True))
    return rows[0], [r for r in rows[1:] if any(v is not None for v in r)]

master, ledger, stock = sys.argv[1:4]
page = sys.argv[4] if len(sys.argv) > 4 else 'index.html'

h, rs = sheet(master, '품목마스터')
items = [dict(zip(h, r)) for r in rs]
items = [{'code': d['품번(Key)'], 'name': d['품명'], 'l1': d['대분류'], 'l2': d['중분류'], 'l3': d['소분류'],
          'unit': d['기준단위'], 'price': d['표준단가(원)'], 'lot': d['로트관리'], 'insp': d['출하검사']} for d in items]
keys = {i['code'] for i in items}
_, rs = sheet(master, '품번별칭')
aliases = [{'alias': r[0], 'key': r[1], 'reason': r[2]} for r in rs]
assert all(a['key'] in keys for a in aliases)
_, rs = sheet(master, '발주처마스터')
customers = [{'code': r[0], 'name': r[1], 'type': r[2]} for r in rs]
_, rs = sheet(master, '창고마스터')
wh = {r[0]: {'name': r[3], 'ship': r[4], 'rule': r[5]} for r in rs if r[1] == '가상창고'}

# 재고 (기준일 포함)
_, rs = sheet(stock, '재고현황')
asof = rs[0][0]
inv = defaultdict(list)
for d, code, _, pw, vw, lot, q in rs:
    assert code in keys and vw in wh
    inv[code].append({'wh': vw, 'lot': lot, 'qty': q})
_, rs = sheet(stock, '입고예정')
incoming = defaultdict(list)
for code, date, q, note in rs:
    incoming[code].append({'date': date, 'qty': q, 'note': note})
_, rs = sheet(stock, '미출고수주')
open_so = defaultdict(list)
for so, cust, code, q, due in rs:
    open_so[code].append({'so': so, 'cust': cust, 'qty': q, 'due': due})

# 수주납품대장 발주처 검증 (마스터 기준)
h, rs = sheet(ledger, '수주납품')
names = {c['name'] for c in customers}
cnt = Counter(); blank = []; unknown = Counter()
for i, r in enumerate(rs, start=2):  # 엑셀 행번호
    v = r[1]
    if v is None or str(v).strip() == '':
        blank.append(i)
    elif v in names:
        cnt[v] += 1
    else:
        unknown[v] += 1
def iso(v):  # 2026/3/5 같은 혼용 표기를 비교용으로만 정규화(원본은 그대로)
    if hasattr(v, 'strftime'): return v.strftime('%Y-%m-%d')
    y, m, d = re.split(r'[-/.]', str(v).strip())
    return f'{int(y):04d}-{int(m):02d}-{int(d):02d}'
dates = [iso(r[0]) for r in rs]
ledger_check = {'rows': len(rs), 'matched': sum(cnt.values()), 'per': dict(cnt),
                'blank': blank, 'unknown': dict(unknown),
                'period': [min(dates), max(dates)]}

# 대시보드용 수주 검증 집계 (화면 '수주 검증'과 같은 규칙: ① 발주처·로트 빈 값 ② 수량 0 이하 ③ 9개 항목 완전 중복, 뒤 행만)
def is_blank(v): return v is None or str(v).strip() == ''
seen = set(); by = Counter(); months = defaultdict(lambda: [0, 0]); cust = defaultdict(lambda: [0, 0]); bad_rows = 0; viol = 0
for r in rs:
    hits = []
    if is_blank(r[1]): hits.append('cust')
    if is_blank(r[4]): hits.append('lot')
    try: q = float(str(r[5]).replace(',', '')) if not isinstance(r[5], (int, float)) else r[5]
    except ValueError: q = None
    if q is None or q <= 0: hits.append('qty')
    key = tuple(r[:9])
    if key in seen: hits.append('dup')
    seen.add(key)
    for h_ in hits: by[h_] += 1
    viol += len(hits); bad = 1 if hits else 0; bad_rows += bad
    m = iso(r[0])[:7]; months[m][0] += 1; months[m][1] += bad
    c = '(빈 칸)' if is_blank(r[1]) else str(r[1]); cust[c][0] += 1; cust[c][1] += bad
dash = {'name': '01_금오정밀_수주납품대장.xlsx', 'total': len(rs), 'ok': len(rs) - bad_rows, 'bad': bad_rows, 'violations': viol,
        'byRule': {k: by[k] for k in ['cust', 'lot', 'qty', 'dup']},
        'months': [{'m': m, 'total': v[0], 'bad': v[1]} for m, v in sorted(months.items())],
        'cust': [{'name': k, 'total': v[0], 'bad': v[1]} for k, v in cust.items()]}

data = {'items': items, 'dash': dash, 'aliases': aliases, 'customers': customers, 'wh': wh, 'asof': asof,
        'inv': inv, 'incoming': incoming, 'open': open_so, 'ledger': ledger_check}
js = json.dumps(data, ensure_ascii=False)
html = open(page, encoding='utf-8').read()
html, n = re.subn(r'const DATA = .*?;\n', lambda m: f'const DATA = {js};\n', html, count=1)
assert n == 1, 'DATA 줄 없음'
open(page, 'w', encoding='utf-8').write(html)
print(f'반영: 품목 {len(items)} · 별칭 {len(aliases)} · 발주처 {len(customers)} · 재고기준일 {asof} · 대장 {len(rs)}행(발주처 공란 {len(blank)}, 미등록 {sum(unknown.values())})')
