// Local, rule-based help assistant. It answers from the code reference, the
// current program and the diagnostics - no network and no AI model.

import { CODES, STATUS_LABEL } from '../data/codes.js';

const ADDR = {
  X: 'X-position', Y: 'Y-position', Z: 'Z-position', U: 'inkrementell X (svarv)', W: 'inkrementell Z (svarv)',
  A: 'rotationsaxel A', B: 'rotationsaxel B', C: 'rotationsaxel C / fasstorlek',
  I: 'bågcentrum i X (inkrementellt)', J: 'bågcentrum i Y (inkrementellt)', K: 'bågcentrum i Z (inkrementellt)',
  R: 'radie (båge, R-plan eller rundning)', F: 'matning', S: 'varvtal / skärhastighet', T: 'verktyg',
  H: 'korrektions-/nollpunktsnummer', D: 'verktygsnummer för kompensering / djup', P: 'parameter (väntetid, profilstart)',
  Q: 'parameter (pickdjup, profilslut, upprepningar)', L: 'upprepning', E: 'gängstigning', MT: 'förvälj verktyg', TG: 'välj och ladda verktyg',
  TL: 'verktygsinställning', SB: 'spindelvarvtal',
};

const FAQ = [
  [/gäng/, 'Gängning: använd G33 (ett skär) eller G88 (flera skär) med F = stigning. Spindeln måste gå (M03). Gängan visas som en spiral i svarvvyn när den skurits. Kontrollera att gängskäret (typ "Gängskär") finns i verktygslistan.'],
  [/utstick|chuck|backe|käft/, 'Utstick ställer du in under fliken Ämne: "Utstick från backen" (svarv) respektive "Utstick över käftar" (fräs). Det styr bara hur långt ämnet sticker ut ur chucken/skruvstycket – chucken flyttas dit.'],
  [/kompens|g41|g42|nosradie/, 'G41/G42 förskjuter banan med verktygsradien (fräs) eller nosradien (svarv). Avbryt med G40. Radien hämtas från verktygslistan (D = verktygsnummer, annars aktivt verktyg). Börja och sluta kompenseringen på en rörelse utanför konturen.'],
  [/cykel|g8[1-9]|g7[1-6]/, 'Fasta cykler: i fräs anger du X Y Z R (+ Q för pickning, P för väntetid) och F. G98 återvänder till startplan, G99 till R-planet. G80 avslutar. Skriv t.ex. "G83" så förklarar jag den cykeln.'],
  [/nollpunkt|g15|work offset|g54/, 'G15 H2 väljer nollpunkt nr 2. Värdena för H1, H2 … anger du i fliken Ämne under Nollpunkter. Obs: G54–G58 på Okuma är längdkompensering, inte nollpunkter.'],
  [/varv|g96|skärhast/, 'S är varv/min (G97) eller skärhastighet i m/min (G96, bara svarv). Max varv sätts med G50 S… eller i fliken Ämne.'],
  [/matning|\bf\b|g94|g95/, 'F är matning. G94 = mm/min, G95 = mm/varv (kräver att spindeln går). Utan F på en matningsrörelse stoppar simuleringen med larm.'],
  [/variabel|vc\d|user task|if |goto/, 'Variabler: VC1… (gemensamma) och V1… (lokala). Använd t.ex. VC1=VC1+1, X=VC1*10 och IF VC1 LT 5 N10 / GOTO N10. Hoppmålet är ett sekvensnummer (N10) i samma program.'],
  [/underprogram|call|rts/, 'CALL O1000 Q3 anropar program O1000 tre gånger. Bokstavsargument (A, B, …) blir V1, V2 … i underprogrammet. Avsluta med RTS.'],
  [/hoppa|steg|bakåt|block/, 'Med pilknapparna i körfältet (eller ←/→ på tangentbordet) stegar du ett block framåt eller bakåt; materialet återskapas exakt. Reglaget hoppar fritt i tid.'],
  [/blocknummer|\bn\d|sekvensnummer/, 'Allt som börjar på N (N10, NT1 …) är blocknummer/etikett. Det gör ingenting i körningen och används bara för att hitta i koden och som hoppmål för GOTO/IF.'],
  [/verktygslista|verktygsfliken|beskriv.*verktyg/, 'Varje T-nummer i programmet ska finnas i fliken Verktyg. Typ, diameter/nosradie och spetsläge styr både kompensering och hur materialet tas bort.'],
  [/krock|kollision|snabbtransport/, 'Varningen "Snabbtransport i material" betyder att en G00-rörelse går genom ämnet. Lägg Z-rörelsen över ämnets överkant först, eller använd G01 med matning.'],
];

