# Office-Konverter (online-document-converter)

Web-App, die alte Office-Dateien (`.doc`, `.xls`, `.ppt` …) in aktuelle Formate (`.docx`, `.xlsx`, `.pptx`) umwandelt – **vollständig im Browser**. Die Dateien werden nicht hochgeladen, nichts wird gespeichert, es gibt kein Tracking.

## Datenschutz

| | |
| --- | --- |
| **Kein Upload** | Die Umwandlung erledigt LibreOffice, kompiliert zu WebAssembly, direkt auf dem Gerät der Nutzer:innen. Es gibt kein Backend. |
| **Keine Speicherung** | Dokumente liegen nur im Arbeitsspeicher (Seite und Web Worker). Nach jeder Umwandlung werden sie aus dem virtuellen Dateisystem der Engine gelöscht; „Liste leeren“ oder Schließen der Seite entfernt auch die Ergebnisse. Keine Cookies, kein `localStorage`, kein `sessionStorage`, keine IndexedDB. |
| **Kein Tracking** | Keine Analyse-Tools, keine CDNs, keine externen Schriften oder Skripte. Die Seite lädt ausschließlich Dateien vom eigenen Origin. |
| **Technisch abgesichert** | Eine Content-Security-Policy mit `connect-src 'self'` verhindert, dass Seite oder Engine Daten an fremde Server schicken können. Makros werden beim Umwandeln nie ausgeführt. |
| **Cache nur für Programmdateien** | Der Browser speichert die Programmdateien (~78 MB), damit der Konverter beim nächsten Besuch sofort und auch offline startet. Nutzer:innen können sie in der Fußzeile löschen. |

Der End-to-End-Test prüft automatisch, dass nach mehreren Umwandlungen keine Cookies, kein Web Storage und keine IndexedDB-Daten existieren, dass keine Anfrage an einen fremden Server ging und dass die App offline funktioniert.

