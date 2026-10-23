// Reprise du suivi prénatal à l'ouverture d'un dossier d'accouchement : champs pré-remplis de
// l'admission et de l'examen d'entrée, et synthèse des données importantes (points d'attention).
// Seules les données durables sont recopiées ; les mesures de la dernière CPN (poids, TA, HU…)
// sont montrées en rappel, datées, et jamais copiées comme des mesures du jour.
const Consultation = require('../models/Consultation');
const Echographie = require('../models/Echographie');
const acc = require('../config/accouchement');
const cpn = require('../config/cpn');
const { jourKinshasa } = require('../config/vaccination');

const vide = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
const jj = (date) => jourKinshasa(date).split('-').reverse().join('/');

/** Première valeur renseignée (consultations de la plus récente à la plus ancienne), datée. */
function derniere(consultations, lire) {
  for (const c of consultations) {
    const v = lire(c);
    if (!vide(v)) return { valeur: v, le: c.date };
  }
  return null;
}

/** Résultat VIH saisi en texte libre (« négatif », « Positif »…) → valeur du référentiel. */
function resultatVih(texte) {
  const t = String(texte || '').trim().toLowerCase();
  if (/^n[eé]g/.test(t)) return 'Négatif';
  if (/^pos/.test(t)) return 'Positif';
  if (/^ind/.test(t)) return 'Indéterminé';
  return '';
}

/** Consultations finalisées et dernière échographie de la grossesse. */
async function charger(g) {
  if (!g || g.isNew) return { consultations: [], echographie: null };
  const [consultations, echographie] = await Promise.all([
    Consultation.find({ grossesseId: g._id, statut: 'Finalisée' }).sort({ date: -1 }),
    Echographie.findOne({ grossesseId: g._id }).sort({ date: -1, createdAt: -1 }),
  ]);
  return { consultations, echographie };
}

/** Statut VIH et traitement ARV d'après la fiche CPN (PTME) et les antécédents. */
function vihDe(p, consultations) {
  const mesure = (code) => (c) => c.mesuresPreventives?.[code];
  const test = derniere(consultations, (c) => resultatVih(mesure('resultatTest')(c)?.valeur));
  const connuPositif = (p.antecedents?.atcdMedicaux ?? []).includes('VIH/SIDA');
  const tar = [...consultations].reverse().find((c) => mesure('tar')(c)?.reponse === true);
  return {
    vih: {
      conseillee: consultations.some((c) => mesure('dcip')(c)?.reponse === true) || null,
      testee: test || p.antecedents?.testVihConnuLe || connuPositif ? true : null,
      informee: consultations.some((c) => mesure('resultatTest')(c)?.reponse === true) || null,
      resultat: connuPositif ? 'Positif' : test?.valeur ?? '',
    },
    arv: tar ? { regime: 'TAR (suivi prénatal)', depuisLe: jourKinshasa(tar.date) } : null,
  };
}

/** Admission : identité, groupe sanguin, gestité/parité, datation, VIH et antécédents. */
function admission(p, g, { consultations }) {
  const a = p.adresse ?? {};
  const atcd = p.antecedents ?? {};
  const { vih, arv } = vihDe(p, consultations);
  const nbCesariennes = Math.min(atcd.cesariennes ?? ((atcd.atcdGynecoChirurgicaux ?? []).includes('Césarienne') ? 1 : 0), 10);
  const medico = [
    ...(atcd.atcdMedicaux ?? []), ...(atcd.atcdGynecoChirurgicaux ?? []), atcd.medicaux, atcd.chirurgicaux,
    atcd.allergies && `Allergies : ${atcd.allergies}`, atcd.medicaments && `Traitements en cours : ${atcd.medicaments}`,
  ].filter(Boolean);
  const autres = [
    atcd.atcdObstetricaux?.length && `ATCD obstétricaux : ${atcd.atcdObstetricaux.join(', ')}`,
    atcd.complicationsObstetricales && `Complications : ${atcd.complicationsObstetricales}`,
    atcd.plusGrosPoidsNaissanceG && `Plus gros poids de naissance : ${atcd.plusGrosPoidsNaissanceG} g`,
    atcd.dernierAccouchement && `Dernier accouchement : ${atcd.dernierAccouchement.split('-').reverse().join('/')}`,
  ].filter(Boolean);
  return {
    nom: p.nom, postnom: p.postnom, prenom: p.prenom, age: p.age(), occupation: p.occupation,
    etatMatrimonial: p.etatCivil, nomPartenaire: p.nomPartenaire,
    adresse: [a.avenue, a.quartier, a.commune, a.province].filter(Boolean).join(', '),
    personneAPrevenir: { nom: p.contactUrgence?.nom ?? '', telephone: p.contactUrgence?.telephone ?? '' },
    groupeSanguin: p.groupeSanguin, rhesus: p.rhesus,
    statutHb: acc.STATUTS_HB.includes(p.electrophoreseHb) ? p.electrophoreseHb : '',
    gestite: atcd.gestite ?? null, parite: atcd.parite ?? null, avortements: atcd.avortements ?? null, enfantsVivants: atcd.enfantsVivants ?? null,
    ddr: g?.datation?.ddr ?? null, dpa: g?.datation?.dpa ?? null,
    vih,
    ...(arv ? { arv } : {}),
    antecedents: {
      medicoChirurgicaux: medico.join(' — '),
      gynecoObstetricaux: {
        vivants: atcd.enfantsVivants ?? null,
        cesariennes: Array.from({ length: nbCesariennes }, () => ({ annee: null, indication: '' })),
        autres: autres.join(' · '),
      },
    },
  };
}

