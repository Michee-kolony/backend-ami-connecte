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
const { jourKinshasa } = require('../config/vaccination');
const { ALERTES, MOTIF_RECO } = require('../config/relance');
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
  const cpnComplete = (c) => c.constantes?.poidsKg != null && c.constantes?.taSystolique != null && c.constantes?.taDiastolique != null && !!c.prochainRdv?.date;
  const references = cs.filter((c) => dansPeriode(c.date) && c.reference?.motifs?.length);
  const cpnModule = [
    nombre('CPN_INSCRITES', new Set(gr.filter((g) => dansPeriode(g.createdAt)).map((g) => id(g.patienteId))).size, { lien: '/admin/patientes' }),
    nombre('CPN_CPN1', new Set(cpnPeriode.filter((c) => c.type === 'Première consultation prénatale').map((c) => id(c.patienteId))).size, { lien: '/admin/patientes' }),
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
  const cpnParGrossesse = new Map();
  for (const c of cpn) cpnParGrossesse.set(id(c.grossesseId), [...(cpnParGrossesse.get(id(c.grossesseId)) ?? []), c]);
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
