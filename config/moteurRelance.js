// Moteur de la relance communautaire (sections 4, 5 et 10 de la spécification) :
//   1. détection   : chaque règle active parcourt les rendez-vous, grossesses, naissances et doses ;
//   2. vérification: prestation déjà enregistrée, dossier archivé, motif déjà traité → aucune tâche ;
//   3. création    : une tâche par parcours et par personne (les autres motifs y sont reliés) ;
//   4. attribution : au RECO actif de la structure dont le secteur couvre le quartier, le moins chargé ;
//   + confirmation : une prestation enregistrée dans le dossier de soins par un soignant confirme la
//                    réintégration (jamais la seule déclaration du RECO) ;
//   + alertes      : échéance proche, retard, urgence non prise, orientation non confirmée.
// Vérifié toutes les 30 minutes (RELANCE_INTERVALLE_MIN). Les règles inactives ou non validées
// ne produisent rien : rien n'est déclenché avant validation des protocoles.
const RendezVous = require('../models/RendezVous');
const Grossesse = require('../models/Grossesse');
const Consultation = require('../models/Consultation');
const Accouchement = require('../models/Accouchement');
const Enfant = require('../models/Enfant');
const Patiente = require('../models/Patiente');
const Reco = require('../models/Reco');
const TacheRelance = require('../models/TacheRelance');
const AlerteRelance = require('../models/AlerteRelance');
const RegleRelance = require('../models/RegleRelance');
const ParcoursRelance = require('../models/ParcoursRelance');
const presence = require('./presence');
const { jourKinshasa } = require('./vaccination');
const r = require('./relance');

const { JOUR, AUTEUR_SYSTEME } = r;
const ORDRE_PRIORITE = Object.fromEntries(r.PRIORITES.map((p, i) => [p, i]));
const plusHaute = (a, b) => (ORDRE_PRIORITE[b] > ORDRE_PRIORITE[a] ? b : a);
const dateFr = (d) => new Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Kinshasa', day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
const debutJour = (jour) => new Date(`${jour}T00:00:00+01:00`);

// --- Paramétrage --------------------------------------------------------------------------

/** Crée les fiches initiales (5 parcours à valider, règles inactives) si elles n'existent pas. */
async function initialiserParametrage() {
  const le = new Date();
  for (const code of r.CODES_PARCOURS) {
    await ParcoursRelance.updateOne(
      { code },
      { $setOnInsert: { code, libelle: code, version: 1, statut: 'À valider', modifiePar: AUTEUR_SYSTEME, modifieLe: le } },
      { upsert: true },
    );
  }
  for (const regle of r.REGLES_INITIALES) {
    await RegleRelance.updateOne(
      { code: regle.code },
      { $setOnInsert: { ...regle, version: 1, statut: 'Inactive', modifiePar: AUTEUR_SYSTEME, modifieLe: le } },
      { upsert: true },
    );
  }
}

/** Règles applicables aujourd'hui : actives, en vigueur, rattachées à un parcours validé. */
async function reglesEnVigueur(jour) {
  const regles = await RegleRelance.find({ statut: 'Active' });
  const parcours = new Map((await ParcoursRelance.find({ code: { $in: regles.map((x) => x.parcoursCode) } })).map((p) => [p.code, p]));
  return regles
    .filter((x) => !x.dateEffet || x.dateEffet <= jour)
    .map((regle) => ({ regle, parcours: parcours.get(regle.parcoursCode) }))
    .filter(({ parcours: p }) => p?.enVigueur(jour));
}

// --- Alertes ------------------------------------------------------------------------------

/**
 * Ajoute des tâches à l'alerte ouverte du même type pour ce destinataire (regroupement), ou
 * l'ouvre. Le personnel connecté est prévenu en temps réel.
 */
