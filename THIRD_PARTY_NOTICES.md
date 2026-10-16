# Drittanbieter-Komponenten

Der Konverter selbst steht unter der [GNU GPL v3](LICENSE). Beim Build werden folgende Komponenten unverändert in die Website übernommen:

## LibreOffice (WebAssembly-Build)

- Dateien: `engine/soffice.js`, `engine/soffice.worker.js`, `engine/soffice.wasm`, `engine/soffice.data` (auf dem Server komprimiert und in Teile zerlegt)
- Quelle: npm-Paket [`@matbee/libreoffice-converter`](https://www.npmjs.com/package/@matbee/libreoffice-converter) (Version siehe `package.json`), Quellcode und Build-Skripte unter <https://github.com/matbeedotcom/libreoffice-document-converter>
- Lizenz: [Mozilla Public License 2.0](https://www.mozilla.org/MPL/2.0/)
- LibreOffice enthält weitere Open-Source-Bibliotheken mit eigenen Lizenzen. Übersicht: <https://www.libreoffice.org/about-us/licenses/>, Quellcode von LibreOffice: <https://www.libreoffice.org/about-us/source-code/>

## Testdateien

Die Dateien in `tests/fixtures/` stammen größtenteils aus den Testdaten von [Apache POI](https://poi.apache.org/) (Apache License 2.0). Details: [tests/fixtures/README.md](tests/fixtures/README.md). Sie sind nicht Teil der ausgelieferten Website.
