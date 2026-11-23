"""Independently check actual fixture downloads and the 0.5.4 release ZIP."""
from pathlib import Path
import hashlib
import json
import struct
import zipfile
import zlib

root = Path(__file__).resolve().parents[1]
artifacts, dist = root / 'artifacts', root / 'dist'
report = {'version': '0.5.4', 'passed': True, 'realQuestion93IndependentlyVerified': False}
results = []
for name in ['timeout-report.json', 'truncation-report.json', 'review-progress-report-0.5.4.json', 'chat-task-report.json']:
    data = json.loads((artifacts / name).read_text(encoding='utf-8'))
    assert data['passed'] and data['version'] == '0.5.4', name
    results.append({'report': name, 'checks': len(data['checks'])})
report['browserChecks'] = results
previous = json.loads((artifacts / 'package-report-v5.3.json').read_text(encoding='utf-8'))
assert previous['passed'] and previous['version'] == '0.5.3'
report['previousFullSuite'] = {'version': '0.5.3', 'browserChecks': sum(item['checks'] for item in previous['browserChecks'])}

expected = {
    89: [('1','1'),('1','3'),('2','4'),('3','2'),('4','5'),('4','6')],
    93: [('1','1'),('2','2'),('3','3')],  # Structural fixture, not unseen user content.
    96: [('1','2'),('2','3'),('2','4'),('4','1')],
    99: [('1','4'),('1','5'),('2','1'),('2','2'),('2','3')],
    100: [('2','1'),('3','2'),('4','3')],
    101: [('1','2'),('1','4'),('2','1'),('2','3')],
}
with zipfile.ZipFile(artifacts / 'complete-101-matching-matching-review.zip') as archive:
    assert archive.testzip() is None
    bank = json.loads(archive.read('question-bank.json'))
    questions = bank['questions']
    assert bank['formatVersion'] == 2 and len(questions) == 101
    assert len({q['id'] for q in questions}) == 101
    assert [q['index'] for q in questions] == list(range(1, 102))
    assert [q['numberInPaper'] for q in questions] == list(range(1, 102))
    assert questions[0]['stem'].startswith('\u4eba\u5de5')
    assert all(not any(key.startswith('_') for key in q) for q in questions)
    assert sum(q['type'] == 'matching' for q in questions) == 6
    for number, pairs in expected.items():
        q = questions[number - 1]
        matching = q['matching']
        assert q['type'] == 'matching' and q['answers'] == [] and q['options'] == []
        assert [(p['leftId'], p['rightId']) for p in matching['correctPairs']] == pairs
        assert {p['rightId'] for p in matching['correctPairs']} == {i['id'] for i in matching['rightItems']}
        assert all(p['leftId'] in {i['id'] for i in matching['leftItems']} for p in matching['correctPairs'])
        if number in [89, 96, 99, 101]:
            assert matching['mode'] == 'left_reusable'
    assert 'OPSF' in questions[92]['stem'] and questions[92]['matching']['leftItems'][2]['text'] == 'DD Sea'
    assert '\ngreater-equal 24 less-equal 27' in questions[98]['matching']['leftItems'][0]['text']
    image = questions[99]['image']
    image_bytes = archive.read(image)
    image_hash = hashlib.sha256(image_bytes).hexdigest()
    assert image_hash == Path(image).stem and image_bytes.startswith(b'\x89PNG\r\n\x1a\n')
    position, compressed = 8, b''
    while position < len(image_bytes):
        size = struct.unpack('>I', image_bytes[position:position+4])[0]
        kind, payload = image_bytes[position+4:position+8], image_bytes[position+8:position+8+size]
        crc = struct.unpack('>I', image_bytes[position+8+size:position+12+size])[0]
        assert zlib.crc32(kind + payload) & 0xffffffff == crc
        if kind == b'IHDR':
            assert struct.unpack('>II', payload[:8]) == (180, 90)
        if kind == b'IDAT':
            compressed += payload
        position += size + 12
    assert zlib.decompress(compressed)
    report['matchingPackage'] = {'questions': 101, 'matchingQuestions': 6, 'pairs': 'verified', 'manualEdit': 'preserved', 'sourceTyposAndCommandNewlines': 'preserved', 'extraModelRequests': 0, 'imageSha256': image_hash, 'zipAndPngCRC': 'passed'}

with zipfile.ZipFile(artifacts / 'complete-100-v3.zip') as archive:
    assert archive.testzip() is None
    bank = json.loads(archive.read('question-bank.json'))
    assert bank['formatVersion'] == 2 and len(bank['questions']) == 100
    for q in bank['questions']:
        for image in [q.get('image'), *q.get('explanationImages', [])]:
            if image:
                assert hashlib.sha256(archive.read(image)).hexdigest() == Path(image).stem
    report['previousImagePackage'] = {'questions': 100, 'crcAndImageHashes': 'passed'}


# Check real native files after the workspace and image-cache cleanup.
result = json.loads((artifacts / 'settings-download-result.json').read_text(encoding='utf-8'))
assert result['version'] == '0.5.3'  # Unchanged download fixture from the last full run.
native_root = max((p for p in artifacts.glob('native-downloads-*') if p.is_dir()), key=lambda p: p.name)
native_names = []
for record in result['files']:
    relative = record['relative'].replace(chr(92), '/')
    native = (native_root / relative).resolve()
    assert native.is_relative_to(native_root.resolve())
    assert native.parent.relative_to(native_root).as_posix() == '题库/网络工程'
    assert native.is_file()
    native_names.append(native.name)
    if native.suffix == '.json':
        bank = json.loads(native.read_text(encoding='utf-8'))
        assert len(bank['questions']) == 1 and bank['questions'][0]['answers'] == ['B']
    else:
        with zipfile.ZipFile(native) as archive:
            assert archive.testzip() is None
            bank = json.loads(archive.read('question-bank.json'))
            assert bank['formatVersion'] == 2 and len(bank['questions']) == 1
            image = bank['questions'][0]['image']
            assert hashlib.sha256(archive.read(image)).hexdigest() == Path(image).stem
assert len(native_names) == 3 and len(set(native_names)) == 3
report['settingsNativeDownloads'] = {'fixtureVersion': '0.5.3', 'files': native_names, 'folder': '题库/网络工程', 'afterWorkspaceClear': 'files still present', 'sameNameConflict': 'separate files', 'zipCRCAndImageHash': 'passed'}

files = sorted(p for p in dist.rglob('*') if p.is_file())
assert len(files) == 25
assert json.loads((dist / 'manifest.json').read_text(encoding='utf-8'))['version'] == '0.5.4'
release = artifacts / 'AIQuizLite-browser-extension-v0.5.4.zip'
with zipfile.ZipFile(release, 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in files:
        archive.write(path, path.relative_to(dist).as_posix())
with zipfile.ZipFile(release) as archive:
    assert archive.testzip() is None and len(archive.namelist()) == 25
    assert 'lib/matching-parser.js' in archive.namelist()
    for path in files:
        assert archive.read(path.relative_to(dist).as_posix()) == path.read_bytes()
    assert all(b'fixture-only-key' not in archive.read(name) for name in archive.namelist())
report['extensionArchive'] = {'files': 25, 'distHashes': 'all matched', 'sha256': hashlib.sha256(release.read_bytes()).hexdigest()}
(artifacts / 'package-report-v5.4.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=True))