async function alerter(type, { recoId = null, etablissementId = null, taches = [] }, le = new Date()) {
  const { destinataire } = r.ALERTES[type];
  const filtre = { type, destinataire, recoId: recoId ?? null, etablissementId: etablissementId ?? null, ouverte: true };
  const maj = {
    $addToSet: { taches: { $each: taches } },
    $set: { derniereLe: le },
    $setOnInsert: { premiereLe: le },
  };
  let alerte;
  try {
    alerte = await AlerteRelance.findOneAndUpdate(filtre, { ...maj, $inc: { occurrences: 1 } }, { upsert: true, returnDocument: 'after' });
  } catch (err) {
    // Deux serveurs ouvrent la même alerte au même instant : l'un des deux gagne, l'autre la complète.
    if (err.code !== 11000) throw err;
    alerte = await AlerteRelance.findOneAndUpdate(filtre, { ...maj, $inc: { occurrences: 1 } }, { returnDocument: 'after' });
  }
  if (destinataire !== 'reco') presence.emettrePersonnel('relance:alerte', { type, etablissementId, taches });
  return alerte;
}

// --- Attribution --------------------------------------------------------------------------

/** Nombre de tâches ouvertes de chaque RECO (charge active). */
async function chargeDes(recoIds) {
  const lignes = await TacheRelance.aggregate([
    { $match: { recoId: { $in: recoIds }, ouverte: true } },
    { $group: { _id: '$recoId', n: { $sum: 1 } } },
  ]);
  return new Map(lignes.map((l) => [String(l._id), l.n]));
}

/**
 * RECO responsable du secteur : actif, rattaché à la structure, dont les zones couvrent le
 * quartier de la personne (sinon la même aire de santé) ; à égalité, le moins chargé.
 */
async function choisirReco({ etablissementId, zone, aireSante }) {
  if (!etablissementId) return null;
  const recos = await Reco.find({ statut: 'Actif', etablissementId }).select('+zonesNormalisees');
  const z = Reco.normaliserZone(zone);
  const a = Reco.normaliserZone(aireSante);
  let candidats = z ? recos.filter((x) => x.zonesNormalisees.includes(z)) : [];
  if (!candidats.length && a) candidats = recos.filter((x) => Reco.normaliserZone(x.aireSante) === a && !x.zones.length);
  if (!candidats.length) return null;
  const charge = await chargeDes(candidats.map((x) => x._id));
  return candidats.sort((x, y) => (charge.get(x.id) ?? 0) - (charge.get(y.id) ?? 0) || x.matricule.localeCompare(y.matricule))[0];
}

/** Attribue (ou réattribue) la tâche à un RECO ; l'historique garde l'ancien RECO. */
function attribuer(tache, reco, par, { motif = '', le = new Date() } = {}) {
  const ancien = tache.recoId ? String(tache.recoId) : null;
  if (ancien && ancien !== reco.id) tache.reattributions += 1;
  tache.recoId = reco._id;
  tache.superviseurId = reco.superviseurId ?? tache.superviseurId;
  tache.attribueeLe = le;
  const statut = ['Nouvelle', 'Attribuée'].includes(tache.statut) || ancien !== reco.id ? 'Attribuée' : tache.statut;
  tache.changerStatut(statut, par, {
    action: ancien && ancien !== reco.id ? 'Réattribution' : 'Attribution', motif, le,
    details: { reco: reco.matricule, ancienReco: ancien },
  });
}

// --- Détection ----------------------------------------------------------------------------

/** Rendez-vous CPN passés au-delà de la tolérance, sans consultation ni rendez-vous effectué depuis. */
async function* candidatsCpn({ parametres: p }, maintenant) {
  const rdvs = await RendezVous.find({
    enfantId: null, grossesseId: { $ne: null }, statut: { $in: [...RendezVous.STATUTS_ACTIFS, 'Absent'] },
    date: { $gte: new Date(maintenant - p.fenetreJours * JOUR), $lt: new Date(maintenant - p.toleranceJours * JOUR) },
  });
  for (const rdv of rdvs) {
    const grossesse = await Grossesse.findById(rdv.grossesseId).select('statut');
    if (grossesse?.statut !== 'En cours') continue;
    // Prestation déjà enregistrée (consultation à partir de la veille du rendez-vous) : pas de relance.
    const depuis = new Date(rdv.date.getTime() - JOUR);
    if (await Consultation.exists({ patienteId: rdv.patienteId, statut: { $ne: 'Annulée' }, date: { $gte: depuis } })) continue;
    if (await RendezVous.exists({ patienteId: rdv.patienteId, enfantId: null, statut: 'Effectué', date: { $gt: rdv.date } })) continue;
    yield {
      cle: `CPN_RDV_MANQUE:${rdv.id}`, personneType: 'Patiente', patienteId: rdv.patienteId, grossesseId: rdv.grossesseId,
      etablissementId: rdv.etablissementId, dateEvenement: rdv.date,
      objet: { type: 'Rendez-vous', id: rdv.id, libelle: `${rdv.motif} du ${dateFr(rdv.date)}` },
    };
  }
}

