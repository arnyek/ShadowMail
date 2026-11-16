# Writes the contact fixtures (test/fixtures/contacts/) byte-exact: CRLF where the exporter writes CRLF,
# Windows-1250 where the exporter writes it. Made from the standards (RFC 2425/2426, vCard 2.1, RFC 6350, RFC 4180)
# and the public export layouts; no real export of a person.
import base64, os, sys, quopri

out = sys.argv[1]
os.makedirs(out, exist_ok=True)

def w(name, data):
    with open(os.path.join(out, name), 'wb') as f:
        f.write(data)

def crlf(s):
    return s.replace('\n', '\r\n')

def qp(s, charset='utf-8'):
    # every non-ASCII byte and '=' as =XX, like Android / Outlook
    b = s.encode(charset)
    return ''.join(chr(c) if 32 <= c < 127 and c != 0x3d else '=%02X' % c for c in b)

photo = base64.b64encode(bytes(range(256)) * 2).decode()
photo_lines = '\n'.join(' ' + photo[i:i + 74] for i in range(0, len(photo), 74))

# Gmail vCard 3.0 (contacts.google.com export): CRLF, folded at 75, item groups, CATEGORIES
w('gmail-3.0.vcf', crlf(f"""BEGIN:VCARD
VERSION:3.0
FN:Árvíztűrő Tükörfúrógép
N:Árvíztűrő;Tükörfúrógép;;;
EMAIL;TYPE=INTERNET;TYPE=HOME:arviz@example.hu
EMAIL;TYPE=INTERNET;TYPE=WORK:tukor@ceg.example.hu
TEL;TYPE=CELL:+36 30 123 4567
ADR;TYPE=HOME:;;Fő utca 1.;Budapest;;1011;Magyarország
ORG:Példa Kft.
TITLE:Ügyvezető
BDAY:1980-05-17
item1.URL:https\\://www.example.hu
item1.X-ABLabel:
NOTE:Első sor\\nMásodik sor\\, vesszővel
CATEGORIES:myContacts
END:VCARD
BEGIN:VCARD
VERSION:3.0
FN:Kiss Éva
N:Kiss;Éva;;;
EMAIL;TYPE=INTERNET:kiss.eva@example.com
NOTE:Nagyon hosszú megjegyzés, amely biztosan átlépi a hetvenöt bájtos sorhat
 árt, ezért a Gmail tördelve írja ki, és az olvasónak össze kell raknia.
CATEGORIES:myContacts
END:VCARD
""").encode('utf-8'))

# iPhone (iOS) vCard 3.0: PRODID, type=pref, item groups with X-ABLabel, PHOTO ENCODING=b folded, X-ABADR
w('iphone-3.0.vcf', crlf(f"""BEGIN:VCARD
VERSION:3.0
PRODID:-//Apple Inc.//iPhone OS 17.0//EN
N:Árvíztűrő;Tükörfúrógép;;;
FN:Árvíztűrő Tükörfúrógép
ORG:Példa Kft.;Fejlesztés
TITLE:Mérnök
EMAIL;type=INTERNET;type=HOME;type=pref:arviz@example.hu
EMAIL;type=INTERNET;type=WORK:tukor@ceg.example.hu
TEL;type=CELL;type=VOICE;type=pref:+36 30 123 4567
TEL;type=WORK;type=VOICE:+36 1 234 5678
item1.ADR;type=HOME;type=pref:;;Fő utca 1.;Budapest;;1011;Magyarország
item1.X-ABADR:hu
BDAY;value=date:1980-05-17
PHOTO;ENCODING=b;TYPE=JPEG:{photo[:60]}
{photo_lines}
END:VCARD
""").encode('utf-8'))