/** Examen d'entrée : taille, et résultats de laboratoire déjà connus (datés de la CPN). */
function examen(p, { consultations }) {
  const rh = { Positif: '+', Négatif: '−' }[p.rhesus] ?? '';
  const labo = {};
  if (p.groupeSanguin) labo.gs = `${p.groupeSanguin}${rh}`;
  for (const code of ['hb', 'ge', 'tdrPalu']) {
    const r = derniere(consultations, (c) => c.laboratoire?.[code]);
    if (r) labo[code] = `${r.valeur} (CPN du ${jj(r.le)})`;
  }
  if (!labo.gs) {
    const r = derniere(consultations, (c) => c.laboratoire?.gs);
    if (r) labo.gs = `${r.valeur} (CPN du ${jj(r.le)})`;
  }
  const rpr = derniere(consultations, (c) => c.mesuresPreventives?.rpr?.reponse);
  if (rpr) labo.rprSyphilis = `${rpr.valeur ? 'Positif' : 'Négatif'} (CPN du ${jj(rpr.le)})`;
  return { physique: { tailleCm: p.tailleCm ?? null }, laboratoire: labo };
}

/** Synthèse affichée en tête du dossier : grossesse, dernière CPN, échographie, points d'attention. */
function rappel(p, g, { consultations, echographie }, le) {
  const atcd = p.antecedents ?? {};
  const ag = g?.agJoursLe?.(le) ?? null;
  const c = consultations[0];
  const signesLibelles = new Map(cpn.SIGNES_CPN.map((s) => [s.code, s.libelle]));
  const mesuresLibelles = new Map(cpn.MESURES_PREVENTIVES.map((m) => [m.code, m.libelle]));
  const faites = [...new Set(consultations.flatMap((x) => Object.entries(x.mesuresPreventives?.toObject?.() ?? x.mesuresPreventives ?? {})
    .filter(([code, m]) => m?.reponse === true && code !== 'rpr' && code !== 'toux').map(([code]) => code)))];
  const foetus = echographie?.foetus?.[0];
  const presentation = (foetus?.presentation && { valeur: foetus.presentation, le: echographie.date, source: 'Échographie' })
    || (c?.examenCpn?.presentation && { valeur: c.examenCpn.presentation, le: c.date, source: 'CPN' }) || null;
  const hb = derniere(consultations, (x) => x.laboratoire?.hb);
  const { vih } = vihDe(p, consultations);

  // Points d'attention : ce que l'équipe de garde doit voir avant tout geste.
  const points = [];
  const point = (niveau, texte) => points.push({ niveau, texte });
  if (atcd.allergies) point('Critique', `Allergies : ${atcd.allergies}`);
  if (vih.resultat === 'Positif') point('Critique', 'VIH positif : protocole PTME (mère et nouveau-né)');
  const cesariennes = atcd.cesariennes || ((atcd.atcdGynecoChirurgicaux ?? []).some((x) => x === 'Césarienne' || x === 'Utérus cicatriciel') ? 1 : 0);
  if (cesariennes) point('Critique', `Utérus cicatriciel (${cesariennes} césarienne(s) antérieure(s))`);
  if (p.rhesus === 'Négatif') point('Avertissement', 'Rhésus négatif : prévoir le groupage du nouveau-né et l’anti-D');
  if (p.electrophoreseHb === 'SS' || (atcd.atcdMedicaux ?? []).includes('Drépanocytose (SCA/SS)')) point('Critique', 'Drépanocytose (SS)');
  for (const [libelle, texte] of [['Hypertension artérielle (HTA)', 'HTA connue'], ['Diabète (DBT)', 'Diabète'], ['Cardiopathie (CAR)', 'Cardiopathie'], ['Tuberculose (TBC)', 'Tuberculose']]) {
    if ((atcd.atcdMedicaux ?? []).includes(libelle)) point('Avertissement', texte);
  }
  if (g?.grossesseMultiple || (echographie?.nombreFoetus ?? 1) > 1) point('Critique', `Grossesse multiple${echographie?.nombreFoetus > 1 ? ` (${echographie.nombreFoetus} fœtus)` : ''}`);
  if (presentation && !['Céphalique', 'Sommet'].includes(presentation.valeur)) point('Critique', `Présentation ${presentation.valeur.toLowerCase()} (${presentation.source} du ${jj(presentation.le)})`);
  if (ag != null && ag < 37 * 7) point('Critique', `Prématurité : ${Math.floor(ag / 7)} SA ${ag % 7} j`);
  if (ag != null && ag >= 41 * 7) point('Avertissement', `Terme dépassé : ${Math.floor(ag / 7)} SA ${ag % 7} j`);
  const hbValeur = hb ? parseFloat(String(hb.valeur).replace(',', '.')) : NaN;
  if (hbValeur < 10) point(hbValeur < 7 ? 'Critique' : 'Avertissement', `Anémie : Hb ${hb.valeur} g/dl (CPN du ${jj(hb.le)})`);
  const rpr = derniere(consultations, (x) => x.mesuresPreventives?.rpr?.reponse);
  if (rpr?.valeur === true) point('Avertissement', `RPR positif (CPN du ${jj(rpr.le)})`);
  if (echographie?.liquideAmniotique?.quantite && echographie.liquideAmniotique.quantite !== 'Normale') point('Avertissement', `${echographie.liquideAmniotique.quantite} (échographie)`);
  if (/pr[ée]via/i.test(echographie?.placenta?.localisation ?? '')) point('Critique', `Placenta ${echographie.placenta.localisation}`);
  for (const f of g?.facteursRisque ?? []) point('Avertissement', f);
  if (!consultations.length) point('Avertissement', 'Aucune CPN enregistrée dans la plateforme');

  return {
    grossesse: g && !g.isNew ? {
      numero: g.numero, multiple: g.grossesseMultiple, facteursRisque: g.facteursRisque,
      datation: g.datation ? { methode: g.datation.methode, ddr: g.datation.ddr, dpa: g.datation.dpa } : null,
      ag: ag == null ? null : { semaines: Math.floor(ag / 7), jours: ag % 7 },
    } : null,
    nombreCpn: consultations.length,
    derniereCpn: c ? {
      date: c.date, agJours: c.agJours,
      poidsKg: c.constantes?.poidsKg ?? null, taSystolique: c.constantes?.taSystolique ?? null, taDiastolique: c.constantes?.taDiastolique ?? null,
      hauteurUterineCm: c.constantes?.hauteurUterineCm ?? null, bcf: c.constantes?.bcf ?? null,
      presentation: c.examenCpn?.presentation ?? '',
      signes: Object.entries(c.examenCpn?.signes?.toObject?.() ?? c.examenCpn?.signes ?? {})
        .filter(([code, v]) => v === true && code !== 'seinsNormaux').map(([code]) => signesLibelles.get(code) ?? code),
    } : null,
    laboratoire: cpn.EXAMENS_LABO.map(({ code, libelle }) => {
      const r = derniere(consultations, (x) => x.laboratoire?.[code]);
      return r && { libelle, valeur: r.valeur, le: r.le };
    }).filter(Boolean),
    preventions: faites.map((code) => mesuresLibelles.get(code) ?? code),
    echographie: echographie ? {
      date: echographie.date, agSemaines: echographie.agSemaines, agJours: echographie.agJours, nombreFoetus: echographie.nombreFoetus,
      presentation: foetus?.presentation ?? '', poidsEstimeG: foetus?.poidsEstimeG ?? null,
      placenta: echographie.placenta?.localisation ?? '', liquide: echographie.liquideAmniotique?.quantite ?? '',
      conclusion: echographie.conclusion,
    } : null,
    allergies: atcd.allergies ?? '',
    medicaments: atcd.medicaments ?? '',
    points,
  };
}

module.exports = { charger, admission, examen, rappel };
