// SPDX-License-Identifier: GPL-3.0-or-later
// Hungarian UI strings (renderer and main process). Keep all user-facing text here.
export const hu = {
  appTitle: 'ShadowMail',
  helloHeading: 'A ShadowMail működik',
  helloDataDir: 'Adatmappa',
  helloSqlite: 'SQLite verzió',
  helloVersion: 'Programverzió',
  loading: 'Betöltés…',
  errorTitle: 'ShadowMail: hiba',
  dataDirNotWritable: (dir, reason) =>
    `Az adatmappa nem írható, ezért a program kilép:\n${dir}\n\nOk: ${reason}\n\n` +
    'Másold a programot egy írható helyre (pl. a Dokumentumok mappába vagy pendrive-ra), és onnan indítsd.',
  // data folders this build does not open; it touches nothing in them
  legacyDataFolder:
    'Ez az adatmappa a ShadowMail egy korábbi, titkosítatlan fejlesztői változatából van, ez a változat nem nyitja meg. ' +
    'Nevezd át vagy töröld a data mappát.',
  vaultFileMissing:
    'Az adatmappában titkosított adatbázis van, de hiányzik mellőle a vault.json, ezért nem nyitható meg. ' +
    'Tedd vissza a vault.json fájlt (például egy mentésből), vagy nevezd át a data mappát.',

  // Vault
  vaultCreateHeading: 'Mesterjelszó beállítása',
  vaultCreateIntro:
    'A mesterjelszó védi a levelezést: a postafiókok jelszavait, a leveleket és a keresőindexet. Titkosítva, ebben a ' +
    'mappában utaznak a programmal; bármelyik gépen ezzel a mesterjelszóval nyithatók meg.',
  vaultForgetWarning:
    'A következő lépésben helyreállító kódot kapsz: ezzel léphetsz be, ha elfelejted a mesterjelszót. ' +
    'Kód és jelszó nélkül a helyben tárolt adat nem nyitható meg újra.',
  vaultPassword: 'Mesterjelszó',
  vaultPasswordAgain: 'Mesterjelszó még egyszer',
  vaultMinLength: n => `Legalább ${n} karakter.`,
  vaultCreateButton: 'Beállítás',
  vaultMismatch: 'A két jelszó nem egyezik.',
  vaultUnlockHeading: 'ShadowMail zárolva',
  vaultUnlockButton: 'Feloldás',
  vaultWorking: 'Egy pillanat…',
  vaultLockButton: 'Zárolás',
  settingsHeading: 'Beállítások',
  vaultChangeHeading: 'Mesterjelszó cseréje',
  vaultOldPassword: 'Jelenlegi mesterjelszó',
  vaultNewPassword: 'Új mesterjelszó',
  vaultNewPasswordAgain: 'Új mesterjelszó még egyszer',
  vaultChangeButton: 'Mesterjelszó cseréje',
  vaultChangeIntro: 'Ezzel oldod fel a ShadowMailt indításkor és zárolás után.',
  vaultChanged: 'A mesterjelszó megváltozott.',
  vaultErrors: {
    wrong_password: 'Hibás mesterjelszó',
    password_too_short: 'A mesterjelszó túl rövid (legalább 10 karakter).',
    password_too_long: 'A mesterjelszó túl hosszú.',
    bad_password: 'Érvénytelen jelszó.',
    vault_exists: 'A mesterjelszó már be van állítva.',
    no_vault: 'Még nincs mesterjelszó beállítva.',
    busy: 'Egy művelet már folyamatban van, várj egy kicsit.',
    locked: 'A program zárolva van.',
    unsupported_kdf: 'Ismeretlen kulcsképzés: a program újabb verziója kell hozzá.',
    confirm_word: 'A megerősítéshez pontosan ezt kell beírni: TÖRLÉS',
    unlocked: 'A program fel van oldva: az újrakezdés csak a feloldó képernyőről indítható.',
    vault_corrupt: 'A vault-fájl sérült.',
    // another version's vault.json; nothing is written
    vault_old_version:
      'Ez az adatmappa a ShadowMail egy korábbi fejlesztői változatából van, ez a változat nem nyitja meg. Kezdd újra (Elfelejtettem a mesterjelszót → Nincs kódom; minden helyi adat törlődik), vagy nevezd át vagy töröld a data mappát.',
    vault_newer_version:
      'Ezt az adatmappát egy újabb ShadowMail-változat készítette. Indítsd azt a változatot, vagy egy még újabbat; ez a régebbi változat nem nyitja meg, és nem is módosítja.',
    db_key: 'Az adatbázis nem nyitható ezzel a kulccsal.',
    db_open_failed: 'Az adatbázis nem nyitható meg.',
    db_missing: 'Az adatbázis (mail.sqlite) hiányzik az adatmappából, ezért nem nyitható meg. Tedd vissza, például egy mentésből.',
    // before the schema upgrade the backup needs as much free space as the database
    db_no_space: info =>
      info && info.needMb
        ? `Nincs elég szabad hely az adatbázis mentéséhez: ${info.needMb} MB kell, ${info.freeMb} MB szabad. Szabadíts fel helyet, és próbáld újra; az adatok érintetlenek.`
        : 'Nincs elég szabad hely az adatbázis mentéséhez. Szabadíts fel helyet, és próbáld újra; az adatok érintetlenek.',
    wrong_recovery_code: 'Hibás helyreállító kód',
    wrong_group: 'Ez nem egyezik a kód ezen csoportjával.',
    no_pending_code: 'Nincs megerősítésre váró kód.',
    reset_pending: 'Egy korábbi újrakezdés félbeszakadt, és a program nem tudja biztosan eldönteni, hol tartott.',
    not_available: 'Nincs befejezendő újrakezdés: a program a szokásos módon feloldható.',
    bad_recovery_code: 'Ez nem helyreállító kód: 25 karakter, ötös csoportokban.',
    no_recovery: 'Ehhez a vaulthoz nincs helyreállító kód.',
    internal: 'Váratlan hiba történt.',
  },
  vaultError: (code, info = null) => {
    const text = hu.vaultErrors[code] || hu.vaultErrors.internal
    return typeof text === 'function' ? text(info) : text
  },
  // on the lock screen while the schema upgrade (backup + migration) runs
  vaultDbUpgrade: 'Az adatbázis frissítése: először mentés készül, nagyobb adatnál ez néhány percig is eltarthat. Ne zárd be a programot.',
  // Forgotten master password
  vaultForgot: 'Elfelejtettem a mesterjelszót',
  lockDraftsFailed: n => `A zároláskor ${n} piszkozat mentése nem sikerült; a legutóbbi automatikus mentés a Piszkozatokban van.`, // a lock with an open composer
  // the two ways of a forgotten master password
  vaultForgotHeading: 'Elfelejtett mesterjelszó',
  vaultForgotHaveCode: 'Van helyreállító kódom',
  vaultForgotNoCode: 'Nincs kódom',
  vaultRecoverHeading: 'Belépés a helyreállító kóddal',
  vaultRecoverIntro: 'A helyreállító kóddal és egy új mesterjelszóval minden adat megmarad. Utána új kódot kapsz, a mostani érvényét veszti.',
  vaultRecoverCode: 'Helyreállító kód',
  vaultRecoverButton: 'Belépés és új mesterjelszó',
  vaultResetHeading: 'Teljes újrakezdés',
  vaultResetWarning:
    'Kód nélkül a helyben tárolt adat nem nyitható meg, ezért MINDEN helyi adat elvész: a fiókok és a jelszavaik, a keresőindex, ' +
    'a POP3-levelek, a helyi mappák, a csak helyben lévő piszkozatok és Elküldött-másolatok. Az IMAP-levelek a fiók újbóli ' +
    'felvétele után a szerverről újra letöltődnek.',
  vaultResetConfirmLabel: 'A megerősítéshez írd be: TÖRLÉS',
  vaultResetButton: 'Minden helyi adat törlése és új mesterjelszó',
  vaultResetBack: 'Mégis tudom a jelszót',
  // the way out of an interrupted reset that cannot be decided
  vaultResetPendingText:
    'Egy korábbi újrakezdés félbeszakadt, és a program nem tudja biztosan eldönteni, hol tartott. Befejezheted: ekkor MINDEN helyi adat törlődik, mint a »Nincs kódom« útnál.',
  vaultFinishResetButton: 'Újrakezdés befejezése',
  // the recovery code screen
  recoveryHeading: 'Helyreállító kód',
  recoveryIntro: 'Ezzel a kóddal léphetsz be, ha elfelejted a mesterjelszót. Írd le vagy mentsd el, és tartsd biztos helyen, a géptől és a pendrive-tól külön.',
  recoveryWarning:
    'Aki a kódot megszerzi, a mesterjelszó nélkül is kinyitja a levelezésedet. A program a kódot nem tárolja: ha elveszik, a Beállításokban újat készíthetsz. ' +
    'A régi kód és a régi jelszó egy korábbi adatmappa-mentéssel együtt továbbra is kinyitja a levelezést. Ha a kód vagy a jelszó illetéktelen kézbe került, a régi mentéseket is semmisítsd meg.',
  recoveryCodeAfterError: (error, code) => `${error} Az új helyreállító kódod (írd fel, a régi már nem érvényes): ${code}`,
  recoveryCopy: 'Másolás',
  recoveryCopied: 'Vágólapra másolva.',
  recoveryClipboardNote: 'A kód 60 mp múlva törlődik a vágólapról.', // the clipboard guard
  recoverySave: 'Mentés fájlba',
  recoverySaved: 'Elmentve.',
  recoveryCheck: n => `Ellenőrzés: írd be a kód ${n}. csoportját`,
  recoveryCheckWrong: 'Ez nem egyezik a kód ezen csoportjával.',
  recoveryDone: 'Megvan, tovább',
  recoveryUnconfirmed: 'A helyreállító kódod nincs megerősítve. Készíts újat a Beállításokban, és írd fel.',
  recoveryGoSettings: 'Új kód készítése…',
  recoveryNewHeading: 'Új helyreállító kód',
  recoveryNewIntro: 'Az új kód elkészülte után a mostani érvényét veszti.',
  recoveryNewButton: 'Új kód készítése',
  recoveryFileName: 'ShadowMail-helyreallito-kod.txt',
  recoveryFileText: code =>
    `ShadowMail helyreállító kód\r\n\r\n${code}\r\n\r\n` +
    'Ezzel a kóddal lehet belépni, ha a mesterjelszó elfelejtődik ("Elfelejtettem a mesterjelszót" -> "Van helyreállító kódom").\r\n' +
    'Aki megszerzi, a mesterjelszó nélkül is kinyitja a levelezést: tartsd biztos helyen, a programtól külön.\r\n',
  accountNoPassword: 'nincs jelszó',
  accountNoPasswordHint: 'Ehhez a fiókhoz nincs elmentett jelszó: nyisd meg a Szerkesztést, és add meg újra.',

  // Accounts
  accountsHeading: 'Postafiókok',
  accountsEmpty: 'Még nincs postafiók.',
  accountNew: 'Új fiók',
  accountEdit: 'Szerkesztés',
  accountDelete: 'Törlés',
  accountDeleteConfirm: name =>
    `Biztosan törlöd a(z) „${name}” fiókot? A fiók levelei, mappái és jelszavai is törlődnek erről a gépről (a szerveren maradnak).`,
  accountDeleteYes: 'Igen, törlöm',
  accountSave: 'Mentés',
  accountCancel: 'Mégse',
  accountSaved: 'Mentve.',
  accountTest: 'Kapcsolat próbája',
  accountTesting: 'Próba folyamatban…',
  accountFields: {
    type: 'Típus',
    name: 'Fiók neve',
    email: 'E-mail cím',
    display_name: 'Megjelenő név',
    incoming: 'Bejövő szerver',
    in_host: 'Szerver',
    in_port: 'Port',
    in_security: 'Biztonság',
    in_user: 'Felhasználónév',
    in_password: 'Jelszó',
    smtp: 'Kimenő (SMTP) szerver',
    smtp_host: 'Szerver',
    smtp_port: 'Port',
    smtp_security: 'Biztonság',
    smtp_user: 'Felhasználónév (üres = a bejövővel azonos)',
    smtp_same_password: 'Az SMTP-jelszó ugyanaz',
    smtp_password: 'SMTP-jelszó',
    tls_verify: 'Tanúsítvány ellenőrzése',
    index_years: 'Indexelt levelek: utolsó N év',
    index_all: 'mind',
    sync_interval_min: 'Frissítés (perc)',
    save_sent_to_server: 'Elküldött levelek mentése a szerverre',
    archive_mode: 'Archiválás',
    pop3_delete_after_days: 'Törlés a szerverről N nap után (üres = soha)',
    signature: 'Aláírás',
  },
  // the account editor's own words (the shared form base); accountFields stays the field names of Claude's confirm view
  accountForm: {
    editTitle: 'Fiók szerkesztése',
    sections: { account: 'Fiók', incoming: 'Bejövő szerver', incomingImap: 'Bejövő szerver (IMAP)', incomingPop3: 'Bejövő szerver (POP3)', smtp: 'Kimenő szerver (SMTP)', folders: 'Mappák', sync: 'Szinkronizálás', signature: 'Aláírás' },
    typeLocked: 'Mentés után nem változtatható.',
    smtpUser: 'Felhasználónév',
    smtpUserHint: 'Üresen hagyva a bejövővel azonos.',
    indexYears: 'Indexelt levelek',
    yearsUnit: 'év',
    indexAll: 'Mind',
    syncInterval: 'Frissítés',
    minutesUnit: 'percenként',
    signatureText: 'Szöveg',
  },
  accountPasswordUnchanged: '•••• (változatlan)',
  securityLabels: { tls: 'SSL/TLS', starttls: 'STARTTLS', none: 'Nincs (titkosítatlan)' },
  typeLabels: { imap: 'IMAP', pop3: 'POP3' },
  accountTypeHelp: { imap: 'a levelek a szerveren maradnak, minden eszközről ugyanazt látod', pop3: 'a levelek letöltődnek erre a gépre, a szerverről csak a beállítás szerint törlődnek' },
  tlsVerifyOffWarning:
    'A tanúsítvány-ellenőrzés ki van kapcsolva: a kapcsolat titkosított, de nem ellenőrzött, hogy valóban a te szervereddel beszélsz. Csak akkor kapcsold ki, ha a tárhely tanúsítványa más névre szól.',
  noSecurityWarning: 'Titkosítás nélkül a jelszó és a levelek olvashatóan mennek a hálózaton.',
  indexHelp: 'Ennél régebbi levelekben csak a feladóra, címzettre, tárgyra és dátumra lehet keresni, a megnyitottakban a szövegre is.',
  indexHelpImap: 'A régebbiek szövegére a Keresés a szerveren is gomb keres.',
  // measured live: a test server marks a message read when POP3 fetches it
  pop3SeenHelp: 'Egyes szerverek (pl. Dovecot) a POP3-letöltéskor a levelet a szerveren olvasottnak jelölik. Ha ugyanezt a postafiókot IMAP-on (webmail, telefon) is nézed, ott a letöltött levelek olvasottként látszanak.',
  reindexStatus: (cleared, requeued) => `Újraindexelés: ${cleared} levél szövege kikerült az indexből, ${requeued} levélé a következő szinkronnál töltődik be.`,
  accountErrors: {
    required: 'Kötelező mező.',
    too_long: 'Túl hosszú.',
    bad_email: 'Érvénytelen e-mail cím.',
    bad_type: 'Válaszd ki a fiók típusát (IMAP vagy POP3).',
    type_locked: 'Meglévő fiók típusa nem változtatható.',
    bad_host: 'Érvénytelen szervernév.',
    bad_security: 'Válassz biztonsági módot.',
    bad_port: 'A port 1 és 65535 közötti egész szám.',
    bad_index_years: 'Egész szám 1 és 50 között, vagy „mind”.',
    bad_interval: 'Egész szám 1 és 1440 között.',
    bad_archive_mode: 'Ismeretlen archiválási mód.',
    bad_days: 'Egész szám 0 és 3650 között, vagy üres.',
    bad_password: 'Érvénytelen jelszó.',
    bad_chars: 'Sortörés vagy vezérlőkarakter nem lehet benne.',
    not_found: 'A fiók nem található.',
    unknown: 'Hibás érték.',
  },
  accountError: code => hu.accountErrors[code] || hu.accountErrors.unknown,
  // the signature image of an account (under the text signature)
  signatureImage: {
    label: 'Aláírás-kép',
    none: 'Nincs kép. A kép a szöveges aláírás alatt jelenik meg a levelekben.',
    alt: 'Az aláírás képe',
    upload: 'Kép feltöltése…',
    replace: 'Csere…',
    remove: 'Eltávolítás',
    help: 'PNG vagy JPG, legfeljebb 800 x 400 képpont és 150 KB. A kép nem méreteződik át; a metaadatai (például a GPS-hely vagy a szerző) mentéskor kikerülnek.',
    saveFirst: 'Aláírás-képet a fiók mentése után tölthetsz fel.',
    error: r => {
      if (r.error === 'too_large' && r.width && (r.width > r.maxWidth || r.height > r.maxHeight)) return `A kép ${r.width} x ${r.height} px, legfeljebb ${r.maxWidth} x ${r.maxHeight} px lehet.`
      if (r.error === 'too_large') return `A kép ${Math.ceil(r.bytes / 1024)} KB, legfeljebb ${Math.round((r.maxBytes || 153600) / 1024)} KB lehet.`
      if (r.error === 'unsupported_image') return 'Ez nem PNG vagy JPG kép, vagy sérült (animált PNG sem lehet).'
      if (r.error === 'read_failed') return 'A fájlt nem sikerült beolvasni.'
      return 'A kép mentése nem sikerült.'
    },
  },
  probeIncoming: 'Bejövő',
  probeSmtp: 'Kimenő (SMTP)',
  probeOk: 'rendben',
  // 0.17.0: the connection test's custom-keyword line (true / false / null)
  // the IMAP server's answer: where this account's labels are kept (on the server as keywords, or locally)
  probeKeywords: v =>
    `Egyéni címkét a szerver: ${v === true ? 'enged (a címkék ennél a fióknál a szerveren tárolódnak)' : v === false ? 'nem enged (a címkék ennél a fióknál csak ezen a gépen tárolódnak)' : 'nem mérhető'}`,
  probeErrors: {
    auth_failed: 'Hibás felhasználónév vagy jelszó.',
    auth_not_offered: 'A szerver ezen a kapcsolaton nem enged bejelentkezést (titkosítás nélkül a legtöbb szerver nem engedi: válassz SSL/TLS-t vagy STARTTLS-t).',
    host_not_found: 'A szerver nem található (ellenőrizd a szervernevet).',
    connection_refused: 'A szerver nem fogadja a kapcsolatot ezen a porton (ellenőrizd a portot).',
    timeout: 'A szerver nem válaszolt időben (rossz port vagy tűzfal).',
    tls_certificate: 'A szerver tanúsítványa nem érvényes erre a névre, vagy nem megbízható.',
    starttls_unsupported: 'A szerver nem támogatja a STARTTLS-t ezen a porton.',
    tls_mismatch: 'A biztonsági mód nem illik a porthoz (pl. SSL/TLS egy titkosítatlan porton).',
    mailbox_in_use: 'A postafiókot épp egy másik kapcsolat használja (másik program vagy egy korábbi letöltés); kicsit később újra.',
    unknown: 'Ismeretlen hiba a kapcsolódáskor.',
  },
  probeError: code => hu.probeErrors[code] || hu.probeErrors.unknown,

  // Mail view
  viewMail: 'Levelek',
  viewSettings: 'Fiókok és beállítások',
  settingsNavLabel: 'Beállítások',
  // the address book (Címlista)
  viewContacts: 'Címlista',
  // Claude wants to show a message while an editor is open
  claudeOffer: 'Claude meg szeretne mutatni egy levelet. A megnyitás elhagyja a félkész szerkesztést.',
  claudeOfferOpen: 'Megnyitás',
  claudeOfferSearch: 'Claude meg szeretne mutatni egy keresést. A megjelenítés elhagyja a félkész szerkesztést.',
  claudeOfferSearchOpen: 'Megjelenítés',
  contacts: {
    title: 'Címlista',
    search: 'Keresés a címlistában',
    searchClear: 'Keresés törlése',
    count: n => `${n} névjegy`,
    selected: n => `${n} kijelölve`,
    listLabel: 'Névjegyek',
    newContact: 'Új névjegy',
    import: 'Importálás…',
    export: 'Exportálás',
    exportAllVcf: 'Mind, vCard (.vcf)',
    exportAllCsv: 'Mind, CSV (.csv)',
    exportSelVcf: 'A kijelöltek, vCard (.vcf)',
    exportSelCsv: 'A kijelöltek, CSV (.csv)',
    deleteSelected: 'Kijelöltek törlése',
    select: name => `${name} kijelölése`,
    source: { auto: 'Automatikus', manual: 'Kézi', import: 'Importált' },
    sourceHint: { auto: 'Küldéskor került be magától', manual: 'Kézzel vetted fel', import: 'Fájlból importáltad' },
    empty: 'Még nincs névjegy. Küldéskor a címzettek maguktól bekerülnek, vagy importálhatsz egy fájlt.',
    noMatch: 'Nincs találat.',
    choose: 'Válassz egy névjegyet a listából.',
    noName: '(név nélkül)',
    write: 'Levél írása',
    edit: 'Szerkesztés',
    delete: 'Törlés',
    primary: 'elsődleges',
    fields: { displayName: 'Megjelenített név', givenName: 'Utónév', familyName: 'Vezetéknév', org: 'Cég', title: 'Beosztás', note: 'Megjegyzés' },
    emails: 'E-mail címek',
    phones: 'Telefonszámok',
    address: 'Cím',
    number: 'Szám',
    label: 'Címke',
    primaryChoice: 'Elsődleges cím',
    addEmail: 'Cím hozzáadása',
    addPhone: 'Telefon hozzáadása',
    removeEmail: n => `${n}. cím eltávolítása`,
    removePhone: n => `${n}. telefon eltávolítása`,
    // the address book on the shared form base
    emptyTitle: 'Nincs kiválasztott névjegy',
    emptyText: 'Válassz egyet a listából, vagy vegyél fel újat. Importálni vCard- és CSV-fájlból lehet.',
    primaryTag: 'Elsődleges',
    detailEmail: 'E-mail',
    detailPhone: 'Telefon',
    detailSource: 'Forrás',
    sectionName: 'Név',
    sectionWork: 'Munkahely',
    headAddress: 'E-mail cím',
    headNumber: 'Telefonszám',
    emailRow: n => `${n}. e-mail cím`,
    emailLabelRow: n => `${n}. cím címkéje`,
    primaryRow: n => `${n}. cím az elsődleges`,
    phoneRow: n => `${n}. telefonszám`,
    phoneLabelRow: n => `${n}. telefon címkéje`,
    save: 'Mentés',
    cancel: 'Mégse',
    newTitle: 'Új névjegy',
    editTitle: 'Névjegy szerkesztése',
    saved: 'A névjegy mentve.',
    errors: {
      bad_request: 'Valamelyik mező nem megfelelő: kell egy név vagy egy érvényes cím, és a mezők nem lehetnek túl hosszúak.',
      address_taken: 'Ez a cím már egy másik névjegyé.',
      not_found: 'Ez a névjegy közben megszűnt.',
      preview_expired: 'Az előnézet lejárt (5 perc). Válaszd ki újra a fájlt.',
      nothing_to_export: 'Nincs mit exportálni.',
      unsupported_file: 'Ezt a fájlt nem tudom beolvasni: .vcf, .vcard vagy .csv kell.',
      read_failed: 'A fájl nem olvasható.',
      write_failed: 'A fájlt nem sikerült menteni.',
      too_large: 'A fájl túl nagy (legfeljebb 10 MB).',
      too_many: 'A fájlban túl sok névjegy van (legfeljebb 10 000).',
      not_available: 'Ez most nem érhető el.',
      internal: 'Váratlan hiba történt.',
    },
    error: code => hu.contacts.errors[code] || hu.contacts.errors.internal,
    openOther: 'A másik névjegy megnyitása',
    deleteTitle: n => (n === 1 ? 'Névjegy törlése' : `${n} névjegy törlése`),
    deleteText: 'A törölt névjegy a következő levélnél nem kerül vissza magától.',
    deleted: n => `${n} névjegy törölve.`,
    importTitle: 'Importálás előnézete',
    importCounts: c => `Új: ${c.new}, összevont: ${c.merged}, változatlan: ${c.unchanged}, nem importálható: ${c.invalid}`,
    importInvalid: 'Nem importálható sorok',
    importWarnings: n => `${n} névjegynél kimaradt cím vagy telefon (a névjegy bejön)`,
    importSample: 'Minta',
    importKind: { new: 'új', merged: 'összevont' },
    reasons: {
      two_people: 'a címei két névjegyhez tartoznak',
      no_name_or_address: 'nincs neve és érvényes címe',
      missing_end: 'hiányzik a névjegy vége (END:VCARD)',
      missing_begin: 'hiányzik a névjegy eleje (BEGIN:VCARD)',
      line_too_long: 'túl hosszú sor (64 KB felett)',
      unterminated_quote: 'lezáratlan idézőjel',
      unknown_header: 'ismeretlen fejléc: nem Google- és nem Outlook-formátum',
      address_limit: n => `${n} cím vagy telefon a 20-as korlát fölött kimaradt`,
      invalid_address: n => `${n} nem e-mail alakú cím kimaradt`,
    },
    reason: (code, dropped) => {
      const r = hu.contacts.reasons[code]
      return typeof r === 'function' ? r(dropped) : r || code
    },
    row: n => `${n}. sor`,
    doImport: 'Importálás',
    imported: c => `Importálva: ${c.new} új, ${c.merged} összevont, ${c.unchanged} változatlan.`,
    exported: n => `${n} névjegy exportálva.`,
    addSender: 'Címlistához ad',
    senderAdded: 'A feladó bekerült a címlistába.',
  },
  splitterContacts: 'Névjegylista szélessége',
  // the draggable dividers' names (the arrows move them, Home or a double click gives back the default)
  splitters: { sidebar: 'Mappasáv szélessége', list: 'Levéllista szélessége', listh: 'Levéllista magassága', settings: 'Beállítások menü szélessége' },
  settingsNav: { accounts: 'Fiókok', appearance: 'Megjelenés', security: 'Biztonság', claude: 'Claude-hozzáférés', labels: 'Címkék', about: 'Névjegy' },
  // MCP: the "Claude-hozzáférés" page (ClaudeAccess.jsx)
  claudeAccess: {
    title: 'Claude-hozzáférés',
    intro: 'Bekapcsolva a gépeden futó Claude (Claude Desktop vagy Claude Code) eléri a leveleidet ezen a programon keresztül, amíg a ShadowMail fut és fel van oldva. Kikapcsolva, zárolva vagy bezárt programmal Claude semmit nem ér el.',
    switchLabel: 'Claude-hozzáférés bekapcsolva',
    switchFailed: 'A kapcsolót nem sikerült átállítani.',
    stateLabel: 'Állapot:',
    stateOff: 'Kikapcsolva',
    stateStarting: 'Indul…',
    stateWaiting: 'Várakozik (nincs kapcsolódó Claude)',
    stateConnected: n => `Kapcsolódva: ${n}`,
    connectTitle: 'Beállítás a Claude-ban',
    connectIntro: 'A ShadowMail a Claude beállításait nem írja: az alábbiak egyikét te másolod be. Mindkettő a program mostani helyét tartalmazza.',
    desktopTitle: 'Claude Desktop: a claude_desktop_config.json fájlba',
    desktopHint: 'A fájl helye Windowson: %APPDATA%\\Claude\\claude_desktop_config.json (macOS-en: ~/Library/Application Support/Claude/claude_desktop_config.json). Ha már van benne "mcpServers", csak a "shadowmail" részt tedd mellé. Mentés után indítsd újra a Claude Desktopot.',
    codeTitle: 'Claude Code: parancs a terminálba',
    codeHint: 'A --scope user miatt minden projektben elérhető. A Claude Code-ban a /mcp parancs mutatja, kapcsolódott-e.',
    codeHintPowershell: 'A program útjában $ vagy ` jel van, ezért ez a parancs PowerShellbe való (a parancssor másként kezeli az idézőjelet). A --scope user miatt minden projektben elérhető; a Claude Code-ban a /mcp parancs mutatja, kapcsolódott-e.',
    copy: 'Másolás',
    copied: 'Kimásolva',
    copyFailed: 'A másolás nem sikerült.',
    moved: 'Ha áthelyezted a ShadowMail mappáját, másold be újra: a Claude a régi helyen keresi a programot.',
    rulesTitle: 'Mit tehet Claude?',
    freeTitle: 'Megerősítés nélkül:',
    free: 'olvasás és keresés (a levél nem lesz olvasott), jelölés (olvasott, csillag), áthelyezés, Kukába helyezés, mappa létrehozása és átnevezése, piszkozat írása és módosítása (a Piszkozatok mappába, "Claude" jellel; a módosítás a lenti kapcsolóval megerősítéshez köthető), frissítés, a fiók kapcsolatának próbája.',
    confirmTitle: 'Csak a te megerősítéseddel, ebben az ablakban:',
    confirm: 'levél küldése, végleges törlés, mappa és fiók törlése, fiók-beállítás módosítása, leállt fiók belépésének újraindítása. Ezek egyenként kikapcsolhatók a lenti Megerősítések résznél (a küldés csak a névjegyzékben szereplő címekre).',
    neverTitle: 'Soha:',
    never: 'jelszó, mesterjelszó és helyreállító kód, mellékletek tartalma, helyi fájl csatolása, és ezen a lapon egyik kapcsoló sem.',
    threat: 'A védelem a gépeden futó más programok és a levelekbe rejtett utasítások ellen szól; egy, a te felhasználódként futó kártevő ellen ez a kapcsoló nem véd.',
    webTools: 'Javaslat: a Claude-ban a webes és egyéb eszközök jóváhagyás-kérése maradjon bekapcsolva, mert egy levélbe rejtett utasítás azokon át próbálhatna adatot kivinni.',
    recentTitle: 'Legutóbbi Claude-hívások',
    recentEmpty: 'Még nem volt hívás.',
    recentHint: 'Az utolsó 20 hívás, csak a memóriában: zárolás vagy újraindítás után üres. Keresőszó, cím, tárgy vagy levélszöveg nem kerül ide.',
    colTime: 'Idő',
    colTool: 'Eszköz',
    colResult: 'Eredmény',
    colItems: 'Darab',
    result: r => ({ ok: 'rendben', pending_confirmation: 'megerősítésre vár', dropped: 'megszakadt' })[r] || `hiba (${r})`,
    confirmResult: r => `megerősítés: ${({ approved: 'jóváhagyva', rejected: 'elutasítva', expired: 'lejárt', failed: 'nem sikerült' })[r] || r}`,
    autoResult: r => `megerősítés nélkül: ${r === 'ok' ? 'lefutott' : `nem sikerült (${r})`}`,
    confirmsTitle: 'Megerősítések',
    confirmsIntro: 'Ezeknél a műveleteknél Claude csak a te jóváhagyásoddal léphet. Alapból mind be van kapcsolva, kivéve a piszkozat módosítását; kikapcsolva a művelet ablak nélkül, azonnal lefut, és a lenti listában látszik. Egyik sem vonható vissza.',
    confirmOps: {
      send: 'Levél küldése',
      deleteMessages: 'Levelek végleges törlése',
      deleteFolder: 'Mappa törlése',
      updateAccount: 'Fiók-beállítás módosítása',
      deleteAccount: 'Fiók törlése',
      restartLogin: 'Leállt fiók belépésének újraindítása',
      updateDraft: 'Piszkozat módosítása',
    },
    confirmOpDesc: {
      send: 'Kikapcsolva megerősítés nélkül küldhet a névjegyzékben szereplő címekre: a kézzel felvettek, az importáltak és azok, akiknek te magad írtál. Ha bármelyik címzett nincs a névjegyzékben, vagy a címben ékezetes vagy más nem angol betű van, az ablak ugyanúgy feljön, és megmutatja ezt a címet.',
      deleteMessages: 'A Kukában lévő, vagy Kuka nélküli fiók leveleinek végleges törlése.',
      deleteFolder: 'Egy mappa törlése a benne lévő levelekkel együtt.',
      updateAccount: 'A név, az aláírás és a többi fiók-beállítás módosítása. A belépési adatokra (szerver, port, titkosítás, felhasználónév, tanúsítvány-ellenőrzés) ez a kapcsoló nem vonatkozik: azok módosítása előtt mindig megkérdez.',
      deleteAccount: 'Egy fiók törlése a gépről, minden helyi adatával.',
      restartLogin: 'Egy elutasított belépés miatt leállt fiók újbóli belépése. Kikapcsolva fiókonként egyszer próbál magától; utána ismét megkérdez, amíg te nem lépsz (Frissítés, a fiók mentése vagy egy sikeres kapcsolat-próba).',
      updateDraft: 'Egy Piszkozatok-beli levél szövegének, tárgyának és címzettjeinek módosítása. Semmit nem küld (a küldésre a Levél küldése kapcsolója vonatkozik), ezért alapból ki van kapcsolva; bekapcsolva minden módosítás előtt megkérdez.',
    },
    confirmOffWarning: op => op === 'send'
      ? 'Kikapcsolva: egy beérkező levél szövege megpróbálhatja rávenni Claude-ot, hogy a nevedben levelet küldjön a névjegyzékedben szereplő címekre; megerősítés nélkül ezt semmi nem állítja meg.'
      : 'Kikapcsolva: egy beérkező levél szövege megpróbálhatja rávenni Claude-ot erre a műveletre; megerősítés nélkül ezt semmi nem állítja meg, és nem vonható vissza.',
    confirmOffTitle: name => `Kikapcsolod a megerősítést? (${name})`,
    confirmOffNoUndo: 'A kapcsoló bármikor visszakapcsolható. A megerősítés nélkül lefutott műveletek nem vonhatók vissza.',
    confirmOffCancel: 'Mégse',
    confirmOffYes: 'Kikapcsolom',
    confirmLoadFailed: 'A megerősítési beállítások nem tölthetők be.',
    confirmSwitchFailed: 'A kapcsolót nem sikerült átállítani.',
  },
  passwordShow: 'Jelszó megjelenítése',
  passwordHide: 'Jelszó elrejtése',
  backToMail: 'Vissza a levelekhez',
  sidebarCollapse: 'Oldalsáv összecsukása',
  sidebarExpand: 'Oldalsáv kinyitása',
  accountFoldersHide: account => `${account}: mappák elrejtése`,
  accountFoldersShow: account => `${account}: mappák megjelenítése`,
  refresh: 'Frissítés',
  folderRoles: {
    inbox: 'Beérkezett',
    drafts: 'Piszkozatok',
    sent: 'Elküldött',
    trash: 'Kuka',
    junk: 'Levélszemét',
    archive: 'Archívum',
  },
  archiveCreated: paths => `Az archiváláshoz új mappa készült: ${paths.join(', ')}`,
  archiveModes: { '': 'Automatikus (évenként, ha az Archívumban már van évszám-mappa)', single: 'Egy mappába (Archívum)', yearly: 'Évenként (Archívum/2024)' },
  folderRolePicker: {
    label: 'Mappaszerepek',
    auto: 'Automatikus',
    autoNow: path => `Automatikus (most: ${path})`,
    help: 'Melyik mappa legyen az Elküldött, a Kuka, a Piszkozatok, a Levélszemét és az Archívum. Az Automatikus a szerver jelzése, a korábbi választás vagy a szokásos név szerint dönt, két hasonló nevű mappa közül a több levelet tartalmazót választja. A választás azonnal érvényes, a szerveren semmi nem változik.',
  },
  foldersHeading: 'Mappák',
  unreadCount: n => `${n} olvasatlan`,
  unreadCountFolded: n => `${n} olvasatlan, az almappákkal együtt`,
  folderFoldHide: folder => `${folder}: almappák elrejtése`,
  folderFoldShow: folder => `${folder}: almappák megjelenítése`,
  noMailAccounts: 'Még nincs postafiók. Vegyél fel egyet a „Fiókok és beállítások” alatt.',
  noFolders: 'A mappák az első szinkron után jelennek meg.',
  chooseFolder: 'Válassz mappát.',
  listEmpty: 'Ebben a mappában nincs levél.',
  listCount: n => `${n.toLocaleString('hu-HU')} levél`,
  // since 0.10.1 the chips filter the folder view too
  listFiltered: folderTotal => ` (szűrve, összesen ${folderTotal.toLocaleString('hu-HU')})`,
  listFilteredEmpty: 'Nincs a szűrőknek megfelelő levél.',
  // MCP: the connector's answer when the app cannot be reached
  mcpUnavailable: 'A ShadowMail nem fut, zárolva van, vagy a Claude-hozzáférés ki van kapcsolva.',
  mcpTooMany: 'A ShadowMailhez már két Claude-kapcsolat él (ennyi lehet egyszerre). Zárj be egy másik Claude-munkamenetet, és próbáld újra.',
  listLoadError: code => `A levéllista nem tölthető be: ${hu.searchError(code)}`,
  clearFilters: 'Szűrők törlése',
  // recipient: the Sent and Drafts lists' sender column shows the recipient, and the order follows it
  listSortField: { date: 'Dátum', from: 'Feladó', subject: 'Tárgy', recipient: 'Címzett' },
  listSortChip: (sort, dir) => `Rendezés: ${hu.listSortField[sort]}, ${dir === 'asc' ? 'növekvő' : 'csökkenő'}`,
  listColumns: { star: 'Csillag', attachment: 'Melléklet', from: 'Feladó', subject: 'Tárgy', date: 'Dátum' },
  noSubject: '(nincs tárgy)',
  unknownSender: '(ismeretlen feladó)',
  noRecipient: '(nincs címzett)',
  flagged: 'Csillagozott',
  hasAttachment: 'Van melléklet',
  // Message list
  listToolsLabel: 'Levéllista',
  selectRow: 'Kijelölés',
  selectAll: 'Mind kijelölése',
  selectMenu: 'Kijelölési lehetőségek',
  selectMenuItems: { all: 'Mind', none: 'Egyik sem', read: 'Olvasottak', unread: 'Olvasatlanok' },
  moreMenu: 'További',
  sortMenu: { date: 'Rendezés dátum szerint', from: 'Rendezés feladó szerint', subject: 'Rendezés tárgy szerint', recipient: 'Rendezés címzett szerint', reverse: 'Fordított sorrend' },
  starToggle: 'Csillag',
  listRange: (range, total) => `${range} (összesen ${total.toLocaleString('hu-HU')} levél)`,
  syncPhases: {
    connecting: 'kapcsolódás…',
    metadata: (folder, p) => `mappa frissítése: ${folder}${p ? ` (${p.done} / ${p.total})` : ''}`,
    bodies: (p, requeued) => `${requeued ? 'Újraindexelés' : 'szövegek indexelése'}${p ? `: ${p.done} / ${p.total}` : ''}`,
  },
  syncedAt: time => `frissítve ${time}`,
  syncNever: 'még nem frissült',
  syncLive: 'élő',
  // Background sync: the probe's texts (hu.probeErrors) assume a settings mistake; during a sync the
  // usual cause is the network, so these come first.
  syncErrors: {
    connection_lost: 'megszakadt a kapcsolat, újrapróbálom…',
    host_not_found: 'a szerver nem érhető el (nincs hálózat, vagy hibás a szervernév); újrapróbálom…',
    connection_refused: 'a szerver nem fogadja a kapcsolatot (nincs hálózat, a szerver tilt, vagy hibás a port); újrapróbálom…',
    timeout: 'a szerver nem válaszolt időben; újrapróbálom…',
    auth_failed: 'a szerver elutasította a belépést (hibás felhasználónév vagy jelszó).',
    no_password: 'nincs elmentett jelszó: add meg a fiók beállításainál.',
    folder: 'néhány mappát a szerver nem adott ki.',
    uidl_unsupported: 'a POP3-szerver nem támogatja az UIDL parancsot, ezért nem tudom, mely levelek újak.',
    mailbox_in_use: 'a postafiókot épp egy másik kapcsolat használja; újrapróbálom…',
    partial: 'néhány levelet a szerver nem adott ki; a következő frissítéskor újra megpróbálom.',
  },
  syncError: code => hu.syncErrors[code] || hu.probeErrors[code] || hu.probeErrors.unknown,
  syncStopped: 'Az automatikus frissítés szünetel: javítsd a fiók beállítását, vagy nyomd meg a Frissítés gombot.',

  // Reader pane
  readerEmpty: 'Válassz levelet a listából.',
  readerLoading: 'A levél betöltése…',
  readerHeaders: { from: 'Feladó', to: 'Címzett', cc: 'Másolat', replyTo: 'Válaszcím', date: 'Dátum' },
  readerFrameTitle: 'A levél szövege',
  // the link-target bar: where the link under the mouse or the keyboard focus really goes
  linkTarget: {
    label: 'A link valódi célja',
    mismatch: 'Figyelem: a link máshová visz, mint amit a szövege mutat',
    realHost: 'Valódi cél:',
    textShows: 'a szövege ezt mutatja:',
    idn: 'Nemzetközi (punycode) cím, betűkkel:',
  },
  readerImagesBlocked: n => `A levélben ${n > 1 ? 'külső képek vannak' : 'külső kép van'}, ezeket a biztonság kedvéért nem töltöttem be (a feladó így nem tudja meg, hogy megnyitottad).`,
  readerLoadImages: 'Képek betöltése',
  readerAttachments: n => `Mellékletek (${n})`,
  readerSave: 'Mentés…',
  // "Összes mentése": every attachment into one folder (the reader's attachment heading, 2+ attachments)
  readerSaveAll: n => `Összes mentése (${n})`,
  readerSavedAll: n => `${n} fájl mentve.`,
  readerShowInFolder: 'Megnyitás a mappában',
  readerSaveSkipped: (name, code) =>
    `Kimaradt: ${name} (${
      { bad_name: 'a neve nem menthető', name_taken: 'túl sok ilyen nevű fájl van már a mappában', not_writable: 'a mappába nem lehet írni', disk_full: 'betelt a lemez' }[code] ||
      'nem sikerült kiírni'
    }).`,
  readerSavedExecutable: n =>
    n === 1
      ? 'A mentett fájlok közt egy futtatható is van: csak akkor indítsd el, ha a feladóban megbízol.'
      : `A mentett fájlok közt ${n} futtatható is van: csak akkor indítsd el őket, ha a feladóban megbízol.`,
  readerSavedBrowserActive: n =>
    n === 1
      ? 'A mentett fájlok közt egy weboldal-jellegű (HTML, SVG, XML) is van: a böngészőben programot futtathat, csak akkor nyisd meg, ha a feladóban megbízol.'
      : `A mentett fájlok közt ${n} weboldal-jellegű (HTML, SVG, XML) is van: a böngészőben programot futtathatnak, csak akkor nyisd meg őket, ha a feladóban megbízol.`,
  readerOpen: 'Megnyitás',
  readerExecutable: 'Futtatható fájl: csak menteni lehet, megnyitni innen nem.',
  readerBrowserActive: 'Weboldal-jellegű fájl (HTML, SVG, XML): a böngészőben programot futtathatna, ezért csak menteni lehet.',
  readerNotOpenable: 'Ezt a fájltípust nem nyitom meg közvetlenül, csak menteni lehet.', // not on the allow list
  readerThread: 'Szál',
  readerThreadHide: 'Szál elrejtése',
  readerThreadHeading: n => `A szál levelei (${n})`,
  readerThreadCurrent: 'ez a levél',
  // the plain-text body in the reader
  readerControlsHidden: n => `A levél ${n} vezérlőkaraktert tartalmaz, ezek itt nem látszanak; a Forrás nézetben jelölve.`,
  readerTextCut: n => `A levél további ${n} karaktere itt nem látszik; a teljes szöveg a Forrás nézetben.`,
  // Source view
  source: {
    menuHeaders: 'Fejlécek',
    menuOriginal: 'Eredeti megjelenítése',
    menuSave: 'Mentés .eml-ként',
    title: 'A levél forrása',
    tabsLabel: 'A forrás nézetei',
    tabs: { headers: 'Fejlécek', original: 'Eredeti' },
    loading: 'A forrás betöltése…',
    save: 'Mentés .eml-ként',
    saved: 'A levél elmentve .eml-ként.',
    summaryLabel: 'Összefoglaló',
    rows: { from: 'Feladó', to: 'Címzett', cc: 'Másolat', date: 'Dátum', subject: 'Tárgy', messageId: 'Message-ID', spf: 'SPF', dkim: 'DKIM', dmarc: 'DMARC' },
    authResults: {
      pass: 'pass (megfelelt)',
      fail: 'fail (nem felelt meg)',
      softfail: 'softfail (gyanús)',
      neutral: 'neutral (semleges)',
      none: 'none (nincs aláírás vagy szabály)',
      temperror: 'temperror (átmeneti hiba)',
      permerror: 'permerror (tartós hiba)',
      policy: 'policy (szabály szerint)',
    },
    authMissing: 'nincs adat',
    authBy: by => `Az eredmény a levél Authentication-Results sorából való, amelyet „${by}” írt. A ShadowMail maga nem ellenőriz; ha a fogadó szerver nem írt ilyen sort, ezt a feladó is beleírhatta.`,
    authNone: 'A levélben nincs Authentication-Results sor, ezért SPF/DKIM/DMARC-eredmény nem látszik. A ShadowMail maga nem ellenőriz.',
    rawHeaders: 'A teljes fejrész',
    noHeaders: 'Ennek a levélnek nincs felismerhető fejrésze.',
    truncated: size => `A levél ${size}, az első 2 MB látszik. A teljes levélhez mentsd .eml-ként.`,
    headersTruncated: 'A fejrész hosszabb 2 MB-nál, csak az eleje látszik. A teljeshez mentsd .eml-ként.',
    marks: (n, rest = 0) =>
      `${n} láthatatlan karakter (vezérlő-, irányváltó, nulla szélességű stb.) jelként látszik (⟨U+…⟩)${rest ? `, további ${rest} kihagyva (a szöveg végén összesítve)` : ''}.`,
    markTitle: code => `Láthatatlan karakter: ${code}`,
    // past the 10 000th mark
    unmarked: n => `… és további ${n} láthatatlan karakter (nincs egyenként jelölve)`,
    cutByMarks: '… a jelölésekkel a szöveg hosszabb lenne 2 MB-nál, a vége nem látszik. A teljes levélhez mentsd .eml-ként.',
  },
  // Reader
  backToList: 'Vissza a listához',
  readerToolsLabel: 'Műveletek a levélen',
  readerMore: 'További',
  readerDetailsShow: 'Részletek megjelenítése',
  readerDetailsHide: 'Részletek elrejtése',
  readerToSummary: names => `címzett: ${names}`,
  readerNoRecipient: 'nincs címzett',
  readerAttachmentKind: { executable: 'futtatható', browserActive: 'weboldal-jellegű', notOpenable: 'csak menthető' },
  // Appearance
  settingDesc: {
    language: 'A felület nyelve. A váltás azonnal érvényes.',
    theme: 'Színek és sűrűség.',
    readerPane: 'Hol nyíljon meg a kijelölt levél.',
    taskbar: 'Piros karika a számmal, ha a Beérkezettekben olvasatlan levél van (Windows).',
  },
  settingsAppearance: 'Megjelenés',
  readerPaneLabel: 'Olvasópanel',
  // the unread badge on the taskbar button (Windows): the switch, its error, and the screen reader's description of the badge
  taskbarUnreadLabel: 'Olvasatlan levelek száma a tálca-ikonon',
  taskbarUnreadFailed: 'A beállítást nem sikerült menteni.',
  taskbarUnreadBadge: n => `${n} olvasatlan levél`,
  readerPaneOptions: { none: 'Nincs: a levél a lista helyén nyílik', right: 'Jobbra a lista mellett', bottom: 'Alul a lista alatt' },
  // the interface language: the label and the options are the same in every language (each language in its own words), so
  // the setting can be found by someone who does not read the current one
  languageLabel: 'Nyelv / Language',
  languageOptions: { hu: 'Magyar', en: 'English' },
  // the interface theme (themes.js): the menu's label and each theme's name
  themeLabel: 'Téma',
  themes: { default: 'Alap (világos)', dark: 'Sötét', graphite: 'Grafit', 'classic-blue': 'Klasszikus kék', 'classic-light': 'Klasszikus világos' },
  languageApplying: 'Nyelvváltás: a nyitott levélírók mentése, utána az ablak újratölt…',
  languageFailed: 'A nyelvet nem sikerült menteni; a beállítás nem változott.',
  // the header's quick switch: what is on now, and what one click gives
  readerPaneShort: { none: 'olvasópanel nélkül', right: 'olvasópanel jobbra', bottom: 'olvasópanel alul' },
  readerPaneButton: (now, next) => `Elrendezés: ${hu.readerPaneShort[now]}. Kattintásra: ${hu.readerPaneShort[next]}`,
  readerSeenFailed: code => `A levelet nem sikerült olvasottnak jelölni a szerveren: ${hu.syncError(code)}`,
  readerErrors: {
    not_found: 'Ez a levél már nincs meg (közben törölték vagy áthelyezték).',
    gone: 'Ez a levél már nincs meg a szerveren.',
    stale: 'A mappa megváltozott a szerveren. Frissítés után nyisd meg újra.',
    not_downloaded: 'A levél fájlja nincs meg a data\\store mappában.',
    store_corrupt: 'A levél fájlja sérült a data\\store mappában, ezért nem nyitható meg. A többi levél és a keresés ettől működik.',
    pop3_local: 'POP3-fióknál ez a művelet csak helyben értelmezhető.',
    locked: 'A tároló zárolva van.',
    no_account: 'A levél fiókja nem aktív.',
    sync_stopped: 'A fiók szünetel, mert a szerver elutasította a belépést. Javítsd a beállítást, vagy nyomd meg a Frissítés gombot.',
    not_open: 'A levél közben bezárult. Nyisd meg újra.',
    not_a_draft: 'Ez a levél már nincs a Piszkozatok között (közben áthelyezték vagy elküldték).',
    executable: 'Futtatható fájlt nem nyitok meg, csak menteni lehet.',
    browser_active: 'Weboldal-jellegű fájlt (HTML, SVG, XML) nem nyitok meg, csak menteni lehet.',
    not_openable: 'Ezt a fájltípust nem nyitom meg közvetlenül, csak menteni lehet.',
    open_failed: 'A mellékletet nem sikerült megnyitni (nincs hozzá program?).',
    motw_failed: 'A melléklet nem jelölhető meg biztonságosan; mentsd el, és nyisd meg onnan.',
    internal: 'Váratlan hiba történt.',
  },
  // Message actions
  actionsLabel: 'Műveletek a kijelölt leveleken',
  actions: { read: 'Olvasott', unread: 'Olvasatlan', star: 'Csillagoz', unstar: 'Csillag le', delete: 'Törlés', move: 'Áthelyezés', moveTo: 'Áthelyezés ide…', archive: 'Archiválás' },
  selectedCount: n => `${n.toLocaleString('hu-HU')} kijelölve`,
  confirmDeleteTitle: 'Végleges törlés',
  confirmDeleteTrash: n => `${n === 1 ? 'A levél' : `${n} levél`} a Kukában van: a törlés után a szerveren sem lesz meg, és nem állítható vissza.`,
  confirmDeleteNoTrash: n => `Ebben a fiókban nincs Kuka mappa, ezért ${n === 1 ? 'a levél' : `a(z) ${n} levél`} véglegesen törlődik, a szerverről is. Nem állítható vissza.`,
  confirmDeleteYes: 'Végleges törlés',
  confirmCancel: 'Mégse',
  close: 'Bezárás',
  // Claude's drafts
  claudeDraftNotice: subject => `Claude piszkozatot készített: ${subject || '(nincs tárgy)'}`,
  // "Küldés később": the main window's notice of a scheduled message (App.jsx); info: { when, lateMin, error }
  scheduledNotice: (event, subject, info = {}) => {
    const s = subject || '(nincs tárgy)'
    if (event === 'scheduled') return `Időzítve (${info.when || ''}): ${s}`
    if (event === 'sent') return info.lateMin >= 1 ? `Az időzített levél ${info.lateMin} perc késéssel kiment: ${s}` : `Az időzített levél kiment: ${s}`
    if (event === 'claudeCancelled') return `Claude visszavonta az időzítést: ${s}`
    if (event === 'late') return `Az időzített levél nem ment ki magától, mert a ShadowMail az időpontban egy napnál tovább nem futott: ${s}`
    if (event === 'interrupted') return `A küldés közben a ShadowMail leállt; a levél kimehetett, de ez nem biztos (Elküldött-másolat csak sikeres küldés után készül). Magától nem küldöm újra: ${s}`
    if (event === 'uncertain') return `Az időzített levél átadása után nem jött válasz a szervertől, vagy megszakadt a kapcsolat; a levél kimehetett, de ez nem biztos (Elküldött-másolat csak sikeres küldés után készül). Magától nem küldöm újra: ${s}`
    return `Az időzített levél nem ment ki (${hu.composeErrors[info.error] || info.error || 'ismeretlen hiba'}): ${s}`
  },
  // the "Időzített" list (Scheduled.jsx): the sidebar entry and the view of the scheduled messages
  scheduledList: {
    entry: n => `Időzített (${n})`,
    title: 'Időzített levelek',
    subtitle: 'Csak akkor mennek ki, ha a ShadowMail fut és fel van oldva.',
    empty: 'Nincs időzített levél.',
    noSubject: '(nincs tárgy)',
    noRecipients: '(nincs címzett)',
    states: {
      waiting: 'Várakozik',
      sending: 'Küldés…',
      late: 'Lekésett: a ShadowMail az időpontban egy napnál tovább nem futott',
      interrupted: 'A küldés megszakadt; lehet, hogy kiment',
      uncertain: 'Az átadás után nem jött válasz a szervertől; lehet, hogy kiment',
      held: 'Egy levélíró ablakban nyitva',
    },
    retry: (when, error) => `Újrapróbálás: ${when} (${hu.composeErrors[error] || error || 'ismeretlen hiba'})`,
    failed: error => `Nem ment ki: ${hu.composeErrors[error] || error || 'ismeretlen hiba'}`,
    open: 'Megnyitás',
    reschedule: 'Időpont módosítása',
    rescheduleOk: 'Mentés',
    sendNow: 'Küldés most',
    cancel: 'Időzítés törlése',
    actionsOf: subject => `Műveletek: ${subject}`,
    interruptedTitle: 'Küldés most?',
    interruptedText: 'A korábbi küldés nem fejeződött be rendesen: a levél kimehetett, de ez nem biztos. Az Elküldött mappában ilyenkor nincs róla másolat; ha kell, kérdezd meg a címzettet. Ha most elküldöd, kétszer is megkaphatja.',
    interruptedYes: 'Küldés most',
    interruptedNo: 'Mégse',
    // the same question on the composer's Küldés később path: the yes schedules it again
    interruptedLaterTitle: 'Újra időzíted?',
    interruptedLaterText: 'A korábbi küldés nem fejeződött be rendesen: a levél kimehetett, de ez nem biztos. Az Elküldött mappában ilyenkor nincs róla másolat; ha kell, kérdezd meg a címzettet. Ha újra időzíted, a megadott időpontban megint kimegy, és kétszer is megkaphatja.',
    interruptedLaterYes: 'Időzítés',
    cancelled: subject => `Visszakerült a Piszkozatok közé: ${subject || '(nincs tárgy)'}`,
    errors: {
      scheduled_open: 'Ez a levél egy levélíró ablakban nyitva van; ott fejezd be.',
      scheduled_sending: 'Ez a levél éppen most megy ki.',
      not_found: 'Ez az időzített levél már nincs meg.',
    },
    error: code => hu.scheduledList.errors[code] || hu.composeErrors[code] || `Nem sikerült (${code || 'ismeretlen hiba'}).`,
  },
  claudeDraftOpen: 'Megnyitás',
  claudeDraftNotYet: 'A piszkozat még nem érkezett meg a Piszkozatok mappába; próbáld újra pár másodperc múlva.',
  claudeMark: 'Claude',
  claudeMarkTitle: 'Ezt a piszkozatot Claude készítette',
  // the user's confirmation of Claude's requests (ClaudeConfirm.jsx)
  claudeConfirm: {
    header: 'Ezt a kérést Claude indította. Csak akkor hagyd jóvá, ha te is ezt akarod.',
    titles: {
      send: 'Claude levelet küldene',
      deleteMessages: 'Claude véglegesen törölne leveleket',
      deleteFolder: 'Claude törölne egy mappát',
      updateAccount: 'Claude módosítaná egy fiók beállításait',
      deleteAccount: 'Claude törölne egy fiókot',
      restartLogin: 'Claude újraindítaná egy fiók belépését',
      updateDraft: 'Claude módosítana egy piszkozatot',
      cancelScheduled: 'Claude visszavonná egy levél időzítését',
      createDraft: 'Claude piszkozatot írna, fájlok csatolásával',
    },
    unknownTitle: 'Claude kérése',
    reject: 'Elutasítás',
    approve: 'Jóváhagyás',
    lock: 'Zárolás',
    rejectAllOff: 'Mind elutasítása, Claude-hozzáférés ki',
    offFailed: 'A Claude-hozzáférést nem sikerült kikapcsolni; a kérések még várnak. Utasítsd el őket egyenként, vagy zárold a programot.',
    more: n => `Utána még ${n} kérés vár.`,
    from: 'Feladó',
    to: 'Címzett',
    cc: 'Másolat',
    bcc: 'Titkos másolat',
    subject: 'Tárgy',
    sendAt: 'Időzítve',
    sendAtNote: 'Nem most megy ki, hanem ekkor, ha a ShadowMail fut és fel van oldva.',
    recipients: 'Címzettek',
    cancelScheduledNote: 'Ezt a levelet te időzítetted. Jóváhagyás után nem megy ki: visszakerül a fiók Piszkozatai közé. Elutasításnál az időzítés marad.',
    unknownRecipients: n => n === 1 ? 'Ez a címzett nincs a névjegyzékben, ezért kell a megerősítésed:' : `Ez a ${n} címzett nincs a névjegyzékben, ezért kell a megerősítésed:`,
    noSubject: '(nincs tárgy)',
    text: 'Szöveg',
    noText: '(üres)',
    showAll: n => `A teljes szöveg megjelenítése (${n} karakter)`,
    showStart: 'Csak az eleje',
    attachments: 'Mellékletek',
    embeddedImages: 'Beágyazott képek',
    embeddedImagesValue: (n, size) => `${n} db, összesen ${size}`,
    links: 'Linkek a levélben (felirat -> valódi cél):',
    linksMore: n => `… és még ${n} link`,
    account: 'Fiók',
    folder: 'Mappa',
    listMore: n => `… és még ${n} levél`,
    folderDelete: n => `A mappa és benne ${n === 1 ? 'egy levél' : `${n} levél`} véglegesen törlődik, a szerveren is. Nem állítható vissza.`,
    accountDelete: n => `A fiók, a mappái, a letöltött levelei (${n} levél) és a mentett jelszava törlődik ebből a programból. A levelezőszerveren semmi nem törlődik.`,
    changesHead: 'A változások (régi -> új):',
    empty: '(üres)',
    on: 'be',
    off: 'ki',
    never: 'soha',
    loginChanged: 'A mentett jelszót a program a következő belépéskor az új szervernek vagy felhasználónak adja. Csak akkor hagyd jóvá, ha ismered a szervert.',
    deletesSooner: 'A rövidebb idő miatt a következő letöltéskor a szerverről régebbi levelek törlődhetnek.',
    restartsLogin: 'A fiók szinkronja most le van állítva (elutasított belépés miatt). A mentés újraindítja: egy belépési kísérlet történik. Ha a jelszó rossz, a szerver ideiglenesen letilthatja a gépet.',
    restartReason: reason => `A leállítás oka: ${hu.syncError(reason)}`,
    restartWarning: 'Ha a jelszó továbbra is rossz, a szerver ideiglenesen letilthatja a gépet. Jóváhagyás után egy belépési kísérlet történik.',
    newText: 'Az új saját szöveg (az aláírás és az idézet marad)',
    draftNotSent: 'A piszkozat nem megy el: a küldéshez külön kérés és a küldés szabálya kell.',
    originalMessage: 'Erre a levélre',
    draftText: 'A piszkozat saját szövege (alá kerül az aláírás, válasznál és továbbításnál az idézet)',
    claudeFilesHead: n => (n === 1 ? 'Claude ezt a fájlt csatolná:' : `Claude ezt a ${n} fájlt csatolná:`),
    claudeFilesNote: 'Nézd meg, honnan valók: csak akkor hagyd jóvá, ha tényleg ezeket akarod a levélbe tenni.',
    claudeFileFromMessage: (subject, name) => `Melléklet: ${subject || '(nincs tárgy)'} / ${name}`,
  },
  actionErrors: {
    server_refused: 'a szerver elutasította.',
    uidvalidity_changed: 'a mappa a szerveren közben megváltozott (újra lett létrehozva), ezért nem nyúltam hozzá; frissítés után próbáld újra.',
    mixed_selection: 'egyszerre csak egy mappa leveleivel lehet dolgozni.',
    bad_target: 'ide nem lehet áthelyezni.',
    not_found: 'a levél közben eltűnt (frissítés után próbáld újra).',
  },
  actionError: (action, code) => `${hu.actions[action] || 'A művelet'} nem sikerült, a lista visszaállt: ${hu.actionErrors[code] || hu.searchError(code)}`,
  // Reply, forward
  replyModes: { reply: 'Válasz', replyAll: 'Válasz mindenkinek', forward: 'Továbbítás', edit: 'Szerkesztés' },
  // Composer
  newMessage: 'Új levél',
  composeTitle: 'Új levél - ShadowMail',
  composeFrom: 'Feladó',
  composeTo: 'Címzett',
  composeCc: 'Másolat',
  composeBcc: 'Titkos másolat',
  composeShowCopies: 'Másolat, titkos másolat…',
  composeSubject: 'Tárgy',
  composeBody: 'A levél szövege',
  composeSuggestions: 'Címjavaslatok',
  composeFormatting: 'Formázás',
  composeFormattingHint: 'Formázás (a szövegből az eszköztárra: Alt+F10)',
  composeTools: { bold: 'Félkövér', italic: 'Dőlt', underline: 'Aláhúzott', textColor: 'Szövegszín', highlight: 'Kiemelés', ul: 'Felsorolás', ol: 'Számozott lista', link: 'Link', quote: 'Idézet', clear: 'Formázás törlése' },
  composeColors: {
    auto: 'Automatikus',
    noHighlight: 'Nincs kiemelés',
    text: { red: 'Piros', orange: 'Narancs', green: 'Zöld', blue: 'Kék', purple: 'Lila', gray: 'Szürke' },
    highlight: { yellow: 'Sárga', green: 'Zöld', blue: 'Kék', pink: 'Rózsaszín', orange: 'Narancs', gray: 'Szürke' },
  },
  composeToolLabels: { link: 'Link', quote: 'Idézet', clear: 'Tisztítás' },
  composeLinkUrl: 'Cím (https://… vagy mailto:…)',
  composeLinkOk: 'Beszúrás',
  composeSend: 'Küldés',
  composeSending: 'Küldés…',
  composeSendLater: 'Küldés később…',
  composeMayHaveGone: 'Ennek az időzített levélnek a korábbi küldése nem fejeződött be rendesen: kimehetett. Ha most elküldöd vagy újra időzíted, a címzett kétszer is megkaphatja.',
  schedule: {
    title: 'Küldés később',
    today18: 'Ma 18:00',
    tomorrow8: 'Holnap 8:00',
    monday8: 'Hétfő 8:00',
    custom: 'Egyéni időpont',
    date: 'Dátum',
    time: 'Idő',
    note: 'Csak akkor megy ki, ha a ShadowMail fut és fel van oldva.',
    ok: 'Időzítés',
    cancel: 'Mégse',
    badTime: 'Érvénytelen dátum vagy idő.',
  },
  composeSaveDraft: 'Mentés piszkozatként',
  composeSaving: 'Mentés…',
  composeAttach: 'Melléklet…',
  composeAttachments: 'Mellékletek',
  composeRemoveAttachment: name => `${name} eltávolítása`,
  composeSavedAt: d => `Piszkozat mentve: ${d.toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })}`,
  composeCloseTitle: 'Bezárod a levelet?',
  composeCloseText: 'A legutóbbi változások nincsenek mentve.',
  composeSaveAndClose: 'Mentés piszkozatként',
  composeDiscard: 'Elvetés',
  // Composer: the window frame
  composeCloseWindow: 'Ablak bezárása',
  composeDiscardTitle: 'Elveted a levelet?',
  composeDiscardText: 'A levél és a mentett piszkozata is törlődik.',
  composeAttachmentsLabel: n => `Mellékletek (${n})`,
  composeKeptAsDraft: 'A levél megmaradt a Piszkozatok között.',
  // a pasted / dropped image (the main process's codes; too_large with detail.bytes: one image over 10 MB)
  composeImageError: (code, detail) =>
    code === 'too_large'
      ? detail && detail.bytes
        ? 'A kép nagyobb 10 MB-nál, nem illeszthető be.'
        : detail && detail.maxPixels && !detail.turned
          ? `A kép túl nagy a szövegbe illesztéshez: ${Math.round((detail.width * detail.height) / 1e6)} megapixel, legfeljebb ${Math.round(detail.maxPixels / 1e6)} lehet. Kicsinyítsd le, vagy csatold mellékletként.`
          : detail && detail.maxPixels
            ? `Az elforgatott tájolású fotó túl nagy a felállításhoz: ${Math.round((detail.width * detail.height) / 1e6)} megapixel, legfeljebb ${Math.round(detail.maxPixels / 1e6)} lehet.`
            : 'A képpel együtt a mellékletek és a képek 25 MB fölé mennének (a legtöbb szerver nagyobbat nem fogad).'
      : code === 'unsupported_image'
        ? 'A kép nem illeszthető be: nem olvasható PNG vagy JPEG.'
        : code === 'not_attachable'
          ? 'Ez a képformátum nem illeszthető a szövegbe, és fájl nélkül mellékletként sem csatolható. Mentsd el fájlba, és csatold úgy.'
          : hu.composeError(code, detail, 'attach'),
  composePastePlain: 'A beillesztett rész túl összetett volt, ezért formázás nélkül került be.',
  composeImageAttached: n => (n === 1 ? 'A kép mellékletként csatolódott: ez a formátum nem illeszthető a szövegbe.' : `${n} kép mellékletként csatolódott: ez a formátum nem illeszthető a szövegbe.`),
  // the size menu of a pasted image in the text (right click or Shift+F10 on it): only the shown width changes
  composeImageMenu: {
    label: 'Kép mérete',
    small: 'Kicsi (320 px)',
    medium: 'Közepes (640 px)',
    large: 'Nagy (800 px)',
    original: 'Eredeti méret',
    remove: 'Kép eltávolítása',
    noEnlarge: 'A kép ennél kisebb, nem nagyítható.',
  },
  // a message that may be broken or harmful ("e-mail bomb")
  composeSuspectTitle: 'ShadowMail',
  // the shape check (2.): one unbroken run of text longer than `limit` characters in the starting body
  // mode: reply | replyAll | forward (the question), draft, mailto, new (only cancel: nothing to leave out)
  composeSuspectText: (mode, limit) =>
    `${mode === 'mailto' ? 'A levélhivatkozás' : 'A levél'} hibás vagy káros tartalmú lehet: egyetlen, ${limit.toLocaleString('hu-HU')} karakternél hosszabb, tördeletlen szövegrészt tartalmaz. ` +
    (mode === 'draft'
      ? 'A piszkozat ezért nem nyílik meg.'
      : mode === 'mailto' || mode === 'new'
        ? 'A szerkesztő ezért nem nyílik meg.'
        : `Megnyitod ${mode === 'forward' ? 'a továbbítást' : 'a választ'} az eredeti szöveg idézése nélkül?`),
  // the same question when one paragraph changes its writing direction too often (B: slow to lay out, not long)
  composeSuspectSlowText: mode =>
    `${mode === 'mailto' ? 'A levélhivatkozás' : 'A levél'} hibás vagy káros tartalmú lehet: egyetlen bekezdése túl sok, lassan megjeleníthető karaktert tartalmaz. ` +
    (mode === 'draft'
      ? 'A piszkozat ezért nem nyílik meg.'
      : mode === 'mailto' || mode === 'new'
        ? 'A szerkesztő ezért nem nyílik meg.'
        : `Megnyitod ${mode === 'forward' ? 'a továbbítást' : 'a választ'} az eredeti szöveg idézése nélkül?`),
  composeSuspectOmit: 'Idézet nélkül',
  composeSuspectCancel: 'Mégse',
  composeBodyOmitted: '[Az eredeti levél szövege kimaradt: hibás vagy káros tartalmú lehet.]',
  // the watchdog: the composer did not get ready in `seconds`; kind: reply | forward | draft | new | mailto
  composeStalled: (kind, sec) => {
    const seconds = Number(sec).toLocaleString('hu-HU', { maximumFractionDigits: 1 })
    return kind === 'new'
      ? `Az új levél szerkesztője ${seconds} másodperc alatt sem nyílt meg, ezért bezártam.`
      : kind === 'mailto'
        ? `A levélhivatkozásból nyitott szerkesztő ${seconds} másodperc alatt sem nyílt meg, ezért bezártam. A hivatkozás hibás vagy káros tartalmú lehet.`
        : `A levél hibás vagy káros tartalmú lehet: ${kind === 'forward' ? 'a továbbítás' : kind === 'draft' ? 'a piszkozat' : 'a válasz'} szerkesztője ${seconds} másodperc alatt sem nyílt meg, ezért bezártam. Az eredeti levél nem változott.`
  },
  // after a send the window only shows what happened
  composeSentLocked: 'Az elküldött levél már nem módosítható és nem küldhető el újra. Ha valakinek újra el kell küldeni, írj új levelet.',
  composeChangedWhileSending: 'A küldés közben beírt változások NEM mentek el a levéllel.',
  composeOldDraftLeft: 'A korábbi feladó fiókjában a piszkozat még nem törlődött; a következő mentéskor újra próbálom.',
  composeWaitSending: 'A levél küldése folyamatban van; várd meg a végét.',
  // sent, but not everything went well
  composeSentWithWarnings: (rejected, warnings) => {
    const parts = ['A levél elment.']
    if (rejected.length) parts.push(`A szerver ezeket a címzetteket NEM fogadta el, nekik nem ment ki: ${rejected.join(', ')}.`)
    const w = warnings.map(x => String(x).split(':')[0])
    if (w.includes('sent_copy_failed') || w.includes('no_sent_folder')) parts.push('Az Elküldött mappába nem került másolat.')
    if (w.includes('kept_as_draft')) parts.push('A levél a Piszkozatok között megmaradt.')
    if (w.includes('kept_older_draft')) parts.push('A Piszkozatok között csak egy korábbi mentése maradt meg, nem az elküldött szöveg.')
    if (w.includes('draft_not_removed')) parts.push('A korábbi piszkozat nem törlődött a Piszkozatok közül.')
    if (w.includes('origin_flag_failed')) parts.push('Az eredeti levélen a „megválaszolva” jelzés nem állítódott be.')
    return parts.join(' ')
  },
  composeErrors: {
    no_recipients: 'Adj meg legalább egy címzettet.',
    too_soon: 'Legalább egy perccel későbbi időpontot válassz.',
    too_far: 'Legfeljebb egy évre előre lehet időzíteni.',
    bad_time: 'Érvénytelen időpont.',
    bad_address: 'Érvénytelen cím',
    bad_link: 'A link csak https://, http:// vagy mailto: kezdetű lehet.',
    too_large: 'A mellékletek együtt legfeljebb 25 MB-osak lehetnek (a legtöbb szerver nagyobbat nem fogad).',
    not_a_file: 'Mappát nem lehet csatolni, csak fájlt.',
    file_not_found: 'A fájl nem található.',
    forbidden_path: 'A program saját adatmappájából nem lehet csatolni.',
    no_drafts_folder: 'A fióknak nincs Piszkozatok mappája.',
    no_recipient_accepted: 'A szerver egyik címzettet sem fogadta el.',
    no_session: 'A szerkesztő munkamenete lejárt; nyiss új levelet.',
    already_sent: 'a levél már elment; újraküldéshez írj új levelet.',
    auth_failed: 'az SMTP-szerver elutasította a belépést (hibás felhasználónév vagy jelszó a fiók beállításainál).',
  },
  // what: 'send' | 'save' | 'attach' | 'discard' -> the prefix says which step failed
  composeError: (code, detail, what = 'send') => {
    if (code === 'bad_address') return `${hu.composeErrors.bad_address}: ${(detail || []).join(', ')}`
    if (['no_recipients', 'bad_link', 'too_large', 'not_a_file', 'file_not_found', 'no_session', 'forbidden_path', 'too_soon', 'too_far', 'bad_time'].includes(code)) return hu.composeErrors[code]
    // server_refused (an APPEND or a delete answered NO): the message-action text, not a connection error
    const text = hu.composeErrors[code] || hu.actionErrors[code] || hu.searchError(code)
    const prefix = { send: 'A küldés nem sikerült', save: 'A piszkozat mentése nem sikerült', attach: 'A csatolás nem sikerült', discard: 'Az elvetés nem sikerült, a piszkozat megmaradhatott' }[what]
    return `${prefix}: ${text}`
  },
  // Folder management
  folderMenu: { newSub: 'Új almappa…', rename: 'Átnevezés…', move: 'Áthelyezés…', moveUp: 'Feljebb', moveDown: 'Lejjebb', delete: 'Törlés…', unsubscribe: 'Leiratkozás' },
  // the account head's menu (the manual order)
  accountMenu: { moveUp: 'Feljebb', moveDown: 'Lejjebb', sortFolders: 'Mappák betűrendbe', subscriptions: 'Mappák feliratkozása…' },
  subscriptions: {
    title: account => `Mappák feliratkozása: ${account}`,
    help: 'A bepipált mappák látszanak a bal sávban és szinkronizálódnak. A levelek a leiratkozott mappákban is a szerveren maradnak.',
    loading: 'A szerver mappái betöltődnek…',
    roleLocked: 'Ez a fiók egyik alapmappája: mindig látszik, nem lehet róla leiratkozni.',
    kept: 'a korábbi verzióból megtartva',
    close: 'Kész',
  },
  // the reader's End key where archiving is not possible
  // 0.17.0: Beállítások / Címkék (the list of the labels: name, color, order, delete)
  labelsPage: {
    subtitle: 'IMAP-fióknál a címke a szerveren tárolódik (kulcsszóként), POP3-nál ezen a gépen. A név, a szín és a sorrend ezen a gépen él; a lista minden fióké.',
    add: 'Új címke',
    name: 'Név',
    color: 'Szín',
    create: 'Létrehozás',
    cancel: 'Mégse',
    count: n => `${n} levél`,
    renameOf: name => `${name} neve`,
    colorOf: name => `${name} színe`,
    up: name => `${name} feljebb`,
    down: name => `${name} lejjebb`,
    remove: name => `${name} törlése`,
    deleteTitle: 'Címke törlése',
    deleteText: (name, n) => `A(z) ${name} címke törlése: ${n} levélről lekerül, IMAP-fióknál a szerverről is.`,
    deleteYes: 'Törlés',
    deleting: 'Törlés…',
    // a server could not take the keyword off: the label stays, the folders done stay done, Delete again takes the rest
    deleteFailed: accounts => `A címke megmaradt: ennél a fióknál nem sikerült levenni a szerverről: ${accounts}. A többi helyről már lekerült; a Törlés újra megpróbálja.`,
    empty: 'Még nincs címke. A levelekre a listából, a jobb gombos menüből vagy az olvasóból teheted fel, vagy hozz létre itt egyet.',
  },
  // 0.17.0: labels on messages (an IMAP account's on its server as keywords, POP3's in this program)
  labels: {
    button: 'Címke',
    menuItem: 'Címkék…',
    pickerTitle: 'Címkék',
    filter: 'Címke keresése',
    create: name => `Új címke: ${name}`,
    manage: 'Címkék kezelése…',
    remove: name => `${name} címke levétele`,
    group: names => `Címkék: ${names}`,
    none: 'Még nincs címke. Írj be egy nevet, és Enterrel létrehozod.',
    noMatch: 'Nincs ilyen címke.',
    errors: {
      name_taken: 'Már van ilyen nevű címke.',
      bad_name: 'A címke neve 1-64 látható karakter lehet.',
      bad_color: 'A szín nem megfelelő.',
      not_found: 'A címke közben megszűnt.',
      locked: 'A program zárolva van.',
      too_many: 'Legfeljebb 1000 címke lehet.',
    },
    error: code => ({
      name_taken: 'Már van ilyen nevű címke.',
      bad_name: 'A címke neve 1-64 látható karakter lehet.',
      not_found: 'A címke közben megszűnt.',
      locked: 'A program zárolva van.',
      too_many: 'Legfeljebb 1000 címke lehet.',
    })[code] || `A címke nem változott (hiba: ${code || 'unknown'}).`,
    // an IMAP account's label goes to its server: a folder out of reach changed nothing (the account's name), and one
    // whose server does not allow keywords keeps the label on this computer only
    serverError: (account, code) => `A címke nem változott ennél a fióknál: ${account}. Ok: ${hu.actionErrors[code] || hu.searchError(code)}`,
    localOnly: 'A szerver ebben a mappában nem enged címkét: a címke csak ezen a gépen látszik.',
  },
  readerKeys: { no_archive: 'Ebben a fiókban nincs Archívum-mappa: nincs hova archiválni.', in_archive: 'Az Archívumban lévő levél nem archiválható tovább.' },
  // after the label of a field that may stay empty (ui/Fields.jsx TextField optional)
  optionalField: '(nem kötelező)',
  folderProtected: 'Ez a fiók egyik alapmappája: nem nevezhető át és nem törölhető.',
  newFolderTitle: account => `Új mappa: ${account}`,
  newSubfolderTitle: parent => `Új almappa ebben: ${parent}`,
  renameFolderTitle: name => `Átnevezés: ${name}`,
  folderNameLabel: 'A mappa neve',
  folderCreate: 'Létrehozás',
  folderRename: 'Átnevezés',
  folderDelete: 'Mappa törlése',
  deleteFolderTitle: 'Mappa törlése',
  // atLeast: the server did not give its count, this is the local one (a lower bound; 0 = not known)
  confirmFolderDelete: (name, count, atLeast) =>
    !atLeast
      ? `A(z) „${name}” mappa törlődik${count ? `, és vele együtt a benne lévő ${count.toLocaleString('hu-HU')} levél is, a szerverről is` : ''}. Nem állítható vissza.`
      : count
        ? `A(z) „${name}” mappa törlődik, és vele együtt a benne lévő legalább ${count.toLocaleString('hu-HU')} levél is, a szerverről is. Nem állítható vissza.`
        : `A(z) „${name}” mappa törlődik, és vele együtt a szerveren benne lévő összes levél is (a számukat most nem tudom). Nem állítható vissza.`,
  folderDeleteChecking: 'A pontos levélszámot a szervertől kérdezem…',
  folderErrors: {
    bad_name: 'Érvénytelen név (üres, túl hosszú, vagy tiltott karaktert tartalmaz: % * " \\).',
    name_has_delimiter: 'A név nem tartalmazhat elválasztó karaktert (/ vagy a szerver saját elválasztóját, pl. pont). Almappát a mappa helyi menüjéből hozhatsz létre.',
    folder_exists: 'Már van ilyen nevű mappa.',
    role_folder: 'Ez a fiók egyik alapmappája: nem lehet róla leiratkozni.',
    protected_folder: 'Ez a fiók egyik alapmappája: nem nevezhető át és nem törölhető.',
    protected_subfolder: 'A mappa alatt a fiók egyik alapmappája van (pl. Archívum vagy Elküldött), ezért nem nevezhető át és nem helyezhető át. Előbb válassz másik mappát erre a szerepre a fiók beállításaiban (Mappák).',
    has_children: 'A mappának almappái vannak: előbb azokat töröld.',
    no_subfolders: 'Ez a szerver nem támogat almappákat.',
    bad_target: 'Ide nem helyezhető át: önmagába, a saját almappájába vagy a mostani helyére nem lehet.',
    trash_target: 'A Kukába és a Levélszemétbe (és alájuk) mappa nem helyezhető át.',
    confirm_needed: 'A törléshez megerősítés kell.',
    order_mismatch: 'A mappák vagy fiókok közben megváltoztak, a sorrend nem mentődött. Próbáld újra.',
  },
  folderError: code => hu.folderErrors[code] || hu.searchError(code),
  // a folder dragged into another one (or onto the account head: the account's name)
  moveFolderTitle: 'Mappa áthelyezése',
  folderMoveYes: 'Áthelyezés',
  // the folder menu's "Move…" dialog (a listbox of the account's folders); the reasons: folder-order.js moveTargetReason
  moveDialog: {
    title: name => `„${name}” áthelyezése`,
    topLevel: account => `Felső szint (${account})`,
    help: 'Válaszd ki, hova kerüljön (Fel/Le nyíl, Enter). A halvány helyekre nem helyezhető, mellettük az ok.',
    listLabel: 'Cél',
    ok: 'Tovább',
    reasons: {
      flat: 'ez a szerver nem enged almappát',
      role: 'alatta a fiók egyik alapmappája van',
      top: 'már a felső szinten van',
      missing: 'nem valódi mappa, csak a fa jelzi',
      self: 'önmaga vagy a saját almappája',
      parent: 'most is itt van',
      trash: 'a Kukába és a Levélszemétbe nem',
    },
  },
  confirmFolderMove: (name, target, subfolders) => `„${name}” áthelyezése ide: „${target}”${subfolders ? `, ${subfolders} almappával` : ''}.`,
  // Global search
  searchLabel: 'Keresés',
  searchPlaceholder: 'Keresés minden levélben (ékezet nélkül is)…',
  searchFiltersButton: 'Szűrők',
  searchFiltersLabel: 'Keresési szűrők',
  searchClear: 'Keresés törlése',
  searchAnyTime: 'Bármikor',
  searchDateRange: (since, until) => {
    const d = v => v.replaceAll('-', '. ') + '.'
    if (since && until) return `${d(since)} – ${d(until)}`
    return since ? `${d(since)} óta` : `${d(until)} előtt`
  },
  // the sender chip's value (its label "Feladó" is already in front of it)
  searchPeople: (from, to) => [from, to && `${hu.searchFilter.to.toLowerCase()}: ${to}`].filter(Boolean).join(', '),
  searchFilter: { account: 'Fiók', folder: 'Mappa', from: 'Feladó', to: 'Címzett', since: 'Dátumtól', until: 'Dátumig', hasAttachment: 'Van melléklet', unread: 'Olvasatlan', flagged: 'Csillagos', label: 'Címke', sort: 'Rendezés' },
  searchAllAccounts: 'Minden fiók',
  searchAnyLabel: 'Mind',
  searchAllFolders: 'Minden mappa',
  searchSort: { relevance: 'Relevancia', date: 'Dátum' },
  searchResultsLabel: 'Találatok',
  searchRunning: 'Keresés…',
  searchNoHits: 'Nincs találat.',
  searchCount: (n, truncated) => `${n.toLocaleString('hu-HU')} találat${truncated ? ' (az első 500 helyi találat látszik; szűkíts a keresésen)' : ''}`,
  searchHeadersOnly: n => `${n.toLocaleString('hu-HU')} levél régebbi a fiókja indexelési határánál: ezekben csak a feladó, címzett és tárgy szerint keresek, kivéve a már megnyitottakat. A szövegükben az alábbi gombokkal kereshetsz.`,
  searchOnServer: 'Keresés a szerveren is',
  searchOnServerHelp: '(a régebbi IMAP-levelek szövegében; a szerver keresése általában nem ékezet-független)',
  searchInOld: 'Keresés a régi levelek szövegében is',
  searchCancel: 'Megszakítás',
  searchFoundOnServer: 'szerveren talált',
  searchFoundInOld: 'régi levélben talált',
  searchServerProgress: p => (p && p.total ? `Keresés a szerveren: ${p.done} / ${p.total} mappa${p.folder ? ` (${p.account}: ${p.folder})` : ''}` : 'Keresés a szerveren…'),
  searchPop3Progress: p => (p && p.total ? `Keresés a régi levelekben: ${p.done.toLocaleString('hu-HU')} / ${p.total.toLocaleString('hu-HU')} levél` : 'Keresés a régi levelekben…'),
  searchServerDone: f =>
    `${f.cancelled ? 'Szerveres keresés megszakítva' : 'Szerveres keresés kész'}: ${f.hits} új találat` +
    (f.errors && f.errors.length ? `; nem sikerült: ${f.errors.map(e => `${e.account} (${hu.searchError(e.code)})`).join(', ')}` : '') +
    (f.failedFolders && f.failedFolders.length ? `; ${f.failedFolders.length} mappában a szerver elutasította a keresést` : '') +
    (f.error ? '; váratlan hiba' : ''),
  // the sync texts end in "újrapróbálom…"; a search is not retried on its own
  searchError: code => (hu.readerErrors[code] || hu.syncError(code)).replace(/[;,]?\s*újrapróbálom…$/, ''),
  searchPop3Done: f =>
    `${f.cancelled ? 'Keresés a régi levelekben megszakítva' : 'Keresés a régi levelekben kész'}: ${f.hits} új találat` +
    (f.skipped ? `; ${f.skipped} levél fájlja hiányzik vagy sérült, kihagytam` : '') +
    (f.error ? '; váratlan hiba' : ''),
  // opening is not retried on its own: no "újrapróbálom…" (searchError strips it)
  readerError: code => hu.searchError(code),
  sizeKb: bytes => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`),
  // the main process's file dialogs: the filter names
  fileFilterText: 'Szöveg',
  fileFilterContacts: 'Névjegyek (.vcf, .csv)',
  // default file names offered by the save dialogs (without accents, as before): the contact export's base
  // (<base>-<YYYY-MM-DD>.<ext>) and a message's .eml name when it has no subject
  contactsExportBase: 'ShadowMail-cimlista',
  sourceFileFallback: 'level',
  // a list row dragged out into another program as .eml files (the copies go after 10 minutes and at lock)
  dragOut: {
    tooMany: (n, max) => `Egyszerre legfeljebb ${max} levél húzható ki más programba, most ${n} van kijelölve. Mappára most is áthelyezheted.`,
    // the drag stayed inside the program (a move onto a folder works as before): why it did not go out
    notice: (kind, info = {}) =>
      kind === 'tooMany'
        ? hu.dragOut.tooMany(info.n, info.max)
        : kind === 'tooLarge'
          ? `A kijelölt levelek együtt ${((info.bytes || 0) / 1024 / 1024).toFixed(1).replace('.', ',')} MB-osak, egyszerre legfeljebb ${Math.round((info.max || 0) / 1024 / 1024)} MB húzható ki más programba. Mappára most is áthelyezheted.`
          : kind === 'noSize'
            ? 'Egy kijelölt levél mérete nem ismert, ezért most nem húzható ki más programba. Mappára most is áthelyezheted.'
            : 'A kihúzáshoz a levél még nincs letöltve; letöltöm, egy pillanat múlva húzd újra. Mappára most is áthelyezheted.',
    error: (code, res = {}) =>
      code === 'not_yet'
        ? 'A levél még nincs letöltve; letöltöm, egy pillanat múlva húzd újra.'
        : code === 'too_large'
          ? `A kijelölt levelek együtt ${((res.bytes || 0) / 1024 / 1024).toFixed(1).replace('.', ',')} MB-osak, egyszerre legfeljebb ${Math.round((res.max || 0) / 1024 / 1024)} MB húzható ki más programba.`
          : `A levél kihúzása nem sikerült: ${hu.dragOut.errors[code] || hu.searchError(code)}`,
    errors: {
      motw_failed: 'A másolat nem jelölhető meg biztonságosan; mentsd el az olvasó „Mentés .eml-ként” menüpontjával.',
      write_failed: 'A másolatot nem sikerült lemezre írni.',
      disk_full: 'Nincs elég hely a lemezen a másolathoz.',
      not_writable: 'A data\\tmp mappa nem írható.',
    },
  },
  // the name of an attachment without one, in the reader and its save dialog: <word>-<n>
  attachmentFallback: 'melleklet',
  // the word typed to confirm a full reset without the code (the label and the error above show it)
  resetConfirmWord: 'TÖRLÉS',
  // the OUTGOING reply / forward: the line above the quote and the forwarded block's header (goes to the recipient)
  outgoingQuote: {
    wrote: header => `${header} írta:`,
    forwarded: '-------- Továbbított üzenet --------',
    labels: { from: 'Feladó', date: 'Dátum', subject: 'Tárgy', to: 'Címzett', cc: 'Másolat' },
  },
}