export function explainMessage(text) {
  let m;
  if ((m = /Verktyg T(\d+) finns inte/.exec(text))) return `Programmet anropar T${m[1]}, men det finns ingen post för T${m[1]} i fliken Verktyg. Lägg till ett verktyg med nummer ${m[1]} (eller ändra T-numret i koden). Tills dess används ett standardverktyg.`;
  if (/Snabbtransport.*material/.test(text)) return 'En G00-rörelse går genom ämnet. Kör Z-rörelsen först till ett säkert läge över ämnet, eller använd G01 med matning vid inträde i materialet.';
  if (/utan att spindeln/.test(text)) return 'Verktyget skär i materialet men spindeln står still. Lägg till M03 (medurs) eller M04 med ett varvtal (S…) före skärrörelsen.';
  if (/skärlängden/.test(text)) return 'Verktygets skärlängd är kortare än skärdjupet, så skaftet/hållaren går in i materialet. Öka "Skärlängd" i verktygslistan om verktyget verkligen är längre, annars skär grundare.';
  if (/Ingen matning/.test(text)) return 'En matningsrörelse (G01/G02/G03) saknar F-värde. Skriv F… i blocket eller ett block före.';
  if (/Matning per varv|kräver att spindeln/.test(text)) return 'G95 (mm/varv) beräknar matningen ur varvtalet. Starta spindeln (M03/M04 med S…) före matningsrörelsen eller byt till G94.';
  if ((m = /G(\d+) stöds inte av simulatorn/.exec(text)) || (m = /M(\d+) stöds inte av simulatorn/.exec(text))) return `Koden ${text.split(' ')[0]} finns inte i den lista över Okuma-koder som simulatorn stöder. Din maskin kan ha egna koder; kontrollera stavningen (G${m[1]}?) eller ta bort raden för att simulera resten.`;
  if (/är en (svarv|fräs)kod/.test(text)) return 'Koden gäller bara den andra maskintypen. Byt Svarv/Fräs i toppen eller ta bort koden.';
  if (/Okänd adress/.test(text)) return 'Bokstaven är ingen känd adress (X Y Z I J K R F S T H D P Q …). Skriv blocknummer som N10 – text efter N (t.ex. NT1) tolkas som etikett och ignoreras.';
  if (/Värde saknas|Oväntat tecken|Förväntade/.test(text)) return 'Syntaxfel i blocket: en adress saknar siffra/uttryck, eller ett tecken är fel. Uttryck skrivs X=VC1+5 eller X[VC1+5]; funktioner som SQRT[16].';
  if (/Sekvensnummer N\d+ hittades inte/.test(text)) return 'GOTO/IF hoppar till ett sekvensnummer som inte finns i samma program. Lägg till N-numret på mål-raden.';
  if (/loopa|för många/.test(text)) return 'Programmet körde alldeles för många block – troligen en oändlig loop (IF/GOTO som aldrig blir falsk). Kontrollera loopvillkoret.';
  if (/matchar inte verktyg|H\d+ används med verktyg/.test(text)) return 'Längdkompenseringens H-nummer skiljer sig från aktivt verktyg. Normalt är H lika med T-numret (G56 H02 för T02).';
  if (/båge|Båge/.test(text)) return 'Bågen är geometriskt omöjlig: start och slut ligger längre isär än 2×R, eller radien/centrum stämmer inte. Kontrollera R eller I/J/K (de är inkrementella från startpunkten).';
  if (/Kompenseringsradien|kompensering/.test(text)) return 'Verktygsradien är för stor för konturen (t.ex. en innerrunding mindre än verktygsradien). Använd mindre verktyg eller större radie.';
  if (/Gängskärning utan spindel/.test(text)) return 'Gängskärning kräver att spindeln går: M03 + S… före G33/G88.';
  if (/Underprogram/.test(text)) return 'CALL pekar på ett program som inte finns. Skriv en rad O<nummer> (t.ex. O1000) före underprogrammet och avsluta det med RTS.';
  if (/G87/.test(text)) return 'Bakåtborrning visas bara som rörelse; uppåtgående skär kan inte tas bort i fräsens höjdkartemodell.';
  return 'Ingen särskild förklaring finns, men raden är markerad i editorn. Fråga gärna "förklara rad N".';
}

function describeWord(w, ctx) {
  const lit = typeof w.v === 'number' ? String(w.v) : 'uttryck';
  if (w.a === 'G' || w.a === 'M') {
    const code = `${w.a}${typeof w.v === 'number' ? w.v : ''}`;
    const c = CODES.find((x) => x.code === code);
    return `${code}: ${c ? c.sv : 'okänd kod'}`;
  }
  if (w.a === 'N') return `N${lit}: blocknummer (bara för att hitta i koden)`;
  if (w.a === 'T') return `T${lit}: ${ADDR.T}${ctx.tools[Math.round(w.v)] ? ' – ' + ctx.tools[Math.round(w.v)].name : ' (finns ej i listan)'}`;
  if (w.a === 'F') return `F${lit}: matning`;
  if (w.a === 'S') return `S${lit}: varvtal/skärhastighet`;
  return `${w.a}${lit}: ${ADDR[w.a] || 'okänd adress'}`;
}

