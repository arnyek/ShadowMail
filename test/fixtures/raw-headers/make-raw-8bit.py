#!/usr/bin/env python3
# Generates the raw 8-bit header fixtures byte-exact (CRLF, no RFC 2047 in the raw fields). Synthetic: the names,
# addresses and texts are made up; the shape is that of a web form mailer (old PHP) that writes the subject and the
# sender's name in the body's charset straight into the header. Run from this folder: python3 make-raw-8bit.py
# (not under fixtures/mail: the reader, layout and splitter e2e load that whole folder)
import pathlib

HERE = pathlib.Path(__file__).resolve().parent


def write(name, parts):
    data = b''.join(p if isinstance(p, bytes) else p.encode('ascii') for p in parts)
    (HERE / name).write_bytes(data)


L2 = lambda s: s.encode('iso-8859-2')
U8 = lambda s: s.encode('utf-8')

# 1. raw ISO-8859-2 subject and names, the top-level Content-Type says iso-8859-2; Cc mixes an RFC 2047 word
write('raw-8bit-iso-8859-2.eml', [
    'Return-Path: <urlap@example.invalid>\r\n',
    'From: ', L2('Kertész Előd Ödön'), '<kerteszelod@example.invalid>\r\n',
    'To: ', L2('Árvíztűrő Ügyfélszolgálat'), ' <ugyfel@example.invalid>\r\n',
    'Cc: =?UTF-8?Q?Sz=C5=91l=C5=91si_Bea?= <bea@example.invalid>, ', L2('Fűzfa Győző'), ' <gyozo@example.invalid>\r\n',
    'Subject: ', L2('Tükörfúrógép árajánlatkérés: őszi kőművesmunka'), '\r\n',
    'Date: Mon, 16 Nov 2026 10:00:00 +0100\r\n',
    'Message-ID: <raw8bit-1@example.invalid>\r\n',
    'MIME-Version: 1.0\r\n',
    'Content-Type: text/html; charset=iso-8859-2\r\n',
    'Content-Transfer-Encoding: 8bit\r\n',
    '\r\n',
    '<p>', L2('Név: Kertész Előd Ödön. Üzenet: kérek árajánlatot, köszönöm.'), '</p>\r\n',
])

# 2. raw UTF-8 headers (valid UTF-8) although the body is iso-8859-2: the headers stay UTF-8
write('raw-8bit-utf8.eml', [
    'From: ', U8('Bárány Őrs'), ' <baranyors@example.invalid>\r\n',
    'To: ugyfel@example.invalid\r\n',
    'Subject: ', U8('Űrlap: szőlőprés bérlés'), '\r\n',
    'Date: Mon, 16 Nov 2026 11:00:00 +0100\r\n',
    'Message-ID: <raw8bit-2@example.invalid>\r\n',
    'MIME-Version: 1.0\r\n',
    'Content-Type: text/plain; charset=iso-8859-2\r\n',
    'Content-Transfer-Encoding: 8bit\r\n',
    '\r\n',
    L2('Szöveg: köszönöm.'), '\r\n',
])

# 3. raw 8-bit headers, the top level has no charset (multipart): windows-1250 (0x8a = Š there, a control in latin1)
write('raw-8bit-no-charset.eml', [
    'From: ', L2('Kőműves Ödön'), ' <komuves@example.invalid>\r\n',
    'To: ugyfel@example.invalid\r\n',
    'Subject: ', 'Ajánlat: Škoda szőnyeg'.encode('cp1250'), '\r\n',
    'Date: Mon, 16 Nov 2026 12:00:00 +0100\r\n',
    'Message-ID: <raw8bit-3@example.invalid>\r\n',
    'MIME-Version: 1.0\r\n',
    'Content-Type: multipart/alternative;\r\n boundary="b1"\r\n',
    '\r\n',
    '--b1\r\n',
    'Content-Type: text/plain; charset=windows-1250\r\n',
    'Content-Transfer-Encoding: 8bit\r\n',
    '\r\n',
    'Szia!'.encode('cp1250'), '\r\n',
    '--b1--\r\n',
])