/** Grossesses en cours dont la DPA retenue est dépassée, sans issue ni dossier d'accouchement. */
async function* candidatsAccouchement({ parametres: p }, maintenant) {
  const grossesses = await Grossesse.find({
    statut: 'En cours', issue: null,
    'datation.dpa': { $gte: jourKinshasa(new Date(maintenant - p.fenetreJours * JOUR)), $lte: jourKinshasa(new Date(maintenant - p.toleranceJours * JOUR)) },
  });
  for (const g of grossesses) {
    if (await Accouchement.exists({ grossesseId: g._id })) continue;
    yield {
      cle: `ACC_ISSUE_INCONNUE:${g.id}`, personneType: 'Patiente', patienteId: g.patienteId, grossesseId: g._id,
      dateEvenement: debutJour(g.datation.dpa),
      objet: { type: 'Grossesse', id: g.id, libelle: `DPA retenue le ${g.datation.dpa.split('-').reverse().join('/')}` },
    };
  }
}

/** Nouveau-nés sans visite de suivi ni consultation postnatale de la mère après la tolérance. */
async function* candidatsPostnatal({ parametres: p }, maintenant) {
  const enfants = await Enfant.find({
    etatNaissance: 'Vivant', statut: 'Suivi', 'suivis.0': { $exists: false },
    dateNaissance: { $gte: jourKinshasa(new Date(maintenant - p.fenetreJours * JOUR)), $lte: jourKinshasa(new Date(maintenant - p.toleranceJours * JOUR)) },
  });
  for (const e of enfants) {
    if (await Consultation.exists({ patienteId: e.mereId, type: 'Postnatal', statut: { $ne: 'Annulée' }, date: { $gte: e.neLe } })) continue;
    yield {
      cle: `PN_VISITE_NON_DOCUMENTEE:${e.id}`, personneType: 'Enfant', patienteId: e.mereId, enfantId: e._id, grossesseId: e.grossesseId,
      etablissementId: e.etablissementId, dateEvenement: e.neLe,
      objet: { type: 'Naissance', id: e.id, libelle: `Naissance du ${dateFr(e.neLe)} (${e.numero})` },
    };
  }
}

/** Doses de vaccin attendues non documentées au-delà de la tolérance ; enfants zéro-dose. */
async function* candidatsVaccination({ parametres: p }, maintenant) {
  const jour = jourKinshasa(maintenant);
  const seuil = jourKinshasa(new Date(maintenant - p.toleranceJours * JOUR));
  const enfants = await Enfant.find({
    etatNaissance: 'Vivant', statut: 'Suivi', dateNaissance: { $gte: jourKinshasa(new Date(maintenant - p.fenetreJours * JOUR)) },
  });
  for (const e of enfants) {
    const carnet = e.carnet(jour);
    const attendues = carnet.doses
      .filter((d) => d.type === 'Vaccin' && ['À faire', 'En retard'].includes(d.statut) && d.datePrevue <= seuil)
      .sort((a, b) => a.datePrevue.localeCompare(b.datePrevue));
    if (!attendues.length) continue;
    const zeroDose = !carnet.doses.some((d) => d.type === 'Vaccin' && d.statut === 'Faite');
    yield {
      cle: `VAC_DOSE_NON_DOCUMENTEE:${e.id}:${attendues[0].code}`, personneType: 'Enfant', patienteId: e.mereId, enfantId: e._id,
      etablissementId: e.etablissementId, dateEvenement: debutJour(attendues[0].datePrevue),
      libelle: zeroDose ? 'Enfant zéro-dose : aucune dose de vaccin documentée' : null,
      priorite: zeroDose ? 'Prioritaire' : null,
      objet: { type: 'Dose', id: attendues[0].code, libelle: attendues.map((d) => d.libelle).join(', ') },
    };
  }
}

