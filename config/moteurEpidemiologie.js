// Moteur de calcul partagé du module Épidémiologie (Partie I §4, Partie III §3).
// Règles communes appliquées partout :
//   - formule, numérateur et dénominateur toujours renvoyés avec le résultat ;
//   - dénominateur absent ou nul → « non calculable » (valeur null), jamais 0 % ;
//   - une donnée manquante n'est jamais remplacée par zéro ;
//   - personnes dédupliquées par identifiant (pas de double comptage) ;
//   - résultats « observés » (modules AMI) distingués des « estimés » (populations cibles).
// Les réalisations viennent des modules opérationnels d'AMI (aucune deuxième saisie) :
// CPN (consultations finalisées), Accouchement, Nouveau-né et Vaccination.
const Patiente = require('../models/Patiente');
const Consultation = require('../models/Consultation');
const Accouchement = require('../models/Accouchement');
const Enfant = require('../models/Enfant');
const vaccination = require('./vaccination');

const { jourKinshasa } = vaccination;
const JOUR = 86400000;
const TYPES_CPN = ['Première consultation prénatale', 'Suivi prénatal'];
const DOSE_ECHUE = ['En retard', 'Hors délai'];
const MESSAGE_NON_CALCULABLE = 'Non calculable';

/** Codes de réalisation → code de dose du calendrier vaccinal. */
const DOSES = { BCG: 'bcg', PENTA1: 'penta1', PENTA3: 'penta3', VPO3: 'vpo3', PCV3: 'pcv3', ROTA3: 'rota3', VAR1: 'var1', VAA: 'vaa' };
const CODES_REALISATION = ['CPN1', 'CPN2', 'CPN3', 'CPN4', 'CPN8', 'CPN_REQUIS', 'ACC', 'ACC_TOTAL', 'CPON', ...Object.keys(DOSES)];

const instantJour = (iso) => new Date(`${iso}T00:00:00+01:00`);
const id = (v) => (v == null ? '' : String(v));

/** Mois AAAA-MM entre deux jours (inclus). */
function moisEntre(du, au) {
  const cles = [];
  let [a, m] = du.slice(0, 7).split('-').map(Number);
  const fin = au.slice(0, 7);
  for (let k = `${a}-${String(m).padStart(2, '0')}`; k <= fin; ) {
    cles.push(k);
    m += 1;
    if (m > 12) { m = 1; a += 1; }
    k = `${a}-${String(m).padStart(2, '0')}`;
  }
  return cles;
}

/** Nombre de mois (fraction de l'année) couverts par la période, pour proratiser une cible annuelle. */
const fractionAnnee = (du, au) => moisEntre(du, au).length / 12;

/**
 * Indicateur calculé : valeur = numérateur ÷ dénominateur × facteur, à une décimale (calcul sur
 * valeurs non arrondies). `raison` explique un résultat non calculable.
 */
function ratio(numerateur, denominateur, { facteur = 100, decimales = 1 } = {}) {
  if (numerateur == null) return { valeur: null, raison: 'Numérateur indisponible.' };
  if (denominateur == null) return { valeur: null, raison: 'Dénominateur absent.' };
  if (!denominateur) return { valeur: null, raison: 'Dénominateur nul.' };
  const p = 10 ** decimales;
  return { valeur: Math.round((numerateur / denominateur) * facteur * p) / p, raison: null };
}

/** Variation en % entre deux valeurs ; « non calculable » si la précédente est nulle ou absente. */
function variation(actuelle, precedente) {
  if (actuelle == null || precedente == null || precedente === 0) return { valeur: null, raison: MESSAGE_NON_CALCULABLE };
  return { valeur: Math.round(((actuelle - precedente) / precedente) * 1000) / 10, raison: null };
}

/** Rang de chaque CPN (1re, 2e…) dans sa grossesse, par ordre chronologique. */
function rangsCpn(cpn) {
  const parGrossesse = new Map();
  for (const c of cpn) {
    const k = id(c.grossesseId);
    if (!parGrossesse.has(k)) parGrossesse.set(k, []);
    parGrossesse.get(k).push(c);
  }
  const rang = new Map();
  for (const liste of parGrossesse.values()) liste.sort((a, b) => a.date - b.date).forEach((c, i) => rang.set(c, i + 1));
  return rang;
}

/**
 * Réalisations observées dans les modules AMI pour des établissements et une période (jours
 * AAAA-MM-JJ inclus, heure de Kinshasa). Renvoie les totaux, le détail par mois, les naissances
 * vivantes, les enfants zéro dose / sous-vaccinés et les signalements de décès à classifier.
 */