# Android vCard 2.1: CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE with soft line breaks, bare TYPE params, BASE64 photo
n_qp = qp('Árvíztűrő') + ';' + qp('Tükörfúrógép') + ';;;'
fn_qp = qp('Árvíztűrő Tükörfúrógép')
note_qp = qp('Első sor\nMásodik sor, ékezettel: őű')
# a soft line break in the middle of the note (after an =XX, as Android does)
cut = note_qp.index('=0A') + 3
note_soft = note_qp[:cut] + '=\n' + note_qp[cut:]
adr_qp = ';;' + qp('Fő utca 1.') + ';Budapest;;1011;' + qp('Magyarország')
w('android-2.1.vcf', crlf(f"""BEGIN:VCARD
VERSION:2.1
N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:{n_qp}
FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:{fn_qp}
TEL;CELL;PREF:+36301234567
TEL;HOME:+3612345678
EMAIL;HOME:arviz@example.hu
ADR;HOME;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:{adr_qp}
NOTE;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:{note_soft}
PHOTO;ENCODING=BASE64;JPEG:{photo[:60]}
{photo_lines}

END:VCARD
BEGIN:VCARD
VERSION:2.1
N:Nagy;Anna;;;
FN:Nagy Anna
TEL;CELL:+36209876543
END:VCARD
""").encode('ascii'))

# Outlook (desktop) vCard 2.1: CHARSET=Windows-1250, QP for the long and multi-line values, LANGUAGE, X-MS lines, REV
def cp(s):
    return s.encode('cp1250').decode('latin1')
note_cp_qp = qp('Megjegyzés első sora\nmásodik sora', 'cp1250')
w('outlook-2.1.vcf', crlf(f"""BEGIN:VCARD
VERSION:2.1
N;LANGUAGE=hu;CHARSET=Windows-1250:{cp('Árvíztűrő;Tükörfúrógép')}
FN;CHARSET=Windows-1250:{cp('Árvíztűrő Tükörfúrógép')}
ORG;CHARSET=Windows-1250:{cp('Példa Kft.')}
TITLE;CHARSET=Windows-1250:{cp('Ügyvezető')}
NOTE;CHARSET=Windows-1250;ENCODING=QUOTED-PRINTABLE:{note_cp_qp}
TEL;WORK;VOICE:+36 1 234 5678
TEL;CELL;VOICE:+36 30 123 4567
ADR;WORK;PREF;CHARSET=Windows-1250:;;{cp('Fő utca 1.')};Budapest;;1011;{cp('Magyarország')}
LABEL;WORK;PREF;CHARSET=Windows-1250;ENCODING=QUOTED-PRINTABLE:{qp('Fő utca 1.', 'cp1250')}=0D=0A1011 Budapest
X-MS-OL-DEFAULT-POSTAL-ADDRESS:2
EMAIL;PREF;INTERNET:arviz@example.hu
X-MS-OL-DESIGN;CHARSET=utf-8:<card xmlns="http://schemas.microsoft.com/office/outlook/12/electronicbusinesscards"/>
REV:20261113T090000Z
END:VCARD
""").encode('latin1'))

# Thunderbird vCard 4.0 (RFC 6350): PREF=1, VALUE=TEXT and VALUE=uri tel:, UID, a URL and a PHOTO by URI (dropped)
w('thunderbird-4.0.vcf', crlf("""BEGIN:VCARD
VERSION:4.0
PRODID:-//Thunderbird.net/NONSGML Thunderbird//EN
FN:Árvíztűrő Tükörfúrógép
N:Árvíztűrő;Tükörfúrógép;;;
EMAIL;PREF=1:arviz@example.hu
EMAIL;TYPE=work:tukor@ceg.example.hu
TEL;TYPE=cell;VALUE=TEXT:+36 30 123 4567
TEL;TYPE=work;VALUE=uri:tel:+36-1-234-5678
ADR;TYPE=home:;;Fő utca 1.;Budapest;;1011;Magyarország
ORG:Példa Kft.
TITLE:Ügyvezető
NOTE:Megjegyzés\\, vesszővel\\; pontosvesszővel
BDAY;VALUE=DATE:19800517
URL;VALUE=URL:https://www.example.hu/
PHOTO;VALUE=uri:http://tracker.example.invalid/p.jpg
LOGO;VALUE=uri:https://tracker.example.invalid/logo.png
UID:urn:uuid:5f2b1c3e-0000-4000-8000-000000000001
END:VCARD
""").encode('utf-8'))