const GENERATEURS = {
  CPN_RDV_MANQUE: candidatsCpn,
  ACC_ISSUE_INCONNUE: candidatsAccouchement,
  PN_VISITE_NON_DOCUMENTEE: candidatsPostnatal,
  VAC_DOSE_NON_DOCUMENTEE: candidatsVaccination,
};

/** Clé de dédoublonnage d'une tâche : parcours + personne. */
const cleTache = (parcoursCode, c) => `${parcoursCode}:${c.personneType}:${String(c.enfantId ?? c.patienteId)}`;

/**
 * Crée la tâche, ou relie le motif à la tâche active du même parcours pour la même personne.
 * Renvoie 'creee', 'reliee' ou null (motif déjà traité, dossier non éligible).
 */
async function traiterCandidat(c, { regle, parcours }, maintenant) {
  if (await TacheRelance.exists({ clesMotifs: c.cle })) return null;
  const patiente = await Patiente.findById(c.patienteId).select('statut etablissementId adresse');
  if (!patiente || patiente.statut === 'Archivé') return null;
  const p = regle.parametres;
  const motif = {
    cle: c.cle, regleCode: regle.code, regleVersion: regle.version, libelle: c.libelle || regle.libelle,
    objet: c.objet, dateEvenement: c.dateEvenement, ajouteLe: maintenant,
  };
  const priorite = plusHaute(p.priorite, c.priorite || 'Normale');
  const cle = cleTache(parcours.code, c);

  for (let essai = 0; essai < 3; essai += 1) {
    const existante = await TacheRelance.findOne({ cle, ouverte: true });
    if (existante) {
      // Même personne, même parcours : un seul suivi, plusieurs motifs (pas de double compte).
      existante.motifs.push(motif);
      existante.clesMotifs.push(c.cle);
      existante.priorite = plusHaute(existante.priorite, priorite);
      existante.noter('Motif relié', AUTEUR_SYSTEME, { motif: motif.libelle, details: { regle: regle.code }, le: maintenant });
      await existante.save();
      return 'reliee';
    }
    const etablissementId = c.etablissementId || patiente.etablissementId || null;
    const tache = new TacheRelance({
      numero: await TacheRelance.prochainNumero(),
      parcoursCode: parcours.code, parcoursVersion: parcours.version, domaine: regle.domaine, source: 'Détection automatique',
      motifs: [motif], clesMotifs: [c.cle],
      personneType: c.personneType, patienteId: c.patienteId, enfantId: c.enfantId ?? null, grossesseId: c.grossesseId ?? null,
      cle, etablissementId, aireSante: patiente.adresse?.aireSante ?? '', zone: patiente.adresse?.quartier ?? '',
      priorite, parametres: p, dateEvenement: c.dateEvenement,
      echeance: new Date(maintenant.getTime() + p.delaiTraitementJours * JOUR),
      creePar: AUTEUR_SYSTEME,
    });
    tache.historique.push({ action: 'Création', nouveauStatut: 'Nouvelle', motif: motif.libelle, details: { regle: regle.code, version: regle.version }, par: AUTEUR_SYSTEME, le: maintenant });
    const reco = await choisirReco({ etablissementId, zone: tache.zone, aireSante: tache.aireSante });
    if (reco) attribuer(tache, reco, AUTEUR_SYSTEME, { le: maintenant });
    try {
      await tache.save();
    } catch (err) {
      // Numéro ou tâche active créés en parallèle : on recommence (la tâche active sera reliée).
      if (err.code === 11000) continue;
      throw err;
    }
    if (reco) await alerter('attribution', { recoId: reco._id, taches: [tache.numero] }, maintenant);
    else {
      await alerter('non_attribuee', { etablissementId, taches: [tache.numero] }, maintenant);
      await TacheRelance.updateOne({ _id: tache._id }, { 'alertes.nonAttribuee': maintenant });
    }
    return 'creee';
  }
  return null;
}