> **Hinweis zum Hosting:** Wie jeder Webserver sieht auch GitHub Pages beim Abruf der Seite die IP-Adresse der Besucher:innen (GitHub ist ein US-Anbieter). Dokumentinhalte erreichen den Server nie. Wer auch das vermeiden möchte, kann den Inhalt von `dist/` auf einem eigenen Server in der EU mit abgeschalteten Access-Logs betreiben – siehe [Andere Hoster](#andere-hoster).

## Unterstützte Formate

| Quelle | Ziel | Hinweise |
| --- | --- | --- |
| Word: `.doc` (Word 6 – 2003), `.dot`, `.rtf` | `.docx` | |
| Excel: `.xls` (Excel 3 – 2003), `.xlt` | `.xlsx` | |
| Lotus 1-2-3 / Works-Tabellen: `.wk1`, `.wk3`, `.wk4`, `.wks`, `.123` | `.xlsx` | |
| PowerPoint: `.ppt`, `.pps`, `.pot` | `.pptx` | |

- **Vorlagen** (`.dot`, `.xlt`, `.pot`) und Bildschirmpräsentationen (`.pps`) werden als normale Dokumente gespeichert, weil die Engine keine Vorlagen-Formate (`.dotx` …) schreiben kann.
- **Makros:** Enthält eine Datei VBA-Makros, wird gefragt, ob sie entfernt (empfohlen, Ausgabe `.docx`/`.xlsx`/`.pptx`) oder behalten werden sollen (`.docm`/`.xlsm`/`.pptm`, mit Hinweis, dass das nicht immer 100 % korrekt funktioniert). Bei Word und PowerPoint bleiben die Makros erhalten. Bei Excel kann die Engine sie derzeit nicht übernehmen: Das wird nach der Umwandlung erkannt und offen angezeigt, und die Datei wird ehrlich als makrofreie `.xlsx` ausgeliefert statt als `.xlsm` ohne Makros.
- **Nicht unterstützt**, weil der verwendete WebAssembly-Build die Filter nicht enthält: Works-Textdokumente (`.wps`), WordPerfect (`.wpd`), Windows Write (`.wri`). Passwortgeschützte Dateien werden mit einer verständlichen Fehlermeldung abgelehnt.
- Maximale Dateigröße: 100 MB.

## So funktioniert es

```
Browser
├─ index.html + assets/app.js   Oberfläche (DE/EN), Makro-Erkennung (assets/cfb.js), ZIP-Export
├─ sw.js (Service Worker)       setzt COOP/COEP/CSP-Header, entpackt & cached die Engine
└─ engine/convert-worker.js     Web Worker: LibreOffice (WebAssembly) wandelt um
```

- **Engine:** [`@matbee/libreoffice-converter`](https://www.npmjs.com/package/@matbee/libreoffice-converter) liefert einen WebAssembly-Build von LibreOffice. Verwendet werden nur dessen Engine-Dateien; die Anbindung (`src/engine/convert-worker.js`) spricht die LibreOfficeKit-API direkt an, damit auch `.docm`/`.pptm` geschrieben werden können.
- **Header ohne Server-Konfiguration:** Die Engine nutzt Threads und braucht `SharedArrayBuffer`. Browser erlauben das nur auf „cross-origin isolated“ Seiten (`Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy`). GitHub Pages kann keine eigenen Header setzen, deshalb ergänzt der Service Worker sie. Beim allerersten Besuch lädt die Seite dafür einmal kurz neu.
- **Große Dateien:** `soffice.wasm` (147 MB) und `soffice.data` (100 MB) werden beim Build mit gzip komprimiert (zusammen ~78 MB) und in Teile von höchstens 20 MiB zerlegt. Damit läuft die Seite auf praktisch jedem statischen Hoster. Der Service Worker setzt die Teile im Browser wieder zusammen, entpackt sie mit `DecompressionStream` und zeigt den Fortschritt an.
- **Makro-Erkennung:** `src/assets/cfb.js` liest das Compound-File-Format von `.doc`/`.xls`/`.ppt` direkt im Browser und erkennt VBA-Projekte, ohne die Engine zu laden.

## Veröffentlichen auf GitHub Pages

1. Im Repository unter **Settings → Pages → Build and deployment → Source** die Option **GitHub Actions** wählen (einmalig).
2. Auf `main` pushen. Der Workflow [`.github/workflows/pages.yml`](.github/workflows/pages.yml) installiert die Abhängigkeiten, führt die Unit-Tests aus, baut die Seite und veröffentlicht `dist/`.
3. Die App ist danach unter `https://<benutzer>.github.io/online-document-converter/` erreichbar.

GitHub Pages hat ein weiches Traffic-Limit von 100 GB pro Monat. Da jede:r neue Besucher:in einmalig ~78 MB lädt, reicht das für grob 1.200 Erstbesuche pro Monat; wiederkehrende Besuche kommen aus dem Browser-Cache.

### Andere Hoster

`dist/` ist eine rein statische Website und kann auf jedem Webserver liegen (nginx, Caddy, Apache, Cloudflare Pages, Netlify …). Es ist keine Server-Konfiguration nötig. Wer die Header trotzdem direkt vom Server senden möchte (dann entfällt der einmalige Reload), setzt:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Für maximale Datensparsamkeit beim Selbst-Hosting die Access-Logs abschalten (nginx: `access_log off;`, Caddy: kein `log`-Block).

## Entwicklung

Voraussetzung: Node.js ≥ 20.

```bash
npm ci              # Abhängigkeiten (inkl. LibreOffice-Engine, ~250 MB)
npm run build       # baut die Seite nach dist/
npm run serve       # http://localhost:8080 (wie GitHub Pages: ohne besondere Header)
npm test            # Unit-Tests (Makro-Erkennung, ZIP)
```

Mit `?debug` in der URL gibt der Konverter Engine-Meldungen in der Browser-Konsole aus.

End-to-End-Test in Chromium (baut auf `dist/` auf, also vorher `npm run build`):

```bash
npx playwright-core install chromium   # einmalig, falls kein Chromium vorhanden ist
npm run test:e2e
# oder mit einem vorhandenen Chromium:
CHROMIUM_PATH=/pfad/zu/chrome npm run test:e2e
```

## Bekannte Einschränkungen

- Der erste Start lädt ~78 MB. Die Engine reserviert beim Start 1 GB Arbeitsspeicher; auf älteren Smartphones kann das scheitern.
- Getestet ist die App automatisiert in Chromium. Firefox sollte funktionieren. In Safari ist offen, ob die vom Service Worker gesetzten Isolation-Header greifen; dann erscheint ein verständlicher Hinweis. In privaten Fenstern mancher Browser sind Service Worker deaktiviert.
- Die Konvertierungsqualität entspricht der von LibreOffice. Komplexe Layouts können leicht abweichen.

## Lizenz

GPL-3.0, siehe [LICENSE](LICENSE). Die LibreOffice-Engine steht unter der MPL-2.0; Details in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