export function describeBlock(ln, ctx) {
  const b = ctx.blocks[ln];
  if (!b) return `Rad ${ln + 1} finns inte (programmet har ${ctx.blocks.length} rader).`;
  const out = [`Rad ${ln + 1}: ${b.raw.trim() || '(tom)'}`];
  if (b.header) out.push(`Programhuvud O${b.header}.`);
  if (b.comment && !b.code) out.push('Bara en kommentar – utförs inte.');
  b.assigns.forEach(() => out.push('Variabeltilldelning (VC/V).'));
  if (b.stmt) out.push({ call: `CALL ${b.stmt.name}: anropar underprogram.`, rts: 'RTS: återvänder från underprogram.', goto: `GOTO N${b.stmt.label}: hoppar.`, if: `IF …: hoppar till N${b.stmt.label} om villkoret stämmer.` }[b.stmt.type]);
  b.words.forEach((w) => out.push('• ' + describeWord(w, ctx)));
  if (b.err) out.push(`Fel: ${b.err}`);
  ctx.msgs.filter((m) => m.ln === ln).forEach((m) => out.push(`${m.type === 'error' ? 'Larm' : 'Varning'}: ${m.text}\n→ ${explainMessage(m.text)}`));
  return out.join('\n');
}

function describeCode(c) {
  const mode = c.mode === 'both' ? 'svarv och fräs' : c.mode === 'lathe' ? 'bara svarv' : 'bara fräs';
  return `${c.code} – ${c.sv}\nGäller: ${mode}. Status i simulatorn: ${STATUS_LABEL[c.status]}.${c.note ? '\n' + c.note : ''}`;
}

export function answer(q, ctx) {
  const t = q.toLowerCase().trim();
  if (!t) return '';
  const parts = [];
  // explicit code mentions
  const seen = new Set();
  for (const m of t.matchAll(/\b([gm])\s?0*(\d{1,3})\b/g)) {
    const code = `${m[1].toUpperCase()}${parseInt(m[2], 10)}`;
    if (seen.has(code)) continue;
    seen.add(code);
    const c = CODES.find((x) => x.code === code);
    parts.push(c ? describeCode(c) : `${code} finns inte i listan över koder som simulatorn stöder. Kolla stavningen eller fliken Koder.`);
  }
  for (const f of ['call', 'rts', 'goto', 'if', 'sqrt', 'mod', 'vtofd']) {
    if (new RegExp(`\\b${f}\\b`).test(t)) {
      const c = CODES.find((x) => x.code.toLowerCase().startsWith(f));
      if (c && !parts.length) parts.push(describeCode(c));
    }
  }
  // line mention
  const lm = /(?:rad|radnummer|line)\s*(\d+)/.exec(t) || /förklara\s+(?:block\s*)?(\d+)/.exec(t);
  if (lm) parts.push(describeBlock(parseInt(lm[1], 10) - 1, ctx));
  // diagnostics
  if (/larm|varning|fel|funkar inte|fungerar inte|varför|problem|stoppar|buggar?/.test(t) && !lm) {
    const important = ctx.msgs.filter((m) => m.type !== 'info');
    if (!important.length) parts.push('Just nu finns inga larm eller varningar för programmet. Om något ändå ser fel ut: berätta vad du förväntade dig, eller fråga om en viss rad ("förklara rad 12") eller kod ("G83").');
    else {
      parts.push(`Det finns ${important.length} meddelande${important.length > 1 ? 'n' : ''}:`);
      important.slice(0, 6).forEach((m) => parts.push(`• Rad ${m.ln + 1} (${m.type === 'error' ? 'larm' : 'varning'}): ${m.text}\n   → ${explainMessage(m.text)}`));
      if (important.length > 6) parts.push(`…och ${important.length - 6} till i fliken Meddelanden.`);
    }
  }
  if (/vad gör|sammanfatta|programmet|översikt/.test(t) && !parts.length) {
    const s = ctx.stats;
    const tl = (s?.tools || []).map((x) => `T${x.n}${ctx.tools[x.n] ? ' ' + ctx.tools[x.n].name : ' (saknas)'}`).join(', ');
    parts.push(`Programmet har ${s?.blocks ?? 0} block och tar ca ${Math.round(ctx.duration || 0)} s maskintid. Verktyg: ${tl || 'inga'}. Skärväg ${((s?.feedLen || 0) / 1000).toFixed(2)} m, snabbväg ${((s?.rapidLen || 0) / 1000).toFixed(2)} m.`);
  }
  if (!parts.length) {
    const hit = FAQ.find(([re]) => re.test(t));
    if (hit) parts.push(hit[1]);
  }
  if (!parts.length && /hej|hjälp|vad kan du|hallå/.test(t)) {
    parts.push('Jag är en enkel regelbaserad hjälpare (ingen AI-modell). Jag kan: förklara en kod ("G83"), ett block ("förklara rad 12"), dina larm och varningar ("varför larmar det?") och vanliga saker som gängning, kompensering, utstick och variabler.');
  }
  if (!parts.length) parts.push('Det förstod jag inte riktigt. Prova: "varför larmar det?", "förklara rad 5", "G83", "hur gängar jag?" eller "vad gör programmet?". Jag är regelbaserad och känner bara till kodlistan och dina meddelanden.');
  return parts.join('\n\n');
}

export const SUGGESTIONS = ['Varför larmar det?', 'Vad gör programmet?', 'Hur gängar jag?', 'Vad är N-nummer?', 'Förklara G83'];