# Google CSV, the old header (Google CSV export), UTF-8 without BOM
w('google-old.csv', crlf("""Name,Given Name,Additional Name,Family Name,Yomi Name,Given Name Yomi,Additional Name Yomi,Family Name Yomi,Name Prefix,Name Suffix,Initials,Nickname,Short Name,Maiden Name,Birthday,Gender,Location,Billing Information,Directory Server,Mileage,Occupation,Hobby,Sensitivity,Priority,Subject,Notes,Language,Photo,Group Membership,E-mail 1 - Type,E-mail 1 - Value,E-mail 2 - Type,E-mail 2 - Value,Phone 1 - Type,Phone 1 - Value,Phone 2 - Type,Phone 2 - Value,Organization 1 - Type,Organization 1 - Name,Organization 1 - Yomi Name,Organization 1 - Title,Organization 1 - Department
Árvíztűrő Tükörfúrógép,Tükörfúrógép,,Árvíztűrő,,,,,,,,,,,1980-05-17,,,,,,,,,,,"Első sor
Második sor, vesszővel",,,* myContacts,* Home,arviz@example.hu ::: arviz2@example.hu,Work,tukor@ceg.example.hu,Mobile,+36 30 123 4567,Work,+36 1 234 5678,,Példa Kft.,,Ügyvezető,
Kiss Éva,Éva,,Kiss,,,,,,,,,,,,,,,,,,,,,,,,,* myContacts,Other,kiss.eva@example.com,,,,,,,,,,,
""").encode('utf-8'))

# Google CSV, the new header (contacts.google.com 2024+), UTF-8 with BOM
w('google-new.csv', b'\xef\xbb\xbf' + crlf('''First Name,Middle Name,Last Name,Phonetic First Name,Phonetic Middle Name,Phonetic Last Name,Name Prefix,Name Suffix,Nickname,File As,Organization Name,Organization Title,Organization Department,Birthday,Notes,Photo,Labels,E-mail 1 - Label,E-mail 1 - Value,E-mail 2 - Label,E-mail 2 - Value,Phone 1 - Label,Phone 1 - Value
Tükörfúrógép,,Árvíztűrő,,,,,,,,Példa Kft.,Ügyvezető,,1980-05-17,"Idézet: ""szia""",,* myContacts,Home,arviz@example.hu,Work,tukor@ceg.example.hu,Mobile,+36 30 123 4567
''').encode('utf-8'))

# Outlook CSV, English header, ',' (Outlook "Comma Separated Values" export; ANSI = Windows-1252 on an English Windows,
# here ASCII-safe except the names, written in UTF-8 as a newer Outlook does)
w('outlook-en.csv', crlf("""Title,First Name,Middle Name,Last Name,Suffix,Company,Department,Job Title,Business Street,Business City,Business Postal Code,Business Country/Region,Business Phone,Business Phone 2,Home Phone,Mobile Phone,E-mail Address,E-mail Type,E-mail Display Name,E-mail 2 Address,E-mail 2 Type,E-mail 2 Display Name,Notes
Dr.,Tükörfúrógép,,Árvíztűrő,,Példa Kft.,,Ügyvezető,Fő utca 1.,Budapest,1011,Hungary,+36 1 234 5678,,,+36 30 123 4567,arviz@example.hu,SMTP,Árvíztűrő Tükörfúrógép (arviz@example.hu),tukor@ceg.example.hu,SMTP,Tükör (tukor@ceg.example.hu),"Megjegyzés, vesszővel"
,Éva,,Kiss,,,,,,,,,,,,,kiss.eva@example.com,SMTP,Kiss Éva,,,,
""").encode('utf-8'))

# Outlook CSV, Hungarian header, ';' (Hungarian Windows list separator), Windows-1250. The header names besides the
# card's list (Utónév, Vezetéknév, Elektronikus levélcím, Mobiltelefon, Cég, Beosztás, Megjegyzések) are ASSUMED.
w('outlook-hu.csv', crlf("""Megszólítás;Utónév;Középső név;Vezetéknév;Utótag;Cég;Részleg;Beosztás;Munkahelyi telefon;Otthoni telefon;Mobiltelefon;Elektronikus levélcím;Elektronikus levélcím 2;Megjegyzések
;Tükörfúrógép;;Árvíztűrő;;Példa Kft.;;Ügyvezető;+36 1 234 5678;;+36 30 123 4567;arviz@example.hu;tukor@ceg.example.hu;"Első sor
második sor; pontosvesszővel"
;Éva;;Kiss;;;;;;;;kiss.eva@example.com;;
""").encode('cp1250'))
print('ok')