/** Parcourt les règles en vigueur ; renvoie le nombre de tâches créées et de motifs reliés. */
async function detecter(maintenant = new Date()) {
  const bilan = { creees: 0, reliees: 0, regles: 0 };
  for (const actif of await reglesEnVigueur(jourKinshasa(maintenant))) {
    const generer = GENERATEURS[actif.regle.code];
    if (!generer) continue;
    bilan.regles += 1;
    for await (const c of generer(actif.regle, maintenant)) {
      const resultat = await traiterCandidat(c, actif, maintenant);
      if (resultat === 'creee') bilan.creees += 1;
      if (resultat === 'reliee') bilan.reliees += 1;
    }
  }
  return bilan;
}

// --- Confirmation depuis le dossier de soins -----------------------------------------------

/** Prestation enregistrée par un soignant depuis l'événement attendu, ou null. */
async function prestationDe(tache) {
  const depuis = new Date(Math.min(...tache.motifs.map((m) => (m.dateEvenement ?? tache.createdAt).getTime())) - JOUR);
  if (tache.domaine === 'CPN') {
    const c = await Consultation.findOne({ patienteId: tache.patienteId, statut: 'Finalisée', date: { $gte: depuis } }).sort({ date: 1 });
    return c && { type: c.type, reference: `Consultation du ${dateFr(c.date)}`, par: c.auteur, le: c.date };
  }
  if (tache.domaine === 'Accouchement') {
    const acc = await Accouchement.findOne({ grossesseId: tache.grossesseId }).select('numero admission.admisePar admission.admiseLe');
    if (acc) return { type: 'Admission en salle de travail', reference: acc.numero, par: acc.admission.admisePar, le: acc.admission.admiseLe };
    const g = await Grossesse.findById(tache.grossesseId).select('issue');
    return g?.issue && { type: 'Issue de grossesse', reference: `${g.issue.issue} le ${g.issue.date.split('-').reverse().join('/')}`, par: g.issue.enregistreePar, le: g.issue.enregistreeLe };
  }
  if (tache.domaine === 'Postnatal') {
    const e = await Enfant.findById(tache.enfantId).select('numero suivis');
    const s = e?.suivis[0];
    if (s) return { type: 'Visite de suivi de l’enfant', reference: `${e.numero}, visite du ${s.date.split('-').reverse().join('/')}`, par: s.auteur, le: s.le };
    const c = await Consultation.findOne({ patienteId: tache.patienteId, type: 'Postnatal', statut: 'Finalisée', date: { $gte: depuis } });
    return c && { type: c.type, reference: `Consultation postnatale du ${dateFr(c.date)}`, par: c.auteur, le: c.date };
  }
  if (tache.domaine === 'Vaccination') {
    const e = await Enfant.findById(tache.enfantId).select('numero vaccinations');
    // Retour au circuit : la dose relancée, ou toute autre dose administrée depuis la date attendue.
    const codes = tache.motifs.map((m) => m.objet?.id);
    const jourDepuis = jourKinshasa(depuis);
    const v = e?.vaccinationsValides().find((x) => codes.includes(x.code) || x.date >= jourDepuis);
    return v && { type: 'Vaccination', reference: `${e.numero}, dose ${v.code} du ${v.date.split('-').reverse().join('/')}`, par: v.administreePar, le: v.le };
  }
  return null;
}

/** Enregistre la confirmation : la réintégration n'est comptée qu'à ce moment. */
function confirmer(tache, { source, type, reference, par, le = new Date() }) {
  tache.confirmation = { le, source, type, reference, avantContact: !tache.contactEtabliLe, par };
  tache.resolution = { statut: 'Réintégration confirmée', resultat: 'Réintégration confirmée', motif: `${type} : ${reference}`, le, par };
  tache.changerStatut('Réintégration confirmée', par, { action: 'Confirmation de la prestation', motif: `${source} — ${reference}`, le });
}

