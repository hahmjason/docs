"""기준정보 엑셀이 바뀌면 index.html 의 데이터를 다시 반영한다.
사용: python build.py <02_금오정밀_기준정보.xlsx> [index.html]
원본 엑셀은 읽기 전용으로만 연다(수정하지 않음). 필요: pip install openpyxl
"""
import json, re, sys
import openpyxl

src = sys.argv[1]
page = sys.argv[2] if len(sys.argv) > 2 else 'index.html'
wb = openpyxl.load_workbook(src, read_only=True, data_only=True)

rows = list(wb['품목마스터'].iter_rows(values_only=True))
h = rows[0]
items = []
for r in rows[1:]:
    if not r[0]:
        continue
    d = dict(zip(h, r))
    items.append({'code': d['품번(Key)'], 'name': d['품명'], 'l1': d['대분류'], 'l2': d['중분류'],
                  'l3': d['소분류'], 'unit': d['기준단위'], 'price': d['표준단가(원)'], 'insp': d['출하검사']})
keys = {i['code'] for i in items}
aliases = []
for r in list(wb['품번별칭'].iter_rows(values_only=True))[1:]:
    if r[0]:
        assert r[1] in keys, f'별칭 {r[0]} 의 표준 품번 {r[1]} 이 품목마스터에 없음'
        aliases.append({'alias': r[0], 'key': r[1], 'reason': r[2]})

html = open(page, encoding='utf-8').read()
data = json.dumps({'items': items, 'aliases': aliases}, ensure_ascii=False)
html, n = re.subn(r'const DATA = .*?;\n', lambda m: f'const DATA = {data};\n', html, count=1)
assert n == 1, 'index.html 에서 DATA 줄을 찾지 못함'
open(page, 'w', encoding='utf-8').write(html)
print(f'반영 완료: 품목 {len(items)}건, 별칭 {len(aliases)}건 → {page}')
