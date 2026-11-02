// Synthèse opérationnelle du tableau de bord AMI (cahier de spécifications, sections 4 à 19).
// Chaque indicateur est renvoyé avec sa valeur, son numérateur, son dénominateur, sa formule, sa
// date de référence et sa source (config/indicateurs.js). Règles transversales (section 14) :
//   - un taux dont le dénominateur est nul vaut null (affiché « N/A »), jamais 0 % ;
//   - les personnes sont dédupliquées par identifiant AMI ; les données manquantes ne sont pas des zéros ;
//   - calcul sur valeurs non arrondies, arrondi à une décimale à l'affichage.
// Les compteurs « instantanés » (retards, tâches ouvertes) ne dépendent pas de la période.
const Patiente = require('../models/Patiente');
const Grossesse = require('../models/Grossesse');
const Consultation = require('../models/Consultation');
const RendezVous = require('../models/RendezVous');
const Echographie = require('../models/Echographie');
const Accouchement = require('../models/Accouchement');
const Enfant = require('../models/Enfant');
const TacheRelance = require('../models/TacheRelance');
const AlerteRelance = require('../models/AlerteRelance');
const Urgence = require('../models/Urgence');
const Reco = require('../models/Reco');
const { ROLES_MATERNITE } = require('../models/Soignant');
const vaccination = require('../config/vaccination');
const { jourKinshasa } = vaccination;
const { MESURES_PREVENTIVES } = require('../config/cpn');
const { HEMORRAGIE_PHYSIOLOGIQUE_MAX_ML } = require('../config/accouchement');
const { ALERTES, MOTIF_RECO, RESULTATS_CONTACT } = require('../config/relance');
const ParcoursRelance = require('../models/ParcoursRelance');
const { MOTIFS: MOTIFS_URGENCE, ETATS_ACTIFS: URGENCES_ACTIVES } = require('../config/urgences');
const { VERSION_REGLES, PARAMETRES, PERIODES, CATALOGUE, DONNEES_MANQUANTES } = require('../config/indicateurs');
const { filtreTerritoire } = require('./relance');
const { calculer } = require('./indicateursRelance');
const { erreur, texte, jour } = require('./saisie');
const { filtrePatientes, idsPatientes } = require('./patientes');

const JOUR = 86400000;
const TYPES_CPN = ['Première consultation prénatale', 'Suivi prénatal'];
const PRIORITE_RANG = { Urgente: 0, Prioritaire: 1, Normale: 2 };
const MOIS_COURTS = ['jan', 'fév', 'mar', 'avr', 'mai', 'juin', 'juil', 'août', 'sep', 'oct', 'nov', 'déc'];

/** Taux à une décimale ; null si le dénominateur est nul (section 14). */
const taux = (num, den) => (den ? Math.round((num / den) * 1000) / 10 : null);
const id = (v) => (v == null ? '' : String(v));
const nomComplet = (p) => (p ? [p.prenom, p.nom].filter(Boolean).join(' ') : '');
const instantJour = (iso) => new Date(`${iso}T00:00:00+01:00`);
/** Mois civil (AAAA-MM, Kinshasa) d'un instant. */
const moisDe = (d) => jourKinshasa(d).slice(0, 7);
const decalerJour = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * JOUR).toISOString().slice(0, 10);

