# OSP-P300 Simulator

Webbaserad, inofficiell simulator för Okuma OSP-P300 (svarv och fräs). Skriv eller klistra in NC-kod, beskriv verktygen i verktygslistan och spela upp programmet i 3D med materialborttagning.

Ingen byggprocess: öppna `index.html` via valfri statisk server, t.ex. `npx http-server .` (three.js och typsnitt ligger i `vendor/`).

## Funktioner
- Tolk för Okuma-koder: alla G/M-koder, funktioner och User Task-funktioner i kodlistan (se fliken *Koder* för status per kod)
- Radie-/nosradiekompensering (G41/G42), fas/rundning, fasta cykler, gängor, G71/G72, variabler, IF/GOTO, CALL/RTS
- Verktygslista som styr kompensering och skärgeometri
- Svarv: revolverad profilmodell · Fräs: höjdkartemodell
- Varningar för krock (G00 i material), skär utan spindel, för kort skärlängd, saknade verktyg
- Ett block, valfritt stopp, blockskip, matnings-/rapid-override, hastighet, sökbar tidslinje
- Exempelprogram, import/export av program och projekt

## Kända begränsningar
- Parametersyntaxen för vissa cykler (G71–G78, G88, G185–G188, G73/G74 svarv) är antagen, inte hämtad ur Okumas handbok – verifiera mot maskinen
- Gängor visas som ringar (axelsymmetrisk modell), 4:e/5:e axel visas bara i positionsdisplayen
- Fräsens höjdkarta kan inte modellera underskärningar (t.ex. G87 uppåtskär)
- G00 interpoleras linjärt (Okuma kör axlarna oberoende)
- Ej affilierad med Okuma Corporation

## Tester
`node --test tests/*.test.mjs`