async function realisations({ etablissementIds, du, au, contactsCpnRequis = 4 }) {
  const mois = moisEntre(du, au);
  const vide = () => Object.fromEntries(CODES_REALISATION.map((c) => [c, 0]));
  const parMois = Object.fromEntries(mois.map((k) => [k, vide()]));
  const total = vide();
  const resultat = {
    du, au, mois, parMois, total, contactsCpnRequis,
    naissancesVivantes: 0, mortNes: 0, enfantsSuivis: 0, zeroDose: 0, sousVaccines: 0,
    signalements: { decesEnfants: 0, decesMaternelsMentionnes: 0, mortNes: 0 },
    etablissements: etablissementIds.length,
  };
  if (!etablissementIds.length) return resultat;

  const debut = instantJour(du);
  const fin = new Date(instantJour(au).getTime() + JOUR);
  const dansPeriode = (jourIso) => jourIso >= du && jourIso <= au;
  const ajouter = (code, jourIso, n = 1) => {
    if (!dansPeriode(jourIso)) return;
    total[code] += n;
    const k = jourIso.slice(0, 7);
    if (parMois[k]) parMois[k][code] += n;
  };

  const patientes = await Patiente.distinct('_id', { etablissementId: { $in: etablissementIds } });
  const [cpn, accouchements, enfants] = await Promise.all([
    // Toutes les CPN de la grossesse comptent pour le rang, même antérieures à la période.
    Consultation.find({ patienteId: { $in: patientes }, statut: 'Finalisée', type: { $in: TYPES_CPN }, date: { $lt: fin } })
      .select('patienteId grossesseId date').lean(),
    Accouchement.find({ etablissementId: { $in: etablissementIds }, 'accouchement.heure': { $gte: debut, $lt: fin } })
      .select('patienteId accouchement.heure accouchement.accoucheur postPartum.sortie.observations').lean(),
    Enfant.find({ $or: [{ etablissementId: { $in: etablissementIds } }, { mereId: { $in: patientes } }], neLe: { $lt: fin } })
      .select('mereId dateNaissance neLe etatNaissance statut vaccinations suivis updatedAt createdAt'),
  ]);

  // CPN : femmes distinctes par rang de visite (une femme par grossesse et par rang).
  const rang = rangsCpn(cpn);
  const vues = new Set();
  for (const c of cpn) {
    const r = rang.get(c);
    const jourIso = jourKinshasa(c.date);
    const codes = [];
    if (r <= 4) codes.push(`CPN${r}`);
    if (r === 8) codes.push('CPN8');
    if (r === contactsCpnRequis) codes.push('CPN_REQUIS');
    for (const code of codes) {
      const cle = `${code}|${id(c.grossesseId)}`;
      if (vues.has(cle)) continue;
      vues.add(cle);
      ajouter(code, jourIso);
    }
  }

  // Accouchements en structure ; assistés : accoucheur (personnel qualifié) renseigné.
  const DECES = /d[ée]c[èe]s|d[ée]c[ée]d/i;
  for (const a of accouchements) {
    const jourIso = jourKinshasa(a.accouchement.heure);
    ajouter('ACC_TOTAL', jourIso);
    if ((a.accouchement.accoucheur || '').trim()) ajouter('ACC', jourIso);
    if (DECES.test(a.postPartum?.sortie?.observations || '')) resultat.signalements.decesMaternelsMentionnes += 1;
  }

  // Nouveau-nés, consultations postnatales et vaccination.
  for (const e of enfants) {
    const naissance = e.dateNaissance;
    if (dansPeriode(naissance)) {
      if (e.etatNaissance === 'Vivant') {
        resultat.naissancesVivantes += 1;
        const limite = new Date(Date.parse(`${naissance}T00:00:00Z`) + 7 * JOUR).toISOString().slice(0, 10);
        if ((e.suivis ?? []).some((s) => s.date >= naissance && s.date <= limite)) ajouter('CPON', naissance);
      } else {
        resultat.mortNes += 1;
        resultat.signalements.mortNes += 1;
      }
    }
    if (e.statut === 'Décédé' && e.updatedAt >= debut && e.updatedAt < fin) resultat.signalements.decesEnfants += 1;
    if (e.etatNaissance !== 'Vivant') continue;
    const faites = e.vaccinationsValides();
    for (const [code, dose] of Object.entries(DOSES)) {
      const v = faites.find((x) => x.code === dose);
      if (v) ajouter(code, v.date);
    }
    // État vaccinal à la fin de la période (doses faites à cette date seulement).
    if (e.statut === 'Suivi' && naissance <= au) {
      resultat.enfantsSuivis += 1;
      const carnet = vaccination.calendrier(naissance, faites.filter((v) => v.date <= au), au);
      const statut = new Map(carnet.doses.map((d) => [d.code, d.statut]));
      if (DOSE_ECHUE.includes(statut.get('penta1'))) resultat.zeroDose += 1;
      if (carnet.doses.some((d) => d.type === 'Vaccin' && DOSE_ECHUE.includes(d.statut))) resultat.sousVaccines += 1;
    }
  }
  return resultat;
}

module.exports = { realisations, ratio, variation, moisEntre, fractionAnnee, rangsCpn, instantJour, CODES_REALISATION, DOSES, MESSAGE_NON_CALCULABLE, jourKinshasa };