/** Bornes de la période demandée (jours civils de Kinshasa, bornes incluses). */
function periodeDemandee(q, maintenant) {
  const auj = jourKinshasa(maintenant);
  const [a, m] = auj.split('-').map(Number);
  const code = PERIODES[q.periode] ? q.periode : 'mois';
  let du = auj;
  let au = auj;
  if (code === '7j') du = decalerJour(auj, -6);
  else if (code === 'mois') du = `${auj.slice(0, 7)}-01`;
  else if (code === 'trimestre') du = `${a}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
  else if (code === 'annee') du = `${a}-01-01`;
  else if (code === 'perso') {
    du = jour(q.du, 'Début de période') ?? auj;
    au = jour(q.au, 'Fin de période') ?? auj;
    if (du > au) throw erreur(400, 'La période est invalide.');
  }
  const debut = instantJour(du);
  const fin = new Date(instantJour(au).getTime() + JOUR);
  // Période précédente de même durée (variation des cartes).
  const duree = fin - debut;
  return { code, libelle: PERIODES[code], du, au, debut, fin, precedente: { debut: new Date(debut - duree), fin: debut } };
}

/** Indicateur de comptage. */
function nombre(code, n, extra = {}) {
  return { code, ...CATALOGUE[code], valeur: n, numerateur: n, denominateur: null, ...extra };
}

/** Indicateur de proportion (numérateur, dénominateur, taux). */
function pourcentage(code, num, den, extra = {}) {
  return { code, ...CATALOGUE[code], valeur: taux(num, den), numerateur: num, denominateur: den, ...extra };
}

/** Rang de chaque CPN (1re, 2e, 3e…) dans sa grossesse, par ordre chronologique. */
function rangsCpn(cpn) {
  const parGrossesse = new Map();
  for (const c of cpn) {
    const k = id(c.grossesseId);
    if (!parGrossesse.has(k)) parGrossesse.set(k, []);
    parGrossesse.get(k).push(c);
  }
  const rang = new Map();
  for (const liste of parGrossesse.values()) liste.sort((a, b) => a.date - b.date).forEach((c, i) => rang.set(c, i + 1));
  return { rang, parGrossesse };
}

/** Femmes distinctes dont la CPN de rang `n` tombe dans le mois `mois` (AAAA-MM, Kinshasa). */
const femmesCpnDuMois = (cpn, rang, n, mois) =>
  new Set(cpn.filter((c) => rang.get(c) === n && jourKinshasa(c.date).slice(0, 7) === mois).map((c) => id(c.patienteId))).size;

const mediane = (valeurs) => {
  if (!valeurs.length) return null;
  const v = [...valeurs].sort((x, y) => x - y);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

exports.synthese = async (req, res) => {
  const maintenant = new Date();
  const auj = jourKinshasa(maintenant);
  const q = req.query;
  const periode = periodeDemandee(q, maintenant);
  const dansPeriode = (d) => d && d >= periode.debut && d < periode.fin;
  const jourDansPeriode = (iso) => iso && iso >= periode.du && iso <= periode.au;
  const province = q.province ? texte(q.province, 80) : '';
  const aire = q.aire ? texte(q.aire, 120) : '';
  const maternite = ROLES_MATERNITE.includes(req.soignant.role);
  const il12Mois = new Date(maintenant - 365 * JOUR);
  const il6Mois = new Date(Date.UTC(+auj.slice(0, 4), +auj.slice(5, 7) - 6, 1) - 60 * 60000);
  const depuisRdv = new Date(Math.min(periode.debut, il6Mois));

  // Patientes de l'établissement de connexion seulement (cloisonnement, voir controllers/patientes.js).
  const ids = await idsPatientes(req);
  const dePatiente = { patienteId: { $in: ids } };
  const [patientesToutes, grossesses, consultations, rdvs, echographies, accouchements, enfantsTous, tachesToutes, alertes, urgences] = await Promise.all([
    Patiente.find(filtrePatientes(req)).select('numero nom prenom postnom telephone telephoneChiffres dateNaissance ageDeclare adresse consentements createdAt statut').lean(),
    Grossesse.find(dePatiente).select('patienteId statut createdAt').lean(),
    Consultation.find({ ...dePatiente, statut: 'Finalisée' })
      .select('patienteId grossesseId type date constantes.poidsKg constantes.taSystolique constantes.taDiastolique prochainRdv.date reference.motifs').lean(),
    RendezVous.find({ ...dePatiente, enfantId: null, $or: [{ date: { $gte: depuisRdv } }, { statut: { $in: RendezVous.STATUTS_ACTIFS } }] })
      .select('patienteId date motif statut rappelPushLe rappelJourPushLe').lean(),
    Echographie.find({ ...dePatiente, date: { $gte: periode.du, $lte: periode.au } }).select('patienteId date').lean(),
    Accouchement.find(dePatiente).select('numero patienteId grossesseId statut accouchement.heure accouchement.accoucheur accouchement.nombreEnfants evacuation.le alertes createdAt').lean(),
    Enfant.find({ mereId: { $in: ids } }).select('numero nom prenom postnom sexe neLe dateNaissance etatNaissance statut vaccinations mereId accouchementId grossesseId origine naissance createdAt'),
    TacheRelance.find(filtreTerritoire(req))
      .select('numero statut statutLe ouverte priorite domaine parcoursCode personneType patienteId enfantId recoId aireSante echeance attribueeLe contactEtabliLe visites actions.type actions.le orientation confirmation resolution conflits createdAt declaree.nom').lean(),
    AlerteRelance.find(filtreTerritoire(req)).lean(),
    Urgence.find({ ...dePatiente, etat: { $in: URGENCES_ACTIVES } }).select('numero patienteId motif gravite etat createdAt prisEnChargePar').lean(),
  ]);

  // --- Filtre géographique (province, aire de santé de résidence) -------------------------
  const patientes = patientesToutes.filter((p) => (!province || p.adresse?.province === province) && (!aire || p.adresse?.aireSante === aire));
  const filtre = province || aire;
  const retenues = new Set(patientes.map((p) => id(p._id)));
  const garde = (pid) => !filtre || retenues.has(id(pid));
  const patienteDe = new Map(patientesToutes.map((p) => [id(p._id), p]));
  const enfants = enfantsTous.filter((e) => garde(e.mereId));
  const enfantDe = new Map(enfantsTous.map((e) => [e.id, e]));
  const mereDeEnfant = (eid) => enfantDe.get(id(eid))?.mereId;
  const taches = tachesToutes.filter((t) => !filtre || (t.patienteId ? garde(t.patienteId) : t.enfantId ? garde(mereDeEnfant(t.enfantId)) : false));
  const gr = grossesses.filter((g) => garde(g.patienteId));
  const cs = consultations.filter((c) => garde(c.patienteId));
  const rv = rdvs.filter((r) => garde(r.patienteId));
  const acc = accouchements.filter((a) => garde(a.patienteId));
  const urg = urgences.filter((u) => garde(u.patienteId));

  // --- Module Enregistrement et dossier unique (section 5) ---------------------------------
  const complet = (p) => !!(p.prenom && (p.dateNaissance || p.ageDeclare) && (p.telephone || '').trim() && p.adresse?.province && (p.adresse?.commune || p.adresse?.quartier));
  const nouveaux = patientes.filter((p) => dansPeriode(p.createdAt));
  const doublons = new Set();
  const grouper = (cle) => {
    const groupes = new Map();
    for (const p of patientes) {
      const k = cle(p);
      if (!k) continue;
      if (!groupes.has(k)) groupes.set(k, []);
      groupes.get(k).push(id(p._id));
    }
    for (const liste of groupes.values()) if (liste.length > 1) liste.forEach((x) => doublons.add(x));
  };
  grouper((p) => (p.telephoneChiffres?.length >= 9 ? p.telephoneChiffres.slice(-9) : null));
  grouper((p) => (p.dateNaissance && p.nom ? `${p.nom}|${(p.prenom || '').toLowerCase()}|${p.dateNaissance}` : null));
  const avecTel = patientes.filter((p) => (p.telephone || '').trim());
  const consentie = (p) => [p.consentements?.sms, p.consentements?.appel, p.consentements?.whatsapp].some((v) => v != null);
  const continuite = enfants.filter((e) => patienteDe.has(id(e.mereId)) && (e.origine === 'Né hors plateforme' || e.accouchementId));
  const dossier = [
    nombre('DOS_NOUVEAUX', nouveaux.length, { lien: '/admin/patientes' }),
    pourcentage('DOS_COMPLETS', patientes.filter(complet).length, patientes.length, { lien: '/admin/patientes' }),
    pourcentage('DOS_ID_VALIDE', patientes.filter((p) => /^AC-PAT-\d{6}$/.test(p.numero)).length, patientes.length),
    nombre('DOS_DOUBLONS', doublons.size, { lien: '/admin/doublons' }),
    pourcentage('DOS_CONTINUITE', continuite.length, enfants.length, { lien: '/admin/enfants' }),
    pourcentage('DOS_CONSENTEMENT', avecTel.filter(consentie).length, avecTel.length),
  ];

  // --- Module CPN (section 6) ---------------------------------------------------------------
  const cpn = cs.filter((c) => TYPES_CPN.includes(c.type));
  const grace = PARAMETRES.graceCpnJours * JOUR;
  const actif = (r) => RendezVous.STATUTS_ACTIFS.includes(r.statut);
  const cpnRetard = rv.filter((r) => actif(r) && r.date < new Date(maintenant - grace));
  const rdvPeriode = rv.filter((r) => dansPeriode(r.date) && r.statut !== 'Annulé');
  const rdvEchus = rdvPeriode.filter((r) => r.date < maintenant);
  const effectues = rdvPeriode.filter((r) => r.statut === 'Effectué');
  // Abandon présumé : dernière CPN trop ancienne et aucun rendez-vous à venir.
  const derniereCpn = new Map();
  for (const c of cpn) {
    const k = id(c.grossesseId);
    if (!derniereCpn.has(k) || derniereCpn.get(k) < c.date) derniereCpn.set(k, c.date);
  }
  const rdvAVenir = new Set(rv.filter((r) => actif(r) && r.date >= maintenant).map((r) => id(r.patienteId)));
  const seuilAbandon = new Date(maintenant - PARAMETRES.abandonCpnJours * JOUR);
  const enCours = gr.filter((g) => g.statut === 'En cours');
  const abandons = enCours.filter((g) => (derniereCpn.get(id(g._id)) ?? g.createdAt) < seuilAbandon && !rdvAVenir.has(id(g.patienteId)));
  const cpnPeriode = cpn.filter((c) => dansPeriode(c.date));
  // Rang de chaque CPN dans sa grossesse (1re, 2e, 3e, 4e…), par ordre chronologique : CPN2 à CPN4
  // comptent les femmes dont la visite de ce rang a eu lieu pendant la période.
  const { rang: rangCpn, parGrossesse: cpnParGrossesse } = rangsCpn(cpn);
  const femmesCpnRang = (n) => new Set(cpnPeriode.filter((c) => rangCpn.get(c) === n).map((c) => id(c.patienteId))).size;
  const cpnComplete = (c) => c.constantes?.poidsKg != null && c.constantes?.taSystolique != null && c.constantes?.taDiastolique != null && !!c.prochainRdv?.date;
  const references = cs.filter((c) => dansPeriode(c.date) && c.reference?.motifs?.length);
  const cpnModule = [
    nombre('CPN_INSCRITES', new Set(gr.filter((g) => dansPeriode(g.createdAt)).map((g) => id(g.patienteId))).size, { lien: '/admin/patientes' }),
    nombre('CPN_CPN1', new Set(cpnPeriode.filter((c) => c.type === 'Première consultation prénatale').map((c) => id(c.patienteId))).size, { lien: '/admin/patientes' }),
    nombre('CPN_CPN2', femmesCpnRang(2), { lien: '/admin/patientes' }),
    nombre('CPN_CPN3', femmesCpnRang(3), { lien: '/admin/patientes' }),
    nombre('CPN_CPN4', femmesCpnRang(4), { lien: '/admin/patientes' }),
    nombre('CPN_RDV_PREVUS', rdvPeriode.length, { lien: '/admin/rendez-vous' }),
    nombre('CPN_RDV_HONORES', effectues.length, { lien: '/admin/rendez-vous' }),
    pourcentage('CPN_HONORABILITE', rdvEchus.filter((r) => r.statut === 'Effectué').length, rdvEchus.length, { lien: '/admin/rendez-vous' }),
    nombre('CPN_RETARD', cpnRetard.length, { lien: '/admin/rendez-vous', instantane: true, detail: `${new Set(cpnRetard.map((r) => id(r.patienteId))).size} femme(s) concernée(s)` }),
    nombre('CPN_ABANDON', abandons.length, { lien: '/admin/relance', instantane: true, detail: `Sans CPN depuis ${PARAMETRES.abandonCpnJours} j` }),
    pourcentage('CPN_COMPLETUDE', cpnPeriode.filter(cpnComplete).length, cpnPeriode.length),
    nombre('CPN_ECHO', echographies.filter((e) => garde(e.patienteId)).length),
    nombre('CPN_REFERENCES', references.length),
  ];

  // --- Accouchement, naissance et postnatal (section 7) ------------------------------------
  const accPeriode = acc.filter((a) => dansPeriode(a.accouchement?.heure));
  const accPrecedent = acc.filter((a) => a.accouchement?.heure >= periode.precedente.debut && a.accouchement?.heure < periode.precedente.fin).length;
  const enfantsParAcc = new Map();
  for (const e of enfants) {
    if (!e.accouchementId) continue;
    const k = id(e.accouchementId);
    enfantsParAcc.set(k, (enfantsParAcc.get(k) ?? 0) + 1);
  }
  const nnPeriode = enfants.filter((e) => e.origine !== 'Né hors plateforme' && dansPeriode(e.neLe));
  const vivants = nnPeriode.filter((e) => e.etatNaissance === 'Vivant');
  const ficheComplete = (e) => {
    const n = e.naissance ?? {};
    return n.poidsG != null && n.tailleCm != null && n.perimetreCranienCm != null && n.apgar?.m1?.total != null
      && n.apgar?.m5?.total != null && n.miseAuSeinMoins1h != null && n.traitement?.vitamineK1 != null;
  };
  const fenetre = PARAMETRES.postnatalFenetreJours * JOUR;
  const postnatals = cs.filter((c) => c.type === 'Postnatal');
  const eligiblesPostnatal = accPeriode.filter((a) => a.accouchement.heure < new Date(maintenant - fenetre));
  const postnatalFait = eligiblesPostnatal.filter((a) => postnatals.some((c) => id(c.patienteId) === id(a.patienteId)
    && c.date >= a.accouchement.heure && c.date - a.accouchement.heure <= fenetre));
  const lienComplet = accPeriode.filter((a) => (enfantsParAcc.get(id(a._id)) ?? 0) >= (a.accouchement.nombreEnfants || 1));
  const accouchementModule = [
    nombre('ACC_ENREGISTRES', accPeriode.length, { lien: maternite ? '/admin/accouchements' : null, precedent: accPrecedent }),
    pourcentage('ACC_ASSISTES', accPeriode.filter((a) => (a.accouchement.accoucheur || '').trim()).length, accPeriode.length),
    nombre('ACC_HORS_STRUCTURE', enfants.filter((e) => e.origine === 'Né hors plateforme' && dansPeriode(e.neLe)).length, { lien: '/admin/enfants' }),
    nombre('ACC_EVACUATIONS', acc.filter((a) => dansPeriode(a.evacuation?.le)).length),
    nombre('ACC_VIVANTS', vivants.length, { lien: '/admin/enfants', detail: `${nnPeriode.length - vivants.length} mort(s)-né(s)` }),
    pourcentage('ACC_FICHE_NN', vivants.filter(ficheComplete).length, vivants.length, { lien: '/admin/enfants' }),
    pourcentage('ACC_LIEN', lienComplet.length, accPeriode.length),
    pourcentage('ACC_POSTNATAL', postnatalFait.length, eligiblesPostnatal.length),
  ];

  // --- Vaccination / PEV (section 8) -------------------------------------------------------
  const suivis = enfants.filter((e) => e.estSuivi());
  const carnets = new Map(suivis.map((e) => [e.id, e.carnet(auj)]));
  const statutDose = (e, code) => carnets.get(e.id)?.doses.find((d) => d.code === code)?.statut;
  let dosesDues = 0;
  let dosesRetard = 0;
  const enfantsRetard = [];
  for (const e of suivis) {
    const doses = carnets.get(e.id).doses;
    dosesDues += doses.filter((d) => d.statut === 'À faire').length;
    const retard = doses.filter((d) => d.statut === 'En retard');
    dosesRetard += retard.length;
    if (retard.length) enfantsRetard.push({ e, retard });
  }
  const zeroDose = suivis.filter((e) => ['En retard', 'Hors délai'].includes(statutDose(e, 'penta1')));
  const sousVaccines = suivis.filter((e) => carnets.get(e.id).doses.some((d) => ['En retard', 'Hors délai'].includes(d.statut)));
  const penta3Echue = suivis.filter((e) => statutDose(e, 'penta1') === 'Faite' && !['À venir', 'À faire', undefined].includes(statutDose(e, 'penta3')));
  let dosesTotal = 0;
  let dosesValides = 0;
  let dosesPeriode = 0;
  for (const e of enfants) {
    const vus = new Set();
    for (const v of e.vaccinationsValides()) {
      dosesTotal++;
      if (jourDansPeriode(v.date)) dosesPeriode++;
      if (v.date >= e.dateNaissance && v.date <= auj && !vus.has(v.code)) dosesValides++;
      vus.add(v.code);
    }
  }
  const vaccinationModule = [
    nombre('VAC_DOSES', dosesPeriode, { lien: '/admin/enfants' }),
    nombre('VAC_DUES', dosesDues, { lien: '/admin/enfants', instantane: true }),
    nombre('VAC_RETARD', dosesRetard, { lien: '/admin/enfants', instantane: true, detail: `${enfantsRetard.length} enfant(s) à rattraper` }),
    pourcentage('VAC_ABANDON', penta3Echue.filter((e) => statutDose(e, 'penta3') !== 'Faite').length, penta3Echue.length, { lien: '/admin/enfants' }),
    nombre('VAC_ZERO_DOSE', zeroDose.length, { lien: '/admin/enfants', instantane: true }),
    nombre('VAC_SOUS_VACCINES', sousVaccines.length, { lien: '/admin/enfants', instantane: true }),
    pourcentage('VAC_QUALITE', dosesValides, dosesTotal),
  ];

  // --- Relance communautaire RECO (section 9) ----------------------------------------------
  const valides = taches.filter((t) => t.statut !== 'Doublon annulé');
  const ouvertes = valides.filter((t) => t.ouverte);
  const echues = ouvertes.filter((t) => t.echeance < maintenant);
  const personne = (t) => `${t.personneType}:${id(t.enfantId ?? t.patienteId ?? t.numero)}`;
  const cohorte = taches.filter((t) => dansPeriode(t.createdAt));
  const perf = calculer(cohorte, maintenant);
  const indicateurRelance = (codeSource) => perf.indicateurs.find((x) => x.code === codeSource);
  const delais = cohorte.filter((t) => t.statut !== 'Doublon annulé' && t.actions?.length)
    .map((t) => (Math.min(...t.actions.map((a) => new Date(a.le).getTime())) - t.createdAt) / 3600000).filter((h) => h >= 0);
  const delaiMedian = mediane(delais);
  const orientees = cohorte.filter((t) => t.statut !== 'Doublon annulé' && t.orientation);
  const relanceModule = [
    nombre('REL_OUVERTES', ouvertes.length, { lien: '/admin/relance', instantane: true }),
    nombre('REL_ECHUES', echues.length, { lien: '/admin/relance', instantane: true }),
    nombre('REL_A_RETROUVER', new Set(ouvertes.map(personne)).size, { lien: '/admin/relance', instantane: true }),
    nombre('REL_SANS_RECO', ouvertes.filter((t) => !t.recoId).length, { lien: '/admin/relance', instantane: true }),
    pourcentage('REL_VISITES', indicateurRelance('visites').numerateur, indicateurRelance('visites').denominateur),
    pourcentage('REL_REINTEGRATION', indicateurRelance('reintegration').numerateur, indicateurRelance('reintegration').denominateur),
    pourcentage('REL_RESOLUTION', indicateurRelance('resolues').numerateur, indicateurRelance('resolues').denominateur),
    { code: 'REL_DELAI', ...CATALOGUE.REL_DELAI, valeur: delaiMedian == null ? null : Math.round(delaiMedian * 10) / 10, numerateur: delais.length, denominateur: null },
    pourcentage('REL_ORIENTATIONS', orientees.filter((t) => t.confirmation).length, orientees.length),
  ];
  const unique = (liste) => new Set(liste.map(personne)).size;
  const cohorteValide = cohorte.filter((t) => t.statut !== 'Doublon annulé');
  const fluxReco = [
    { etape: 'Identifiées', n: unique(cohorteValide) },
    { etape: 'Assignées', n: unique(cohorteValide.filter((t) => t.attribueeLe)) },
    { etape: 'Contact tenté', n: unique(cohorteValide.filter((t) => t.contactEtabliLe || t.actions?.some((a) => ['tentative', 'visite_realisee'].includes(a.type)))) },
    { etape: 'Retrouvées', n: unique(cohorteValide.filter((t) => t.contactEtabliLe)) },
    { etape: 'Réintégrées / orientées', n: unique(cohorteValide.filter((t) => t.statut === 'Réintégration confirmée' || t.orientation)) },
  ];
  const issuesReco = {
    reintegrees: unique(cohorteValide.filter((t) => t.statut === 'Réintégration confirmée')),
    orientees: unique(cohorteValide.filter((t) => t.orientation && t.statut !== 'Réintégration confirmée')),
    clotureesSansReintegration: unique(cohorteValide.filter((t) => t.statut === 'Clôturée sans réintégration')),
    nonRetrouvees: unique(cohorteValide.filter((t) => t.statut === 'Non retrouvée')),
  };

  // --- Alertes et rendez-vous (section 10) -------------------------------------------------
  const alertesOuvertes = alertes.filter((a) => a.ouverte);
  const alertesUrgentes = alertesOuvertes.filter((a) => ['urgence', 'urgente_non_prise'].includes(a.type));
  const sla = PARAMETRES.slaAlerteHeures * 3600000;
  const alertesPeriode = alertes.filter((a) => dansPeriode(a.premiereLe));
  const rdvManquesRappel = rdvEchus.filter((r) => r.statut !== 'Effectué' && (r.rappelPushLe || r.rappelJourPushLe));
  const urgentes = urg.length + alertesUrgentes.length;
  const alertesModule = [
    nombre('ALE_OUVERTES', alertesOuvertes.length, { lien: '/admin/relance', instantane: true }),
    nombre('ALE_URGENTES', urgentes, { lien: '/admin/urgences', instantane: true, detail: `${urg.length} urgence(s) patiente · ${alertesUrgentes.length} alerte(s) RECO` }),
    nombre('ALE_DEPASSEMENT', alertesOuvertes.filter((a) => maintenant - a.premiereLe > sla).length, { lien: '/admin/relance', instantane: true, detail: `Ouvertes depuis plus de ${PARAMETRES.slaAlerteHeures} h` }),
    nombre('ALE_RDV_MANQUES', rdvManquesRappel.length, { lien: '/admin/rendez-vous' }),
    pourcentage('ALE_CLOTURE', alertesPeriode.filter((a) => a.accuseLe).length, alertesPeriode.length),
  ];
  const alertesParType = Object.entries(ALERTES).map(([type, a]) => ({
    type, libelle: a.libelle, ouvertes: alertesOuvertes.filter((x) => x.type === type).reduce((s, x) => s + (x.occurrences || 1), 0),
  })).filter((x) => x.ouvertes);

  // --- Références et contre-références (section 11) ----------------------------------------
  const referencesModule = {
    cpnEmises: references.length,
    evacuationsObstetricales: acc.filter((a) => dansPeriode(a.evacuation?.le)).length,
    communautairesEmises: orientees.length,
    communautairesAbouties: orientees.filter((t) => t.confirmation).length,
    tauxAboutissement: taux(orientees.filter((t) => t.confirmation).length, orientees.length),
    delaiMedianJours: (() => {
      const d = orientees.filter((t) => t.confirmation).map((t) => (new Date(t.confirmation.le) - new Date(t.orientation.le)) / JOUR).filter((x) => x >= 0);
      const m = mediane(d);
      return m == null ? null : Math.round(m * 10) / 10;
    })(),
  };

  // --- Six cartes prioritaires (section 19, ligne 1) --------------------------------------
  const carte = (indic, extra = {}) => ({ ...indic, ...extra });
  const prioritaires = [
    carte(cpnModule.find((x) => x.code === 'CPN_RETARD'), { icone: 'fa-calendar-xmark', ton: 'rose' }),
    carte(accouchementModule.find((x) => x.code === 'ACC_ENREGISTRES'), { icone: 'fa-baby-carriage', ton: 'brand' }),
    carte(vaccinationModule.find((x) => x.code === 'VAC_RETARD'), { icone: 'fa-syringe', ton: 'amber' }),
    carte(vaccinationModule.find((x) => x.code === 'VAC_ZERO_DOSE'), { icone: 'fa-shield-virus', ton: 'violet' }),
    carte(relanceModule.find((x) => x.code === 'REL_ECHUES'), { icone: 'fa-person-walking-arrow-right', ton: 'sky', detail: `${ouvertes.length} tâche(s) ouverte(s) · ${relanceModule[3].valeur} sans RECO` }),
    carte(alertesModule.find((x) => x.code === 'ALE_URGENTES'), { icone: 'fa-bell', ton: 'rose' }),
  ];

  // --- Tendance sur 6 mois (section 19, ligne 2) -------------------------------------------
  const moisCles = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(Date.UTC(+auj.slice(0, 4), +auj.slice(5, 7) - 6 + i, 1));
    return d.toISOString().slice(0, 7);
  });
  const moisDe = (d) => (d ? jourKinshasa(d).slice(0, 7) : null);
  const compterParMois = (valeurs) => moisCles.map((m) => valeurs.filter((v) => v === m).length);
  const tendance = {
    mois: moisCles.map((m) => `${MOIS_COURTS[+m.slice(5) - 1]} ${m.slice(2, 4)}`),
    series: [
      { code: 'cpn', libelle: 'Consultations prénatales', valeurs: compterParMois(cpn.map((c) => moisDe(c.date))) },
      { code: 'accouchements', libelle: 'Accouchements', valeurs: compterParMois(acc.map((a) => moisDe(a.accouchement?.heure))) },
      { code: 'doses', libelle: 'Doses de vaccin', valeurs: compterParMois(enfants.flatMap((e) => e.vaccinationsValides().map((v) => v.date.slice(0, 7)))) },
      { code: 'reintegrations', libelle: 'Réintégrations confirmées', valeurs: compterParMois(valides.filter((t) => t.statut === 'Réintégration confirmée').map((t) => moisDe(t.confirmation?.le))) },
    ],
  };

  // --- Comparaison par aire de santé (section 19, ligne 2) ---------------------------------
  const aireDe = (pid) => patienteDe.get(id(pid))?.adresse?.aireSante || 'Non renseignée';
  const parAire = new Map();
  const ligne = (nom) => {
    if (!parAire.has(nom)) parAire.set(nom, { aire: nom, grossessesEnCours: 0, cpnEnRetard: 0, enfantsEnRetard: 0, tachesOuvertes: 0 });
    return parAire.get(nom);
  };
  enCours.forEach((g) => ligne(aireDe(g.patienteId)).grossessesEnCours++);
  cpnRetard.forEach((r) => ligne(aireDe(r.patienteId)).cpnEnRetard++);
  enfantsRetard.forEach(({ e }) => ligne(aireDe(e.mereId)).enfantsEnRetard++);
  ouvertes.forEach((t) => ligne(t.aireSante || 'Non renseignée').tachesOuvertes++);
  const comparaisonAires = [...parAire.values()]
    .sort((a, b) => (b.cpnEnRetard + b.enfantsEnRetard + b.tachesOuvertes) - (a.cpnEnRetard + a.enfantsEnRetard + a.tachesOuvertes) || b.grossessesEnCours - a.grossessesEnCours)
    .slice(0, 8);

  // --- Entonnoir du continuum mère-enfant (cohorte : grossesses enregistrées sur 12 mois) --
  const cohorteGr = gr.filter((g) => g.createdAt >= il12Mois);
  const accParGrossesse = new Map(acc.filter((a) => a.accouchement?.heure).map((a) => [id(a.grossesseId), a]));
  const nnParGrossesse = new Map();
  for (const e of enfants) {
    if (e.etatNaissance !== 'Vivant' || !e.grossesseId) continue;
    nnParGrossesse.set(id(e.grossesseId), [...(nnParGrossesse.get(id(e.grossesseId)) ?? []), e]);
  }
  const etapes = [
    ['Grossesses enregistrées', () => true],
    ['CPN1 réalisée', (g) => (cpnParGrossesse.get(id(g._id)) ?? []).some((c) => c.type === 'Première consultation prénatale')],
    ['4 CPN ou plus', (g) => (cpnParGrossesse.get(id(g._id)) ?? []).length >= 4],
    ['Accouchement documenté', (g) => accParGrossesse.has(id(g._id))],
    ['Nouveau-né vivant lié', (g) => nnParGrossesse.has(id(g._id))],
    ['BCG reçu', (g) => (nnParGrossesse.get(id(g._id)) ?? []).some((e) => e.vaccinationsValides().some((v) => v.code === 'bcg'))],
  ];
  let restants = cohorteGr;
  const continuum = etapes.map(([etape, test], i) => {
    restants = i === 0 ? cohorteGr : restants.filter(test);
    return { etape, n: restants.length };
  });

  // --- À traiter maintenant (section 19, ligne 4) ------------------------------------------
  const recos = new Map((await Reco.find({ _id: { $in: [...new Set(echues.map((t) => id(t.recoId)).filter(Boolean))] } }).select('prenom nom').lean())
    .map((x) => [id(x._id), `${x.prenom} ${x.nom}`]));
  const personneDe = (pid) => {
    const p = patienteDe.get(id(pid));
    return p ? { nom: nomComplet(p), numero: p.numero } : null;
  };
  const aTraiter = [];
  for (const u of urg) {
    aTraiter.push({
      type: 'Urgence', priorite: 'Urgente', motif: MOTIFS_URGENCE.find((m) => m.code === u.motif)?.libelle ?? 'Urgence', personne: personneDe(u.patienteId),
      detecteLe: u.createdAt, echeance: u.createdAt, responsable: u.prisEnChargePar?.nom || 'Non prise en charge',
      statut: u.etat, lien: ['/admin/urgences'], action: 'Réguler',
    });
  }
  for (const a of alertesUrgentes) {
    aTraiter.push({
      type: 'Alerte RECO', priorite: 'Urgente', motif: `${ALERTES[a.type].libelle}${a.occurrences > 1 ? ` (${a.occurrences})` : ''}`, personne: null,
      detecteLe: a.premiereLe, echeance: new Date(new Date(a.premiereLe).getTime() + sla), responsable: 'Supervision',
      statut: 'Ouverte', lien: ['/admin/relance'], action: 'Accuser et traiter',
    });
  }
  if (maternite) {
    for (const a of acc.filter((x) => x.statut === 'En travail')) {
      const critiques = (a.alertes ?? []).filter((x) => x.niveau === 'Critique' && !x.acquitteeLe);
      if (!critiques.length) continue;
      aTraiter.push({
        type: 'Salle de travail', priorite: 'Urgente', motif: critiques[critiques.length - 1].message, personne: personneDe(a.patienteId),
        detecteLe: critiques[0].le, echeance: critiques[0].le, responsable: 'Équipe de garde',
        statut: 'Alerte non acquittée', lien: ['/admin/accouchements', a.numero], action: 'Ouvrir le partogramme',
      });
    }
  }
  for (const t of echues) {
    const enfant = t.enfantId ? enfantDe.get(id(t.enfantId)) : null;
    aTraiter.push({
      type: `Relance ${t.parcoursCode || t.domaine}`, priorite: t.priorite, motif: MOTIF_RECO[t.domaine] ?? 'Relance',
      personne: enfant ? { nom: nomComplet(enfant), numero: enfant.numero } : t.patienteId ? personneDe(t.patienteId) : (t.declaree?.nom ? { nom: t.declaree.nom, numero: t.numero } : null),
      detecteLe: t.createdAt, echeance: t.echeance, responsable: t.recoId ? recos.get(id(t.recoId)) ?? 'RECO' : 'Sans RECO',
      statut: t.statut, lien: ['/admin/relance'], requete: { tache: t.numero }, action: t.recoId ? 'Suivre la relance' : 'Affecter un RECO',
    });
  }
  for (const r of cpnRetard) {
    const joursRetard = Math.floor((maintenant - r.date) / JOUR);
    const p = personneDe(r.patienteId);
    aTraiter.push({
      type: 'CPN en retard', priorite: joursRetard > PARAMETRES.retardCpnPrioritaireJours ? 'Prioritaire' : 'Normale',
      motif: `${r.motif} manqué (${joursRetard} j)`, personne: p, detecteLe: new Date(r.date.getTime() + grace), echeance: r.date,
      responsable: 'Structure', statut: r.statut, lien: p ? ['/admin/patientes', p.numero] : ['/admin/rendez-vous'], action: 'Appeler / reprogrammer',
    });
  }
  for (const { e, retard } of enfantsRetard) {
    const depuis = retard.map((d) => d.datePrevue).sort()[0];
    const joursRetard = Math.floor((Date.parse(auj) - Date.parse(depuis)) / JOUR);
    aTraiter.push({
      type: 'Vaccination', priorite: joursRetard > 30 ? 'Prioritaire' : 'Normale',
      motif: `${retard.map((d) => d.libelle).slice(0, 2).join(', ')}${retard.length > 2 ? ` +${retard.length - 2}` : ''} en retard`,
      personne: { nom: nomComplet(e), numero: e.numero }, detecteLe: instantJour(depuis), echeance: instantJour(depuis),
      responsable: 'Structure', statut: 'En retard', lien: ['/admin/enfants', e.numero], action: 'Rattraper',
    });
  }
  aTraiter.sort((a, b) => (PRIORITE_RANG[a.priorite] ?? 3) - (PRIORITE_RANG[b.priorite] ?? 3) || new Date(a.detecteLe) - new Date(b.detecteLe));
  const parType = {};
  for (const x of aTraiter) parType[x.type] = (parType[x.type] ?? 0) + 1;

  // --- Qualité des données (section 13) ----------------------------------------------------
  const qualite = {
    dossiersIncomplets: patientes.length - patientes.filter(complet).length,
    doublonsPresumes: doublons.size,
    dosesIncoherentes: dosesTotal - dosesValides,
    accouchementsSansNouveauNe: acc.filter((a) => a.accouchement?.heure && !(enfantsParAcc.get(id(a._id)) > 0)).length,
    consultationsIncompletes: cpnPeriode.length - cpnPeriode.filter(cpnComplete).length,
    conflitsRelance: taches.reduce((n, t) => n + (t.conflits ?? []).filter((c) => !c.resolu).length, 0),
  };

  res.json({
    genereLe: maintenant,
    versionRegles: VERSION_REGLES,
    parametres: PARAMETRES,
    periode: { code: periode.code, libelle: periode.libelle, du: periode.du, au: periode.au },
    filtres: {
      province, aire,
      aires: [...new Set(patientesToutes.map((p) => p.adresse?.aireSante).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr')),
    },
    prioritaires,
    modules: {
      dossier, cpn: cpnModule, accouchement: accouchementModule, vaccination: vaccinationModule,
      relance: relanceModule, alertes: alertesModule,
    },
    references: referencesModule,
    alertesParType,
    tendance,
    comparaisonAires,
    continuum,
    fluxReco,
    issuesReco,
    aTraiter: { total: aTraiter.length, parType, lignes: aTraiter.slice(0, 20) },
    qualite,
    donneesManquantes: DONNEES_MANQUANTES,
  });
};

/**
 * Fenêtre d'une analyse mensuelle (?mois=AAAA-MM, mois en cours par défaut ; ?province&aire) :
 * patientes de l'établissement de connexion retenues et les 6 mois se terminant par le mois choisi.
 */
async function fenetreMensuelle(req) {
  const moisCourant = jourKinshasa(new Date()).slice(0, 7);
  const mois = req.query.mois ? String(req.query.mois) : moisCourant;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mois)) throw erreur(400, 'Mois invalide (format attendu : AAAA-MM).');
  if (mois > moisCourant) throw erreur(400, 'Le mois demandé n’est pas encore commencé.');
  const province = req.query.province ? texte(req.query.province, 80) : '';
  const aire = req.query.aire ? texte(req.query.aire, 120) : '';
  const filtre = { ...filtrePatientes(req) };
  if (province) filtre['adresse.province'] = province;
  if (aire) filtre['adresse.aireSante'] = aire;
  const [a, m] = mois.split('-').map(Number);
  const cles = Array.from({ length: 6 }, (_, i) => new Date(Date.UTC(a, m - 6 + i, 1)).toISOString().slice(0, 7));
  return { mois, moisCourant, cles, ids: await Patiente.distinct('_id', filtre) };
}

/** Réponse d'une analyse mensuelle : `compter(cle)` donne le nombre de femmes du mois `cle`. */
function reponseMensuelle({ mois, moisCourant, cles }, lignes) {
  return {
    mois,
    moisCourant,
    historique: { cles, mois: cles.map((cle) => `${MOIS_COURTS[+cle.slice(5) - 1]} ${cle.slice(2, 4)}`) },
    lignes: lignes.map(({ compter, ...ligne }) => {
      const valeurs = cles.map(compter);
      return { ...ligne, n: valeurs[5], precedent: valeurs[4], valeurs };
    }),
  };
}

/**
 * CPN1 à CPN4 d'un mois : femmes distinctes ayant fait la visite de ce rang dans le mois,
 * mois précédent et historique de 6 mois.
 */
exports.cpnMensuel = async (req, res) => {
  const fenetre = await fenetreMensuelle(req);
  // Toutes les CPN de la grossesse comptent pour le rang, même celles antérieures à la fenêtre.
  const cpn = await Consultation.find({ patienteId: { $in: fenetre.ids }, statut: 'Finalisée', type: { $in: TYPES_CPN } })
    .select('patienteId grossesseId date').lean();
  const { rang } = rangsCpn(cpn);
  res.json(reponseMensuelle(fenetre, [1, 2, 3, 4].map((n) => ({
    code: `CPN${n}`, libelle: `CPN${n}`, compter: (cle) => femmesCpnDuMois(cpn, rang, n, cle),
  }))));
};

/**
 * Analyse mensuelle de mesures préventives de la fiche CPN : femmes distinctes dont la mesure a
 * été cochée « Oui » pour la première fois de la grossesse sur une consultation finalisée du mois
 * (une mesure recochée aux visites suivantes n'est pas recomptée).
 */
function mesuresMensuelles(codes) {
  const mesures = MESURES_PREVENTIVES.filter((m) => codes.includes(m.code));
  const champs = mesures.map((m) => `mesuresPreventives.${m.code}.reponse`).join(' ');
  return async (req, res) => {
    const fenetre = await fenetreMensuelle(req);
    const consultations = await Consultation.find({ patienteId: { $in: fenetre.ids }, statut: 'Finalisée' })
      .select(`patienteId grossesseId date ${champs}`).sort({ date: 1 }).lean();
    // Mois de la première consultation où chaque mesure est cochée, par grossesse.
    const premiere = new Map(mesures.map((m) => [m.code, new Map()]));
    for (const c of consultations) {
      for (const { code } of mesures) {
        const parGrossesse = premiere.get(code);
        const k = id(c.grossesseId);
        if (c.mesuresPreventives?.[code]?.reponse === true && !parGrossesse.has(k)) {
          parGrossesse.set(k, { patienteId: id(c.patienteId), mois: jourKinshasa(c.date).slice(0, 7) });
        }
      }
    }
    res.json(reponseMensuelle(fenetre, mesures.map(({ code, libelle, groupe, repere }) => ({
      code, libelle, groupe, repere: repere ?? '',
      compter: (cle) => new Set([...premiere.get(code).values()].filter((d) => d.mois === cle).map((d) => d.patienteId)).size,
    }))));
  };
}

/** VAT 1 à 5 et SP (TPI) 1 à 3 du mois. */
exports.preventionsMensuel = mesuresMensuelles(['vat1', 'vat2', 'vat3', 'vat4', 'vat5', 'sp1', 'sp2', 'sp3']);
/** MILD, micronutriments, mébendazole et conseil DCIP (PTME) du mois. */
exports.preventionMensuel = mesuresMensuelles(['mild', 'micronutriments', 'mebendazole', 'dcip']);

/**
 * Échographies 1, 2 et 3 d'un mois : rang de chaque échographie dans sa grossesse (ordre de date,
 * puis d'enregistrement) ; femmes distinctes dont l'échographie de ce rang est datée du mois.
 */
exports.echographiesMensuel = async (req, res) => {
  const fenetre = await fenetreMensuelle(req);
  // Toutes les échographies de la grossesse comptent pour le rang, même antérieures à la fenêtre.
  const echos = await Echographie.find({ patienteId: { $in: fenetre.ids } }).select('patienteId grossesseId date createdAt').lean();
  const parGrossesse = new Map();
  for (const e of echos) {
    const k = id(e.grossesseId);
    if (!parGrossesse.has(k)) parGrossesse.set(k, []);
    parGrossesse.get(k).push(e);
  }
  const rang = new Map();
  for (const liste of parGrossesse.values()) {
    liste.sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt).forEach((e, i) => rang.set(e, i + 1));
  }
  res.json(reponseMensuelle(fenetre, [1, 2, 3].map((n) => ({
    code: `echo${n}`, libelle: `Écho ${n}`,
    compter: (cle) => new Set(echos.filter((e) => rang.get(e) === n && e.date.startsWith(cle)).map((e) => id(e.patienteId))).size,
  }))));
};

/** Résultat de TDR noté positif (texte libre : « Positif », « + », « pos »…), jamais s'il dit négatif. */
const tdrPositif = (resultat) => /posit|^\s*pos\b|\+/i.test(resultat) && !/n[ée]gat|^\s*n[ée]g\b/i.test(resultat);

/**
 * TDR palu d'un mois : femmes distinctes avec un résultat de TDR palu noté sur une consultation
 * finalisée du mois (un TDR peut être refait à chaque visite : chaque mois compte), et parmi
 * elles celles dont un résultat est noté positif.
 */
exports.tdrPaluMensuel = async (req, res) => {
  const fenetre = await fenetreMensuelle(req);
  const debut = instantJour(`${fenetre.cles[0]}-01`);
  const consultations = await Consultation.find({
    patienteId: { $in: fenetre.ids }, statut: 'Finalisée', date: { $gte: debut }, 'laboratoire.tdrPalu': { $nin: [null, ''] },
  }).select('patienteId date laboratoire.tdrPalu').lean();
  const tests = consultations.map((c) => ({
    patienteId: id(c.patienteId), mois: jourKinshasa(c.date).slice(0, 7), positif: tdrPositif(c.laboratoire.tdrPalu),
  }));
  const femmes = (cle, garder) => new Set(tests.filter((t) => t.mois === cle && garder(t)).map((t) => t.patienteId)).size;
  res.json(reponseMensuelle(fenetre, [
    { code: 'tdrPalu', libelle: 'TDR palu réalisé', groupe: 'Laboratoire', repere: '', compter: (cle) => femmes(cle, () => true) },
    { code: 'tdrPaluPositif', libelle: 'TDR palu positif', groupe: 'Laboratoire', repere: '', compter: (cle) => femmes(cle, (t) => t.positif) },
  ]));
};

const SEUIL_PREMATURE_JOURS = 37 * 7;
/** Issue de grossesse écrite par un dossier d'accouchement (controllers/accouchements.js). */
const ISSUE_DE_DOSSIER = /^Dossier d’accouchement /;
const aDomicile = (lieu) => /domicile|maison/i.test(lieu || '');
const ECLAMPSIE = /[ée]clamp/i;
const DECES = /d[ée]c[èe]s|d[ée]c[ée]d/i;

/**
 * Module Accouchement d'un mois (20 indicateurs) : dossiers d'accouchement de la plateforme datés
 * du mois (heure de naissance) et accouchements hors plateforme déclarés (issue de grossesse
 * « Naissance vivante » / « Mort-né » sans dossier, ou enfant enregistré « Né hors plateforme »).
 * Nombres et taux par mois ; un taux dont le dénominateur est nul vaut null (« N/A »).
 * Éclampsie et décès maternel n'ont pas de champ dédié : repérés dans les textes saisis.
 */
exports.accouchementsMensuel = async (req, res) => {
  const fenetre = await fenetreMensuelle(req);
  const debutJour = `${fenetre.cles[0]}-01`;
  const debut = instantJour(debutJour);
  const ids = { $in: fenetre.ids };
  const [dossiers, grossesses, enfants, referencesCpn] = await Promise.all([
    Accouchement.find({ patienteId: ids, 'accouchement.heure': { $gte: debut } })
      .select('grossesseId admission.motif examenClinique.conclusion surveillances.affection surveillances.incident evacuation accouchement postPartum.sortie.observations postPartum.surveillances.observations').lean(),
    Grossesse.find({ patienteId: ids }).select('datation issue').lean(),
    Enfant.find({ mereId: ids, neLe: { $gte: debut } }).select('mereId grossesseId accouchementId origine lieuNaissance etatNaissance neLe dateNaissance').lean(),
    Consultation.find({ patienteId: ids, statut: 'Finalisée', 'reference.motifs.0': { $exists: true }, date: { $gte: debut } }).select('date').lean(),
  ]);
  const grossesseDe = new Map(grossesses.map((g) => [id(g._id), g]));
  const premature = (gid, jourIso) => {
    const d = grossesseDe.get(id(gid))?.datation;
    if (!d) return false;
    return d.agReferenceJours + Math.round((Date.parse(`${jourIso}T00:00:00Z`) - Date.parse(`${d.dateReference}T00:00:00Z`)) / JOUR) < SEUIL_PREMATURE_JOURS;
  };

  // Un accouchement par dossier (structure) ou par grossesse / naissance déclarée hors plateforme.
  const accouchements = dossiers.map((a) => {
    const jourAcc = jourKinshasa(a.accouchement.heure);
    const issue = grossesseDe.get(id(a.grossesseId))?.issue;
    const textes = [a.admission?.motif, a.examenClinique?.conclusion, a.accouchement.indicationCesarienne, a.evacuation?.motif, issue?.complications,
      ...(a.surveillances ?? []).flatMap((s) => [s.affection, s.incident])].filter(Boolean).join(' ');
    const textesMere = [a.postPartum?.sortie?.observations, issue?.complications, issue?.orientation,
      ...(a.postPartum?.surveillances ?? []).map((s) => s.observations)].filter(Boolean).join(' ');
    const d = a.accouchement.delivrance ?? {};
    const hpp = d.hemorragie === 'Pathologique' || d.pertesSangMl > HEMORRAGIE_PHYSIOLOGIQUE_MAX_ML;
    const eclampsie = ECLAMPSIE.test(textes);
    const deces = DECES.test(textesMere);
    return {
      mois: jourAcc.slice(0, 7), dossier: true, structure: true, domicile: false,
      assiste: !!(a.accouchement.accoucheur || '').trim(),
      cesarienne: a.accouchement.mode === 'Césarienne', voieBasse: a.accouchement.mode !== 'Césarienne',
      premature: premature(a.grossesseId, jourAcc), hpp, eclampsie, deces,
      complication: hpp || eclampsie || deces || a.accouchement.dechirure?.degre >= 3 || !!a.evacuation || !!(issue?.complications || '').trim(),
    };
  });
  // Hors plateforme : lieu déclaré (domicile, autre structure ou inconnu), aucun détail clinique.
  const horsPlateforme = (jourIso, lieu, mode, gid) => accouchements.push({
    mois: jourIso.slice(0, 7), dossier: false, structure: !!(lieu || '').trim() && !aDomicile(lieu), domicile: aDomicile(lieu),
    assiste: false, cesarienne: mode === 'Césarienne', voieBasse: /^Voie basse/.test(mode || ''),
    premature: gid ? premature(gid, jourIso) : false, hpp: false, eclampsie: false, deces: false, complication: false,
  });
  const declarees = new Set();
  for (const g of grossesses) {
    const i = g.issue;
    if (!i || i.date < debutJour || !['Naissance vivante', 'Mort-né'].includes(i.issue) || ISSUE_DE_DOSSIER.test(i.resume || '')) continue;
    declarees.add(id(g._id));
    horsPlateforme(i.date, i.lieu, i.mode, g._id);
  }
  const naissancesHors = new Set();
  for (const e of enfants) {
    if (e.origine !== 'Né hors plateforme' || e.accouchementId || (e.grossesseId && declarees.has(id(e.grossesseId)))) continue;
    const cle = e.grossesseId ? id(e.grossesseId) : `${id(e.mereId)}|${e.dateNaissance}`;
    if (naissancesHors.has(cle)) continue; // jumeaux : un seul accouchement
    naissancesHors.add(cle);
    horsPlateforme(e.dateNaissance, e.lieuNaissance, '', e.grossesseId);
  }

  // Naissances : enfants enregistrés (toutes origines) et mort-nés déclarés sans dossier d'enfant.
  const naissances = enfants.map((e) => ({ mois: moisDe(e.neLe), vivant: e.etatNaissance === 'Vivant' }));
  const avecEnfant = new Set(enfants.map((e) => id(e.grossesseId)).filter(Boolean));
  for (const g of grossesses) {
    if (declarees.has(id(g._id)) && g.issue.issue === 'Mort-né' && !avecEnfant.has(id(g._id))) naissances.push({ mois: g.issue.date.slice(0, 7), vivant: false });
  }

  const duMois = (cle) => accouchements.filter((a) => a.mois === cle);
  const compte = (cle, garder) => duMois(cle).filter(garder).length;
  const vivants = (cle) => naissances.filter((n) => n.mois === cle && n.vivant).length;
  const mortNes = (cle) => naissances.filter((n) => n.mois === cle && !n.vivant).length;
  const references = (cle) => dossiers.filter((a) => a.evacuation?.le && moisDe(a.evacuation.le) === cle).length
    + referencesCpn.filter((c) => moisDe(c.date) === cle).length;
  const ratio = (num, den, facteur) => (den ? Math.round((num / den) * facteur * 10) / 10 : null);
  const ligne = (code, libelle, groupe, unite, compter, extra = {}) => ({ code, libelle, groupe, unite, repere: '', compter, ...extra });
  const ACC = 'Accouchements';
  const NAIS = 'Naissances';
  const COMP = 'Complications et références';
  const TAUX = 'Taux';

  res.json(reponseMensuelle(fenetre, [
    ligne('accTotal', 'Accouchements enregistrés', ACC, 'accouchement(s)', (c) => duMois(c).length, { repere: 'Structure et hors plateforme' }),
    ligne('accAssistes', 'Assistés par un personnel qualifié', ACC, 'accouchement(s)', (c) => compte(c, (a) => a.assiste), { repere: 'Accoucheur renseigné' }),
    ligne('accVoieBasse', 'Par voie basse', ACC, 'accouchement(s)', (c) => compte(c, (a) => a.voieBasse), { repere: 'Instrumentale comprise' }),
    ligne('accCesarienne', 'Par césarienne', ACC, 'accouchement(s)', (c) => compte(c, (a) => a.cesarienne)),
    ligne('accDomicile', 'À domicile (déclarés)', ACC, 'accouchement(s)', (c) => compte(c, (a) => a.domicile), { sens: 'baisse' }),
    ligne('accStructure', 'En structure sanitaire', ACC, 'accouchement(s)', (c) => compte(c, (a) => a.structure)),
    ligne('accPrematures', 'Accouchements prématurés', ACC, 'accouchement(s)', (c) => compte(c, (a) => a.premature), { repere: 'Moins de 37 SA (grossesse datée)', sens: 'baisse' }),
    ligne('naisVivantes', 'Naissances vivantes', NAIS, 'naissance(s)', vivants),
    ligne('naisMortNes', 'Mort-nés', NAIS, 'naissance(s)', mortNes, { sens: 'baisse' }),
    ligne('compMaternelles', 'Complications maternelles', COMP, 'cas', (c) => compte(c, (a) => a.complication), { repere: 'HPP, éclampsie, déchirure 3e-4e degré, évacuation…', sens: 'baisse' }),
    ligne('compHpp', 'Hémorragies du postpartum', COMP, 'cas', (c) => compte(c, (a) => a.hpp), { repere: `Délivrance pathologique ou > ${HEMORRAGIE_PHYSIOLOGIQUE_MAX_ML} ml`, sens: 'baisse' }),
    ligne('compEclampsie', 'Éclampsie / prééclampsie sévère', COMP, 'cas', (c) => compte(c, (a) => a.eclampsie), { repere: 'Repérée dans les textes du dossier', sens: 'baisse' }),
    ligne('compReferences', 'Références obstétricales', COMP, 'référence(s)', references, { repere: 'Évacuations et références CPN' }),
    ligne('compContreReferences', 'Contre-références obstétricales', COMP, 'retour(s)', () => null, { repere: 'Non enregistrée dans la plateforme' }),
    ligne('compDeces', 'Décès maternels', COMP, 'décès', (c) => compte(c, (a) => a.deces), { repere: 'Repérés dans les observations de la mère', sens: 'baisse' }),
    ligne('tauxAssistes', 'Taux d’accouchements assistés', TAUX, '%', (c) => ratio(compte(c, (a) => a.assiste), duMois(c).length, 100), { repere: 'Assistés ÷ accouchements' }),
    ligne('tauxCesariennes', 'Taux de césariennes', TAUX, '%', (c) => ratio(compte(c, (a) => a.cesarienne), duMois(c).length, 100), { repere: 'Césariennes ÷ accouchements' }),
    ligne('tauxComplications', 'Taux de complications obstétricales', TAUX, '%', (c) => ratio(compte(c, (a) => a.complication), compte(c, (a) => a.dossier), 100), { repere: 'Complications ÷ accouchements de la structure', sens: 'baisse' }),
    ligne('tauxMortinatalite', 'Taux de mortinatalité', TAUX, '‰', (c) => ratio(mortNes(c), vivants(c) + mortNes(c), 1000), { repere: 'Mort-nés ÷ naissances × 1000', sens: 'baisse' }),
    ligne('tauxMortaliteMaternelle', 'Taux de mortalité maternelle', TAUX, 'pour 100 000 NV', (c) => ratio(compte(c, (a) => a.deces), vivants(c), 100000), { repere: 'Décès ÷ naissances vivantes × 100 000', sens: 'baisse' }),
  ]));
};

/** Doses comptées une à une dans le module Vaccination (enfants ayant reçu la dose dans le mois). */
const DOSES_VACCINATION = ['bcg', 'vpo0', 'penta1', 'penta2', 'penta3', 'vpo1', 'vpo2', 'vpo3', 'pcv1', 'pcv2', 'pcv3'];
/** Couverture par antigène : enfants ayant reçu la dose ÷ enfants en âge de l'avoir reçue (dose échue ou faite). */
const COUVERTURE_VACCINATION = ['bcg', 'penta1', 'penta3', 'vpo3', 'pcv3', 'rota3', 'var1', 'vaa'];
const DOSE_ECHUE = ['En retard', 'Hors délai'];

/**
 * Module Vaccination d'un mois (28 indicateurs) — enfants nés vivants, ni décédés ni transférés.
 *   - Activité du mois : doses administrées (saisies non annulées) datées du mois, enfants distincts ;
 *   - État à la fin du mois (ou aujourd'hui pour le mois en cours) : carnet recalculé avec les seules
 *     doses faites à cette date (à jour, zéro dose, sous-vaccinés, abandons, couverture, achèvement) ;
 *   - Relance : tâches RECO du domaine Vaccination (contact établi, réintégration confirmée).
 */
exports.vaccinationMensuel = async (req, res) => {
  const fenetre = await fenetreMensuelle(req);
  const debut = instantJour(`${fenetre.cles[0]}-01`);
  const auj = jourKinshasa(new Date());
  const enfants = (await Enfant.find({ mereId: { $in: fenetre.ids }, etatNaissance: 'Vivant' })
    .select('mereId dateNaissance etatNaissance statut vaccinations createdAt')).filter((e) => e.estSuivi());
  const idsEnfants = enfants.map((e) => e._id);
  const [taches, rdvs] = await Promise.all([
    TacheRelance.find({ domaine: 'Vaccination', enfantId: { $in: idsEnfants }, $or: [{ contactEtabliLe: { $gte: debut } }, { statutLe: { $gte: debut } }] })
      .select('enfantId statut statutLe contactEtabliLe').lean(),
    RendezVous.find({ enfantId: { $in: idsEnfants }, date: { $gte: debut, $lt: new Date() }, statut: { $nin: ['Effectué', 'Annulé'] } }).select('date').lean(),
  ]);
  const vaccins = new Set(vaccination.CALENDRIER.filter((d) => d.type === 'Vaccin').map((d) => d.code));
  const requisComplet = vaccination.CALENDRIER.filter((d) => d.type === 'Vaccin' && d.seance !== '15 mois').map((d) => d.code);
  const doses = enfants.map((e) => ({ e, faites: e.vaccinationsValides().filter((v) => vaccins.has(v.code)) }));
  // Carnet actuel (toutes les doses) : dates prévues pour les doses manquées.
  const carnetsActuels = new Map(enfants.map((e) => [e.id, e.carnet(auj)]));

  // État de chaque enfant à la fin de chaque mois de la fenêtre (calculé une fois par mois).
  const etats = new Map();
  const etatDu = (cle) => {
    if (etats.has(cle)) return etats.get(cle);
    const [a, m] = cle.split('-').map(Number);
    const fin = [new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10), auj].sort()[0];
    const liste = enfants.filter((e) => e.dateNaissance <= fin && jourKinshasa(e.createdAt) <= fin).map((e) => {
      const carnet = vaccination.calendrier(e.dateNaissance, e.vaccinationsValides().filter((v) => v.date <= fin), fin);
      const statut = new Map(carnet.doses.map((d) => [d.code, d.statut]));
      const vaccinsCarnet = carnet.doses.filter((d) => vaccins.has(d.code));
      const ageMois = (Date.parse(fin) - Date.parse(e.dateNaissance)) / (30.44 * JOUR);
      return {
        statut,
        aJour: vaccinsCarnet.every((d) => ['Faite', 'À venir'].includes(d.statut)),
        sousVaccine: vaccinsCarnet.some((d) => DOSE_ECHUE.includes(d.statut)),
        penta3Echue: statut.get('penta1') === 'Faite' && !['À venir', 'À faire'].includes(statut.get('penta3')),
        complet: carnet.resume.completementVaccine,
        cohorte12a23: ageMois >= 12 && ageMois < 24,
      };
    });
    etats.set(cle, liste);
    return liste;
  };
  const enEtat = (cle, garder) => etatDu(cle).filter(garder).length;

  const moisDose = (v) => v.date.slice(0, 7);
  const enfantsAyantRecu = (cle, garder) => doses.filter(({ faites }) => faites.some((v) => moisDose(v) === cle && garder(v))).length;
  const recu = (code) => (cle) => enfantsAyantRecu(cle, (v) => v.code === code);
  // Calendrier terminé : dernière dose requise (vaccins jusqu'à 9 mois) faite dans le mois.
  const terminePar = doses.map(({ e, faites }) => {
    const dates = requisComplet.map((code) => faites.find((v) => v.code === code)?.date);
    return dates.every(Boolean) ? dates.sort().at(-1).slice(0, 7) : null;
  });
  // Doses manquées : échéance (date prévue + tolérance) dans le mois, non faite à l'échéance.
  const manquees = [];
  for (const e of enfants) {
    for (const d of carnetsActuels.get(e.id)?.doses ?? []) {
      if (!vaccins.has(d.code)) continue;
      const echeance = new Date(Date.parse(d.datePrevue) + vaccination.TOLERANCE_JOURS * JOUR).toISOString().slice(0, 10);
      if (echeance >= auj || (d.administration && d.administration.date <= echeance)) continue;
      manquees.push(echeance.slice(0, 7));
    }
  }
  const tachesDuMois = (cle, garder) => new Set(taches.filter((t) => garder(t, cle)).map((t) => id(t.enfantId))).size;
  const retrouves = (cle) => tachesDuMois(cle, (t, c) => t.contactEtabliLe && moisDe(t.contactEtabliLe) === c);
  const reintegres = (cle) => tachesDuMois(cle, (t, c) => t.statut === 'Réintégration confirmée' && moisDe(t.statutLe) === c);
  const clotureesSans = (cle) => tachesDuMois(cle, (t, c) => t.statut === 'Clôturée sans réintégration' && moisDe(t.statutLe) === c);
  const zeroDose = (x) => DOSE_ECHUE.includes(x.statut.get('penta1'));
  const abandon = (x) => x.penta3Echue && x.statut.get('penta3') !== 'Faite';
  const libelleDose = (code) => vaccination.PAR_CODE.get(code).libelle;
  const ligne = (code, libelle, groupe, unite, compter, extra = {}) => ({ code, libelle, groupe, unite, repere: '', compter, ...extra });
  const ACT = 'Enfants vaccinés dans le mois';
  const ETAT = 'Statut vaccinal (fin du mois)';
  const REL = 'Relance et suivi';
  const COUV = 'Couverture par antigène';
  const TAUX = 'Taux';

  res.json(reponseMensuelle(fenetre, [
    ligne('vacEnfants', 'Enfants enregistrés en vaccination', ETAT, 'enfant(s)', (c) => etatDu(c).length, { repere: 'Suivis à la fin du mois' }),
    ...DOSES_VACCINATION.map((code) => ligne(`vac_${code}`, `Ont reçu le ${libelleDose(code)}`, ACT, 'enfant(s)', recu(code))),
    ligne('vacRota', 'Antirotavirus selon le calendrier', ACT, 'enfant(s)', recu('rota3'), { repere: 'Série complète (Rota 3) reçue' }),
    ligne('vacRougeole', 'Rougeole selon le calendrier', ACT, 'enfant(s)', (c) => doses.filter(({ e, faites }) => faites.some((v) => v.code === 'var1' && moisDose(v) === c
      && v.date >= vaccination.dateAge(e.dateNaissance, { mois: 9 }))).length, { repere: 'RR1 reçu à 9 mois ou plus' }),
    ligne('vacAJour', 'À jour pour leur âge', ETAT, 'enfant(s)', (c) => enEtat(c, (x) => x.aJour), { repere: 'Tous les vaccins échus faits' }),
    ligne('vacZeroDose', 'Enfants zéro dose', ETAT, 'enfant(s)', (c) => enEtat(c, zeroDose), { repere: 'Penta1 échu non reçu', sens: 'baisse' }),
    ligne('vacSousVaccines', 'Enfants sous-vaccinés', ETAT, 'enfant(s)', (c) => enEtat(c, (x) => x.sousVaccine), { repere: 'Au moins un vaccin en retard', sens: 'baisse' }),
    ligne('vacAbandons', 'Abandons de la vaccination', ETAT, 'enfant(s)', (c) => enEtat(c, abandon), { repere: 'Penta1 reçu, Penta3 échu non reçu', sens: 'baisse' }),
    ligne('vacRetrouves', 'Retrouvés par les RECO', REL, 'enfant(s)', retrouves, { repere: 'Contact établi (relance vaccination)' }),
    ligne('vacReintegres', 'Réintégrés dans le calendrier', REL, 'enfant(s)', reintegres, { repere: 'Réintégration confirmée' }),
    ligne('vacTermines', 'Calendrier vaccinal terminé', REL, 'enfant(s)', (c) => terminePar.filter((m) => m === c).length, { repere: 'Dernier vaccin jusqu’à 9 mois reçu' }),
    ligne('vacDoses', 'Doses administrées', REL, 'dose(s)', (c) => doses.reduce((s, { faites }) => s + faites.filter((v) => moisDose(v) === c).length, 0), { repere: 'Vaccins (hors vitamine A, mébendazole)' }),
    ligne('vacDosesManquees', 'Doses manquées', REL, 'dose(s)', (c) => manquees.filter((m) => m === c).length, { repere: `Non faites ${vaccination.TOLERANCE_JOURS} j après la date prévue`, sens: 'baisse' }),
    ligne('vacRdvManques', 'Rendez-vous vaccinaux manqués', REL, 'rendez-vous', (c) => rdvs.filter((r) => moisDe(r.date) === c).length, { repere: 'Passés, ni effectués ni annulés', sens: 'baisse' }),
    ...COUVERTURE_VACCINATION.map((code) => ligne(`couv_${code}`, `Couverture ${libelleDose(code)}`, COUV, '%', (c) => {
      const eligibles = etatDu(c).filter((x) => !['À venir', 'À faire', undefined].includes(x.statut.get(code)));
      return taux(eligibles.filter((x) => x.statut.get(code) === 'Faite').length, eligibles.length);
    }, { repere: 'Reçu ÷ en âge de l’avoir reçu' })),
    ligne('tauxAbandonPenta', 'Taux d’abandon Penta1-Penta3', TAUX, '%', (c) => taux(enEtat(c, abandon), enEtat(c, (x) => x.penta3Echue)), { repere: 'Sans Penta3 ÷ Penta1 reçu, Penta3 échu', sens: 'baisse' }),
    ligne('tauxReintegration', 'Taux de réintégration vaccinale', TAUX, '%', (c) => taux(reintegres(c), reintegres(c) + clotureesSans(c)), { repere: 'Réintégrés ÷ relances clôturées' }),
    ligne('tauxAchevement', 'Taux d’achèvement du calendrier', TAUX, '%', (c) => taux(enEtat(c, (x) => x.cohorte12a23 && x.complet), enEtat(c, (x) => x.cohorte12a23)), { repere: 'Complètement vaccinés ÷ enfants de 12 à 23 mois' }),
  ]));
};

/** Premier instant du mois `cle` (AAAA-MM) et du mois suivant, à Kinshasa. */
const bornesMois = (cle) => {
  const [a, m] = cle.split('-').map(Number);
  return [instantJour(`${cle}-01`), instantJour(new Date(Date.UTC(a, m, 1)).toISOString().slice(0, 10))];
};

/**
 * Tâches de relance de l'établissement de connexion utiles à la fenêtre mensuelle (hors doublons
 * annulés), avec leurs actions et visites. Bénéficiaire : personne relancée (patiente, enfant ou
 * personne déclarée) ; ménage : la mère (patiente ou mère de l'enfant), ou le foyer déclaré (nom et
 * quartier). Avec un filtre province / aire de santé, seules les tâches des patientes retenues (et
 * de leurs enfants) comptent.
 */
async function relanceMensuelle(req, fenetre, filtreTache = {}) {
  const debut = instantJour(`${fenetre.cles[0]}-01`);
  const filtre = !!(req.query.province || req.query.aire);
  const [tachesToutes, enfants] = await Promise.all([
    TacheRelance.find({
      ...filtreTerritoire(req), ...filtreTache, statut: { $ne: 'Doublon annulé' },
      $or: [{ ouverte: true }, { statutLe: { $gte: debut } }, { createdAt: { $gte: debut } }, { 'confirmation.le': { $gte: debut } }],
    }).select('personneType source patienteId enfantId declaree recoId ouverte statut statutLe createdAt contactEtabliLe '
      + 'actions.type actions.resultat actions.le actions.par.id actions.conflit visites orientation.le confirmation.le resolution.le').lean(),
    Enfant.find({ mereId: { $in: fenetre.ids } }).select('mereId').lean(),
  ]);
  const mereDe = new Map(enfants.map((e) => [id(e._id), id(e.mereId)]));
  const retenues = new Set(fenetre.ids.map(id));
  const taches = tachesToutes.filter((t) => !filtre || retenues.has(id(t.patienteId)) || mereDe.has(id(t.enfantId)));
  const beneficiaire = (t) => (t.enfantId ? `E:${id(t.enfantId)}` : t.patienteId ? `P:${id(t.patienteId)}` : `D:${t.declaree?.nom ?? ''}|${t.declaree?.quartier ?? ''}`.toLowerCase());
  return {
    taches,
    beneficiaire,
    menage: (t) => (t.patienteId ? `P:${id(t.patienteId)}` : t.enfantId ? `P:${mereDe.get(id(t.enfantId)) ?? id(t.enfantId)}` : beneficiaire(t)),
    actions: taches.flatMap((t) => (t.actions ?? []).filter((a) => !a.conflit).map((a) => ({ ...a, t, mois: moisDe(a.le) }))),
    visites: taches.flatMap((t) => (t.visites ?? []).map((v) => ({ ...v, mois: moisDe(v.prevueLe) }))),
    /** Tâches actives pendant le mois : créées avant sa fin, encore ouvertes à son début. */
    actives: (cle) => {
      const [d, f] = bornesMois(cle);
      return taches.filter((t) => t.createdAt < f && (t.ouverte || (t.resolution?.le ?? t.statutLe) >= d));
    },
  };
}

const distincts = (liste, cle) => new Set(liste.map(cle)).size;

/**
 * Module communautaire RECO d'un mois — A. indicateurs transversaux (12) : RECO et tâches de
 * relance de l'établissement de connexion (voir relanceMensuelle) ; avec un filtre d'aire de
 * santé, les RECO de l'aire choisie.
 */
exports.recoMensuel = async (req, res) => {
  const fenetre = await fenetreMensuelle(req);
  const maintenant = new Date();
  const aire = req.query.aire ? texte(req.query.aire, 120) : '';
  const [recos, relance] = await Promise.all([
    Reco.find({ ...filtreTerritoire(req), ...(aire ? { aireSante: aire } : {}) }).select('createdAt').lean(),
    relanceMensuelle(req, fenetre),
  ]);
  const { taches, beneficiaire, menage, actions, visites } = relance;
  const bornes = bornesMois;
  // Tâches suivies par un RECO pendant le mois : actives et attribuées.
  const suivies = (cle) => relance.actives(cle).filter((t) => t.recoId);
  const realisees = (cle) => actions.filter((a) => a.mois === cle && a.type === 'visite_realisee');
  const planifieesEchues = (cle) => visites.filter((v) => v.mois === cle && v.prevueLe < maintenant);
  const ligne = (code, libelle, groupe, unite, compter, extra = {}) => ({ code, libelle, groupe, unite, repere: '', compter, ...extra });
  const RECO = 'RECO et bénéficiaires';
  const VIS = 'Visites à domicile';
  const REF = 'Retrouvés et références';

  res.json(reponseMensuelle(fenetre, [
    ligne('recoEnregistres', 'RECO enregistrés', RECO, 'RECO', (c) => recos.filter((r) => r.createdAt < bornes(c)[1]).length, { repere: 'Comptes créés à la fin du mois' }),
    ligne('recoActifs', 'RECO actifs', RECO, 'RECO', (c) => distincts(actions.filter((a) => a.mois === c && a.par?.id), (a) => a.par.id), { repere: 'Au moins une action dans le mois' }),
    ligne('recoMenages', 'Ménages suivis', RECO, 'ménage(s)', (c) => distincts(suivies(c), menage), { repere: 'Foyer de la mère ou foyer déclaré' }),
    ligne('recoBeneficiaires', 'Bénéficiaires suivis', RECO, 'personne(s)', (c) => distincts(suivies(c), beneficiaire), { repere: 'Relance attribuée à un RECO' }),
    ligne('recoVisitesRealisees', 'Visites réalisées', VIS, 'visite(s)', (c) => realisees(c).length),
    ligne('recoVisitesPlanifiees', 'Visites planifiées', VIS, 'visite(s)', (c) => visites.filter((v) => v.mois === c).length, { repere: 'Prévues dans le mois' }),
    ligne('recoVisitesNonRealisees', 'Visites non réalisées', VIS, 'visite(s)', (c) => planifieesEchues(c).filter((v) => !v.realiseeLe).length, { repere: 'Date prévue passée, sans visite', sens: 'baisse' }),
    ligne('recoAbsents', 'Bénéficiaires absents lors des visites', VIS, 'personne(s)', (c) => distincts(realisees(c).filter((a) => a.resultat === 'Absente du domicile'), (a) => beneficiaire(a.t)), { sens: 'baisse' }),
    ligne('recoRetrouves', 'Bénéficiaires retrouvés', REF, 'personne(s)', (c) => distincts(taches.filter((t) => t.contactEtabliLe && moisDe(t.contactEtabliLe) === c), beneficiaire), { repere: 'Contact établi dans le mois' }),
    ligne('recoReferences', 'Références communautaires', REF, 'référence(s)', (c) => taches.filter((t) => t.orientation?.le && moisDe(t.orientation.le) === c).length, { repere: 'Orientations vers une structure' }),
    ligne('recoReferesRecus', 'Référés effectivement reçus', REF, 'personne(s)', (c) => distincts(taches.filter((t) => t.orientation && t.confirmation?.le && moisDe(t.confirmation.le) === c), beneficiaire), { repere: 'Venue confirmée par la structure' }),
    ligne('recoTauxVisites', 'Taux de réalisation des visites', 'Taux', '%', (c) => taux(planifieesEchues(c).filter((v) => v.realiseeLe).length, planifieesEchues(c).length), { repere: 'Visites prévues réalisées ÷ prévues échues' }),
  ]));
};

/**
 * Lignes de chaque parcours de relance (B. RAC, C. ARC, D. RPC, E. IRC, F. TCC), calculées sur les
 * mesures communes `m` du mois `c`. « Cas » : tâches ; « bénéficiaires », « femmes » : personnes
 * distinctes. Les définitions opérationnelles sont celles des fiches de paramétrage des parcours.
 */
const LIGNES_PARCOURS = {
  RAC: (m) => [
    m.ligne('racAbandons', 'Femmes identifiées en abandon de CPN', 'Identification', 'femme(s)', (c) => m.personnes(m.identifiees(c).filter((t) => t.source !== 'RECO' && t.personneType === 'Patiente')), { repere: 'Relances détectées dans le mois' }),
    m.ligne('racJamaisCpn', 'Jamais commencé la CPN, identifiées par les RECO', 'Identification', 'femme(s)', (c) => m.personnes(m.identifiees(c).filter((t) => (t.source === 'RECO' || t.personneType === 'Déclarée') && !m.cpnAvant(t))), { repere: 'Signalées par un RECO, sans CPN' }),
    m.ligne('racARelancer', 'Femmes à relancer', 'Identification', 'femme(s)', (c) => m.personnes(m.actives(c)), { repere: 'Relance active dans le mois' }),
    m.ligne('racContactees', 'Femmes contactées', 'Relance', 'femme(s)', (c) => m.personnes(m.contactees(c)), { repere: 'Appel ou visite tenté' }),
    m.ligne('racRetrouvees', 'Femmes retrouvées', 'Relance', 'femme(s)', (c) => m.personnes(m.retrouvees(c)), { repere: 'Contact établi dans le mois' }),
    m.ligne('racSensibilisees', 'Femmes sensibilisées', 'Relance', 'femme(s)', (c) => m.personnes(m.jointes(c)), { repere: 'Jointe ou rencontrée par le RECO' }),
    m.ligne('racOrientees', 'Orientées vers une structure', 'Relance', 'femme(s)', (c) => m.personnes(m.orientees(c))),
    m.ligne('racRevenues', 'Femmes revenues en CPN', 'Issue', 'femme(s)', (c) => m.personnes(m.reintegrees(c)), { repere: 'Retour confirmé par la structure' }),
    m.ligne('racPerdues', 'Femmes toujours perdues de vue', 'Issue', 'femme(s)', (c) => m.personnes(m.perdues(c)), { repere: 'Non retrouvée ou clôturée sans retour', sens: 'baisse' }),
    m.ligne('racTauxRelance', 'Taux de relance', 'Taux', '%', (c) => taux(m.personnes(m.contactees(c)), m.personnes(m.actives(c))), { repere: 'Contactées ÷ à relancer' }),
    m.ligne('racTauxReintegration', 'Taux de réintégration CPN', 'Taux', '%', (c) => taux(m.personnes(m.reintegrees(c)), m.personnes(m.actives(c))), { repere: 'Revenues ÷ à relancer' }),
    m.ligne('racTauxAbandon', 'Taux d’abandon CPN', 'Taux', '%', (c) => taux(m.personnes(m.identifiees(c).filter((t) => t.source !== 'RECO' && t.personneType === 'Patiente')), m.femmesEnCpn(c)), { repere: 'Abandons identifiés ÷ femmes en suivi CPN', sens: 'baisse' }),
  ],
  ARC: (m) => [
    m.ligne('arcIdentifies', 'Cas identifiés (définition ARC)', 'Cas', 'cas', (c) => m.identifiees(c).length, { repere: m.definition }),
    m.ligne('arcAContacter', 'Cas à contacter', 'Cas', 'cas', (c) => m.aContacter(c).length, { repere: 'Actifs, sans contact au début du mois' }),
    m.ligne('arcContactes', 'Cas contactés', 'Suivi', 'cas', (c) => m.contactees(c).length),
    m.ligne('arcRetrouves', 'Cas retrouvés', 'Suivi', 'cas', (c) => m.retrouvees(c).length),
    m.ligne('arcOrientes', 'Cas orientés', 'Suivi', 'cas', (c) => m.orientees(c).length),
    m.ligne('arcIntervention', 'Cas ayant bénéficié d’une intervention', 'Suivi', 'cas', (c) => m.intervention(c).length, { repere: 'Contact, visite ou orientation' }),
    m.ligne('arcResolus', 'Cas résolus', 'Issue', 'cas', (c) => m.reintegrees(c).length, { repere: 'Réintégration confirmée' }),
    m.ligne('arcNonResolus', 'Cas non résolus', 'Issue', 'cas', (c) => m.sansReintegration(c).length, { repere: 'Clôturés sans réintégration', sens: 'baisse' }),
    m.ligne('arcTauxResolution', 'Taux de résolution', 'Taux', '%', (c) => taux(m.reintegrees(c).length, m.reintegrees(c).length + m.sansReintegration(c).length), { repere: 'Résolus ÷ cas clôturés' }),
    m.ligne('arcTauxSuivi', 'Taux de suivi des cas', 'Taux', '%', (c) => taux(m.contactees(c).length, m.aContacter(c).length), { repere: 'Contactés ÷ à contacter' }),
  ],
  RPC: (m) => [
    m.ligne('rpcIdentifies', 'Cas identifiés (définition RPC)', 'Cas', 'cas', (c) => m.identifiees(c).length, { repere: m.definition }),
    m.ligne('rpcConcernes', 'Bénéficiaires concernés', 'Cas', 'personne(s)', (c) => m.personnes(m.actives(c)), { repere: 'Relance active dans le mois' }),
    m.ligne('rpcContactes', 'Bénéficiaires contactés', 'Suivi', 'personne(s)', (c) => m.personnes(m.contactees(c))),
    m.ligne('rpcVisites', 'Visites réalisées', 'Suivi', 'visite(s)', (c) => m.visitesRealisees(c)),
    m.ligne('rpcReferences', 'Références effectuées', 'Suivi', 'référence(s)', (c) => m.orientees(c).length),
    m.ligne('rpcPrisEnCharge', 'Bénéficiaires pris en charge', 'Issue', 'personne(s)', (c) => m.personnes(m.confirmees(c)), { repere: 'Venue confirmée par la structure' }),
    m.ligne('rpcClotures', 'Cas clôturés', 'Issue', 'cas', (c) => m.cloturees(c).length),
    m.ligne('rpcEnAttente', 'Cas en attente', 'Issue', 'cas', (c) => m.enAttente(c).length, { repere: 'Ouverts à la fin du mois' }),
    m.ligne('rpcTauxPriseEnCharge', 'Taux de prise en charge', 'Taux', '%', (c) => taux(m.personnes(m.confirmees(c)), m.personnes(m.actives(c))), { repere: 'Pris en charge ÷ concernés' }),
    m.ligne('rpcTauxCloture', 'Taux de clôture des cas', 'Taux', '%', (c) => taux(m.cloturees(c).length, m.actives(c).length), { repere: 'Clôturés ÷ cas actifs du mois' }),
  ],
  IRC: (m) => [
    m.ligne('ircIdentifies', 'Cas identifiés (définition IRC)', 'Cas', 'cas', (c) => m.identifiees(c).length, { repere: m.definition }),
    m.ligne('ircConcernes', 'Bénéficiaires concernés', 'Cas', 'personne(s)', (c) => m.personnes(m.actives(c)), { repere: 'Relance active dans le mois' }),
    m.ligne('ircContactes', 'Bénéficiaires contactés', 'Suivi', 'personne(s)', (c) => m.personnes(m.contactees(c))),
    m.ligne('ircRetrouves', 'Bénéficiaires retrouvés', 'Suivi', 'personne(s)', (c) => m.personnes(m.retrouvees(c))),
    m.ligne('ircOrientes', 'Bénéficiaires orientés', 'Suivi', 'personne(s)', (c) => m.personnes(m.orientees(c))),
    m.ligne('ircReintegres', 'Bénéficiaires réintégrés', 'Issue', 'personne(s)', (c) => m.personnes(m.reintegrees(c)), { repere: 'Réintégration confirmée' }),
    m.ligne('ircSuivis', 'Cas suivis', 'Issue', 'cas', (c) => m.suivis(c).length, { repere: 'Au moins une action du RECO' }),
    m.ligne('ircClotures', 'Cas clôturés', 'Issue', 'cas', (c) => m.cloturees(c).length),
    m.ligne('ircTauxReintegration', 'Taux de réintégration', 'Taux', '%', (c) => taux(m.personnes(m.reintegrees(c)), m.personnes(m.actives(c))), { repere: 'Réintégrés ÷ concernés' }),
    m.ligne('ircTauxSuivi', 'Taux de suivi des cas', 'Taux', '%', (c) => taux(m.suivis(c).length, m.actives(c).length), { repere: 'Cas suivis ÷ cas actifs du mois' }),
  ],
  TCC: (m) => [
    m.ligne('tccIdentifies', 'Cas identifiés (définition TCC)', 'Cas', 'cas', (c) => m.identifiees(c).length, { repere: m.definition }),
    m.ligne('tccConcernes', 'Bénéficiaires concernés', 'Cas', 'personne(s)', (c) => m.personnes(m.actives(c)), { repere: 'Relance active dans le mois' }),
    m.ligne('tccContactes', 'Bénéficiaires contactés', 'Suivi', 'personne(s)', (c) => m.personnes(m.contactees(c))),
    m.ligne('tccVisites', 'Visites effectuées', 'Suivi', 'visite(s)', (c) => m.visitesRealisees(c)),
    m.ligne('tccOrientes', 'Bénéficiaires orientés', 'Suivi', 'personne(s)', (c) => m.personnes(m.orientees(c))),
    m.ligne('tccSuivis', 'Bénéficiaires ayant bénéficié d’un suivi', 'Suivi', 'personne(s)', (c) => m.personnes(m.intervention(c)), { repere: 'Contact, visite ou orientation' }),
    m.ligne('tccResolus', 'Cas résolus', 'Issue', 'cas', (c) => m.reintegrees(c).length, { repere: 'Réintégration confirmée' }),
    m.ligne('tccEnAttente', 'Cas en attente', 'Issue', 'cas', (c) => m.enAttente(c).length, { repere: 'Ouverts à la fin du mois' }),
    m.ligne('tccTauxResolution', 'Taux de résolution', 'Taux', '%', (c) => taux(m.reintegrees(c).length, m.cloturees(c).length), { repere: 'Résolus ÷ cas clôturés' }),
    m.ligne('tccTauxSuivi', 'Taux de suivi', 'Taux', '%', (c) => taux(m.personnes(m.intervention(c)), m.personnes(m.actives(c))), { repere: 'Suivis ÷ concernés' }),
  ],
};
const ACTIONS_CONTACT = ['tentative', 'visite_realisee'];
const CLOTURES_VALIDES = ['Réintégration confirmée', 'Clôturée sans réintégration'];

/**
 * Parcours de relance d'un mois (tâches dont le parcoursCode est `code`) : mesures communes datées
 * de l'action (contact, visite, orientation, confirmation, clôture), puis lignes du parcours.
 */
const parcoursMensuel = (code) => async (req, res) => {
  const fenetre = await fenetreMensuelle(req);
  const [relance, fiche] = await Promise.all([
    relanceMensuelle(req, fenetre, { parcoursCode: code }),
    ParcoursRelance.findOne({ code }).select('statut libelle').lean(),
  ]);
  const { taches, beneficiaire, actions } = relance;
  // RAC : CPN finalisées des patientes (jamais commencé la CPN, femmes en suivi CPN).
  const cpn = code === 'RAC'
    ? await Consultation.find({ patienteId: { $in: fenetre.ids }, statut: 'Finalisée', type: { $in: TYPES_CPN } }).select('patienteId grossesseId date').lean()
    : [];
  const grossesses = code === 'RAC' ? await Grossesse.find({ patienteId: { $in: fenetre.ids } }).select('patienteId statut createdAt issue.date').lean() : [];
  const dansMois = (d, c) => !!d && moisDe(d) === c;
  const clotureLe = (t) => (t.ouverte ? null : t.resolution?.le ?? t.statutLe);
  const tachesAvecAction = (c, garder) => {
    const ids_ = new Set(actions.filter((a) => a.mois === c && garder(a)).map((a) => a.t));
    return taches.filter((t) => ids_.has(t));
  };
  const m = {
    definition: fiche?.statut === 'Validé' ? 'Définition validée (fiche du parcours)' : 'Définition à valider (fiche du parcours)',
    ligne: (code_, libelle, groupe, unite, compter, extra = {}) => ({ code: code_, libelle, groupe, unite, repere: '', compter, ...extra }),
    personnes: (liste) => distincts(liste, beneficiaire),
    actives: relance.actives,
    identifiees: (c) => taches.filter((t) => dansMois(t.createdAt, c)),
    contactees: (c) => tachesAvecAction(c, (a) => ACTIONS_CONTACT.includes(a.type)),
    jointes: (c) => tachesAvecAction(c, (a) => RESULTATS_CONTACT.includes(a.resultat)),
    suivis: (c) => tachesAvecAction(c, () => true),
    intervention: (c) => [...new Set([...tachesAvecAction(c, (a) => RESULTATS_CONTACT.includes(a.resultat) || a.type === 'orientation'), ...m.orientees(c)])],
    visitesRealisees: (c) => actions.filter((a) => a.mois === c && a.type === 'visite_realisee').length,
    retrouvees: (c) => taches.filter((t) => dansMois(t.contactEtabliLe, c)),
    orientees: (c) => taches.filter((t) => dansMois(t.orientation?.le, c)),
    confirmees: (c) => taches.filter((t) => dansMois(t.confirmation?.le, c)),
    reintegrees: (c) => taches.filter((t) => t.statut === 'Réintégration confirmée' && dansMois(t.confirmation?.le ?? clotureLe(t), c)),
    sansReintegration: (c) => taches.filter((t) => t.statut === 'Clôturée sans réintégration' && dansMois(clotureLe(t), c)),
    perdues: (c) => taches.filter((t) => (t.statut === 'Non retrouvée' && dansMois(t.statutLe, c)) || (t.statut === 'Clôturée sans réintégration' && dansMois(clotureLe(t), c))),
    cloturees: (c) => taches.filter((t) => CLOTURES_VALIDES.includes(t.statut) && dansMois(clotureLe(t), c)),
    enAttente: (c) => {
      const fin = bornesMois(c)[1];
      return taches.filter((t) => t.createdAt < fin && (t.ouverte || clotureLe(t) >= fin));
    },
    aContacter: (c) => {
      const debut = bornesMois(c)[0];
      return relance.actives(c).filter((t) => !t.contactEtabliLe || t.contactEtabliLe >= debut);
    },
    cpnAvant: (t) => !!t.patienteId && cpn.some((x) => id(x.patienteId) === id(t.patienteId) && x.date < t.createdAt),
    /** Femmes dont une grossesse est en cours pendant le mois, avec au moins une CPN avant sa fin. */
    femmesEnCpn: (c) => {
      const [debut, fin] = bornesMois(c);
      const enCours = grossesses.filter((g) => g.createdAt < fin && (g.statut === 'En cours' || (g.issue?.date && instantJour(g.issue.date) >= debut)));
      return new Set(enCours.filter((g) => cpn.some((x) => id(x.grossesseId) === id(g._id) && x.date < fin)).map((g) => id(g.patienteId))).size;
    },
  };
  res.json({ ...reponseMensuelle(fenetre, LIGNES_PARCOURS[code](m)), parcours: { code, libelle: fiche?.libelle ?? '', statut: fiche?.statut ?? 'À valider' } });
};

exports.racMensuel = parcoursMensuel('RAC');
exports.arcMensuel = parcoursMensuel('ARC');
exports.rpcMensuel = parcoursMensuel('RPC');
exports.ircMensuel = parcoursMensuel('IRC');
exports.tccMensuel = parcoursMensuel('TCC');

/** Soins essentiels du nouveau-né (SENN) : tous notés « Oui ». */
const soinsEssentiels = (n = {}) => n.senn?.maintienTemperature === true && n.senn?.crede === true && n.miseAuSeinMoins1h === true
  && n.traitement?.vitamineK1 === true && (n.soinsCordon?.lameSterile === true || n.soinsCordon?.filSterile === true);

/**
 * Module Nouveau-né et suivi postnatal d'un mois (14 indicateurs) : cohorte des enfants nés vivants
 * dans le mois (toutes origines), rattachée à son mois de naissance. Consultations postnatales
 * (CPoN) : visites de suivi de l'enfant et consultations « Postnatal » de la mère dans les 42 jours,
 * une par jour ; la k-ième est la CPoN k. Une CPoN est attendue quand son délai (J3, J7, 6 semaines)
 * est écoulé ou qu'elle a déjà été faite. Décès et référence n'ont ni date ni motif : statut seul.
 */
exports.nouveauNesMensuel = async (req, res) => {
  const fenetre = await fenetreMensuelle(req);
  const debut = instantJour(`${fenetre.cles[0]}-01`);
  const ids = { $in: fenetre.ids };
  const enfants = await Enfant.find({ mereId: ids, neLe: { $gte: debut }, etatNaissance: 'Vivant' })
    .select('mereId grossesseId sexe neLe dateNaissance statut naissance suivis.date').lean();
  const [grossesses, postnatales] = await Promise.all([
    Grossesse.find({ _id: { $in: enfants.map((e) => e.grossesseId).filter(Boolean) } }).select('datation').lean(),
    Consultation.find({ patienteId: { $in: enfants.map((e) => e.mereId) }, statut: 'Finalisée', type: 'Postnatal', date: { $gte: debut } })
      .select('patienteId grossesseId date').lean(),
  ]);
  const datationDe = new Map(grossesses.map((g) => [id(g._id), g.datation]));
  const auj = jourKinshasa(new Date());
  const ecartJours = (de, a) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / JOUR);
  const limites = [PARAMETRES.cpon1Jours, PARAMETRES.cpon2Jours, PARAMETRES.cpon3Jours];

  const cohorte = enfants.map((e) => {
    const d = datationDe.get(id(e.grossesseId));
    const ag = d ? d.agReferenceJours + ecartJours(d.dateReference, e.dateNaissance) : null;
    const dansFenetre = (jourIso) => { const j = ecartJours(e.dateNaissance, jourIso); return j >= 0 && j <= PARAMETRES.cpon3Jours; };
    const jours = new Set([
      ...(e.suivis ?? []).map((s) => s.date),
      ...postnatales.filter((c) => id(c.patienteId) === id(e.mereId) && (!e.grossesseId || id(c.grossesseId) === id(e.grossesseId))).map((c) => jourKinshasa(c.date)),
    ].filter(dansFenetre));
    const realisees = Math.min(jours.size, limites.length);
    const age = ecartJours(e.dateNaissance, auj);
    return {
      mois: jourKinshasa(e.neLe).slice(0, 7), sexe: e.sexe, poids: e.naissance?.poidsG ?? null,
      premature: ag != null && ag < SEUIL_PREMATURE_JOURS, senn: soinsEssentiels(e.naissance),
      realisees, attendues: limites.filter((l, i) => i < realisees || age > l).length,
      fenetreEcoulee: age > PARAMETRES.cpon3Jours,
      refere: e.statut === 'Transféré', decede: e.statut === 'Décédé',
    };
  });

  const duMois = (cle) => cohorte.filter((e) => e.mois === cle);
  const compte = (cle, garder) => duMois(cle).filter(garder).length;
  const somme = (cle, champ) => duMois(cle).reduce((s, e) => s + e[champ], 0);
  const faiblePoids = (e) => e.poids != null && e.poids < PARAMETRES.faiblePoidsG;
  const complet = (e) => e.realisees >= limites.length;
  const ligne = (code, libelle, groupe, unite, compter, extra = {}) => ({ code, libelle, groupe, unite, repere: '', compter, ...extra });
  const NN = 'Nouveau-nés';
  const CPON = 'Suivi postnatal';
  const REF = 'Références et décès';
  const TAUX = 'Taux';

  res.json(reponseMensuelle(fenetre, [
    ligne('nnTotal', 'Nouveau-nés enregistrés', NN, 'nouveau-né(s)', (c) => duMois(c).length, { repere: 'Nés vivants dans le mois' }),
    ligne('nnMasculin', 'Sexe masculin', NN, 'nouveau-né(s)', (c) => compte(c, (e) => e.sexe === 'Masculin')),
    ligne('nnFeminin', 'Sexe féminin', NN, 'nouveau-né(s)', (c) => compte(c, (e) => e.sexe === 'Féminin')),
    ligne('nnFaiblePoids', 'Faible poids de naissance', NN, 'nouveau-né(s)', (c) => compte(c, faiblePoids), { repere: `Moins de ${PARAMETRES.faiblePoidsG} g`, sens: 'baisse' }),
    ligne('nnPrematures', 'Prématurés', NN, 'nouveau-né(s)', (c) => compte(c, (e) => e.premature), { repere: 'Moins de 37 SA (grossesse datée)', sens: 'baisse' }),
    ligne('nnSoinsEssentiels', 'Soins essentiels reçus', NN, 'nouveau-né(s)', (c) => compte(c, (e) => e.senn), { repere: 'Température, cordon, sein < 1 h, Crédé, vitamine K1' }),
    ligne('cponNouveauNes', 'Nouveau-nés vus en CPoN', CPON, 'nouveau-né(s)', (c) => compte(c, (e) => e.realisees > 0), { repere: `Au moins une CPoN dans les ${PARAMETRES.cpon3Jours} j` }),
    ligne('cponAttendues', 'CPoN attendues', CPON, 'consultation(s)', (c) => somme(c, 'attendues'), { repere: `J${PARAMETRES.cpon1Jours}, J${PARAMETRES.cpon2Jours}, 6 semaines (délai écoulé)` }),
    ligne('cponRealisees', 'CPoN réalisées', CPON, 'consultation(s)', (c) => somme(c, 'realisees'), { repere: 'Suivi de l’enfant ou CPoN de la mère' }),
    ligne('nnReferes', 'Nouveau-nés référés', REF, 'nouveau-né(s)', (c) => compte(c, (e) => e.refere), { repere: 'Statut « Transféré » (date non enregistrée)' }),
    ligne('nnDeces', 'Décès néonatals', REF, 'décès', (c) => compte(c, (e) => e.decede), { repere: 'Statut « Décédé » (date non enregistrée)', sens: 'baisse' }),
    ligne('tauxCpon', 'Taux de réalisation des CPoN', TAUX, '%', (c) => taux(somme(c, 'realisees'), somme(c, 'attendues')), { repere: 'CPoN réalisées ÷ attendues' }),
    ligne('tauxFaiblePoids', 'Taux de faible poids de naissance', TAUX, '%', (c) => taux(compte(c, faiblePoids), compte(c, (e) => e.poids != null)), { repere: 'Faible poids ÷ nouveau-nés pesés', sens: 'baisse' }),
    ligne('tauxSuiviComplet', 'Taux de suivi postnatal complet', TAUX, '%', (c) => taux(compte(c, complet), compte(c, (e) => complet(e) || e.fenetreEcoulee)), { repere: `3 CPoN ÷ nouveau-nés de plus de ${PARAMETRES.cpon3Jours} j` }),
  ]));
};