/** Tâches ouvertes dont la prestation est maintenant enregistrée dans le dossier de soins. */
async function verifierPrestations(maintenant = new Date()) {
  let confirmees = 0;
  const taches = await TacheRelance.find({ ouverte: true, personneType: { $ne: 'Déclarée' } });
  for (const t of taches) {
    const p = await prestationDe(t);
    if (!p) continue;
    confirmer(t, { source: 'Dossier de soins', type: p.type, reference: p.reference, par: p.par ?? AUTEUR_SYSTEME, le: maintenant });
    t.noter('Prestation détectée dans le dossier de soins', AUTEUR_SYSTEME, { le: maintenant });
    await t.save();
    confirmees += 1;
  }
  return confirmees;
}

// --- Alertes périodiques ------------------------------------------------------------------

/**
 * Marque l'alerte sur chaque tâche (une seule fois, même avec plusieurs serveurs) puis la
 * regroupe par destinataire.
 */
async function alerterTaches(type, champ, taches, destinataireDe, maintenant) {
  const groupes = new Map();
  for (const t of taches) {
    const { modifiedCount } = await TacheRelance.updateOne({ _id: t._id, [`alertes.${champ}`]: null }, { [`alertes.${champ}`]: maintenant });
    if (!modifiedCount) continue;
    const d = destinataireDe(t);
    const k = `${d.recoId ?? ''}|${d.etablissementId ?? ''}`;
    if (!groupes.has(k)) groupes.set(k, { ...d, taches: [] });
    groupes.get(k).taches.push(t.numero);
  }
  for (const g of groupes.values()) await alerter(type, g, maintenant);
  return [...groupes.values()].reduce((n, g) => n + g.taches.length, 0);
}

async function alertesPeriodiques(maintenant = new Date()) {
  const ouvertes = await TacheRelance.find({ ouverte: true }).select('numero recoId etablissementId statut priorite echeance attribueeLe createdAt orientation parametres alertes');
  const heures = (h) => h * 3600000;
  const supervision = (t) => ({ etablissementId: t.etablissementId });
  const n = { echeance: 0, retard: 0, urgentes: 0, orientations: 0 };
  n.echeance = await alerterTaches('echeance_proche', 'echeanceProche', ouvertes.filter((t) => t.recoId && r.STATUTS_RECO.includes(t.statut)
    && t.echeance >= maintenant && t.echeance - t.parametres.alerteAvantEcheanceJours * JOUR <= maintenant), (t) => ({ recoId: t.recoId }), maintenant);
  n.retard = await alerterTaches('retard', 'retard', ouvertes.filter((t) => t.echeance < maintenant), supervision, maintenant);
  n.urgentes = await alerterTaches('urgente_non_prise', 'urgenteNonPrise', ouvertes.filter((t) => t.priorite === 'Urgente'
    && ['Nouvelle', 'Attribuée'].includes(t.statut) && (t.attribueeLe ?? t.createdAt).getTime() + heures(t.parametres.priseEnChargeHeures) <= maintenant), supervision, maintenant);
  n.orientations = await alerterTaches('orientation_non_confirmee', 'orientationNonConfirmee', ouvertes.filter((t) => t.statut === 'Orientée'
    && t.orientation && t.orientation.le.getTime() + t.parametres.confirmationOrientationJours * JOUR <= maintenant),
  (t) => ({ etablissementId: t.orientation.etablissementId || t.etablissementId }), maintenant);
  return n;
}

// --- Tournée ------------------------------------------------------------------------------

/** Tournée complète : confirmation des prestations, détection, alertes. */
async function tourner(maintenant = new Date()) {
  const confirmees = await verifierPrestations(maintenant);
  const detection = await detecter(maintenant);
  const alertes = await alertesPeriodiques(maintenant);
  return { confirmees, ...detection, alertes };
}

function demarrer() {
  const minutes = Number(process.env.RELANCE_INTERVALLE_MIN) || 30;
  const tour = () => tourner().catch((err) => console.error('Relance communautaire :', err.message));
  initialiserParametrage()
    .then(() => setTimeout(tour, 90000))
    .catch((err) => console.error('Relance communautaire (paramétrage) :', err.message));
  return setInterval(tour, minutes * 60000);
}

module.exports = {
  initialiserParametrage, reglesEnVigueur, alerter, choisirReco, attribuer, detecter, verifierPrestations,
  prestationDe, confirmer, alertesPeriodiques, tourner, demarrer,
};
