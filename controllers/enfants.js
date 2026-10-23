const mongoose = require('mongoose');
const Enfant = require('../models/Enfant');
const Patiente = require('../models/Patiente');
const RendezVous = require('../models/RendezVous');
const { auteurDe } = require('../models/commun');
const { ROLES_MATERNITE } = require('../models/Soignant');
const { journaliser } = require('../config/audit');
const acc = require('../config/accouchement');
const vaccination = require('../config/vaccination');
const { verifierDoublon } = require('./rendezVous');
const { erreur, texte, nombre, instant, jour, T, N, B, lire, fusionner, valider, pasDansLeFutur } = require('./saisie');

const { STATUTS_ACTIFS, CANAUX_RAPPEL } = RendezVous;
const echapperRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Heure par défaut des séances de vaccination : 9 h à Kinshasa (8 h UTC). */
const HEURE_SEANCE_UTC = 'T08:00:00Z';

const APGAR = Object.fromEntries(acc.APGAR_CRITERES.map(({ code }) => [code, N]));
/** Module 5 — champs de la naissance acceptés depuis le formulaire. */
const SPEC_NAISSANCE = {
  senn: { maintienTemperature: B, temperatureAxillaire: N, crede: B },
  soinsCordon: { lameSterile: B, filSterile: B },
  miseAuSeinMoins1h: B,
  poidsG: N, tailleCm: N, perimetreCranienCm: N,
  malformations: { presentes: B, description: T(1000) },
  apgar: { m1: APGAR, m5: APGAR, m10: APGAR },
  reanimation: { faite: B, stimulation: B, aspiration: B, ventilation: B },
  traitement: { vitamineK1: B, antibiotique: B, antibiotiquePrecision: T(300), arv: B, arvPrecision: T(300) },
};
const SPEC_SUIVI = {
  poidsG: N, tailleCm: N, perimetreCranienCm: N, perimetreBrachialCm: N, temperature: N,
  alimentation: (v) => (Enfant.ALIMENTATIONS.includes(v) ? v : ''),
  developpement: T(1000), observations: T(2000),
};

async function trouverEnfant(id) {
  const e = /^AC-ENF-\d+$/.test(id) ? await Enfant.findOne({ numero: id })
    : mongoose.isValidObjectId(id) ? await Enfant.findById(id) : null;
  if (!e) throw erreur(404, 'Dossier de l’enfant introuvable.');
  return e;
}
exports.trouverEnfant = trouverEnfant;

/** Minuit (heure de Kinshasa) du jour en cours, en instant UTC. */
const debutDuJour = () => new Date(`${vaccination.jourKinshasa()}T00:00:00+01:00`);

/** Résumé d'un enfant pour les listes et le dossier de la mère. */
function resume(e) {
  const carnet = e.carnet();
  return {
    id: e.id, numero: e.numero, nom: e.nom, postnom: e.postnom, prenom: e.prenom, sexe: e.sexe,
    neLe: e.neLe, dateNaissance: e.dateNaissance, rang: e.rang, etatNaissance: e.etatNaissance, statut: e.statut,
    age: e.age(), mereId: e.mereId, accouchementId: e.accouchementId,
    vaccination: carnet ? { prochaineSeance: carnet.prochaineSeance, ...carnet.resume } : null,
  };
}
exports.resume = resume;

/**
 * Prochaine séance du calendrier : un rendez-vous est créé dans l'agenda (au nom de la mère,
 * marqué pour l'enfant) s'il n'y en a pas déjà un d'attendu.
 */
async function planifierProchaineVaccination(e, auteur, etablissementId) {
  if (!e.estSuivi()) return null;
  const seance = e.carnet().prochaineSeance;
  if (!seance) return null;
  const existant = await RendezVous.findOne({ enfantId: e._id, statut: { $in: STATUTS_ACTIFS }, date: { $gte: debutDuJour() } });
  if (existant) return existant;
  const date = new Date(`${seance.date}${HEURE_SEANCE_UTC}`);
  try {
    await verifierDoublon(e.mereId, date, null, e._id);
  } catch {
    return null;
  }
  const qui = e.prenom || (e.sexe === 'Féminin' ? 'la petite' : 'le petit');
  return RendezVous.create({
    patienteId: e.mereId, grossesseId: e.grossesseId, enfantId: e._id, date,
    motif: texte(`Vaccination de ${qui} : ${seance.doses.map((d) => d.libelle).join(', ')}`, 200),
    consignes: 'Apporter le carnet de vaccination de l’enfant.',
    etablissementId, creePar: auteur,
    historique: [{ action: 'Planifié', nouvelleDate: date, nouveauStatut: 'Planifié', motif: 'Calendrier vaccinal (PEV)', par: auteur, le: new Date() }],
  });
}
exports.planifierProchaineVaccination = planifierProchaineVaccination;

/**
 * Module 5 — Naissance enregistrée depuis le dossier d'accouchement : l'enfant reçoit son propre
 * dossier, rattaché au compte de sa mère, et sa première séance de vaccination est programmée.
 */
async function creerNaissance(dossier, d, req) {
  const mere = await Patiente.findById(dossier.patienteId).select('nom');
  if (!acc.SEXES.includes(d?.sexe)) throw erreur(400, 'Sexe du nouveau-né requis.');
  const neLe = pasDansLeFutur(instant(d.neLe, 'Date et heure de naissance') ?? dossier.accouchement.heure, 'La naissance');
  const auteur = auteurDe(req.soignant);
  const e = new Enfant({
    numero: await Enfant.prochainNumero(),
    mereId: dossier.patienteId, accouchementId: dossier._id, grossesseId: dossier.grossesseId,
    etablissementId: dossier.etablissementId,
    nom: texte(d.nom, 120) || mere?.nom || '', postnom: texte(d.postnom, 120), prenom: texte(d.prenom, 120),
    sexe: d.sexe, neLe,
    rang: nombre(d.rang) ?? (await Enfant.countDocuments({ accouchementId: dossier._id })) + 1,
    etatNaissance: acc.ETATS_NAISSANCE.includes(d.etatNaissance) ? d.etatNaissance : 'Vivant',
    naissance: lire(SPEC_NAISSANCE, d.naissance),
    creePar: auteur,
  });
  await valider(e);
  try {
    await e.save();
  } catch (err) {
    if (err.code === 11000) throw erreur(409, 'Identifiant déjà attribué, réessayez.');
    throw err;
  }
  await journaliser(req, { action: 'enfant.creation', patienteId: e.mereId, ressource: { type: 'enfant', id: e.numero } });
  await planifierProchaineVaccination(e, auteur, dossier.etablissementId);
  return e;
}
exports.creerNaissance = creerNaissance;

/** Dossier complet de l'enfant (carnet vaccinal, croissance, rendez-vous, mère). */
async function vue(e) {
  const [mere, rendezVous] = await Promise.all([
    Patiente.findById(e.mereId).select('numero nom postnom prenom telephone'),
    RendezVous.find({ enfantId: e._id }).sort({ date: -1 }),
  ]);
  return {
    ...e.toJSON(),
    age: e.age(),
    carnet: e.carnet(),
    mere: mere ? { id: mere.id, numero: mere.numero, nom: mere.nom, postnom: mere.postnom, prenom: mere.prenom, telephone: mere.telephone } : null,
    rendezVous,
  };
}
exports.vue = vue;

/** Recherche : identifiant, nom, prénom, ou enfants d'une mère ; `retard=true` : vaccins en retard. */
exports.rechercher = async (req, res) => {
  const filtre = {};
  const q = texte(req.query.q, 100);
  if (q) {
    const mots = q.split(/\s+/).filter(Boolean).slice(0, 4).map((m) => new RegExp(echapperRegex(m), 'i'));
    filtre.$and = mots.map((r) => ({ $or: [{ numero: r }, { nom: r }, { postnom: r }, { prenom: r }] }));
  }
  if (req.query.mereId) {
    if (!mongoose.isValidObjectId(req.query.mereId)) throw erreur(400, 'Identifiant de la mère invalide.');
    filtre.mereId = req.query.mereId;
  }
  let enfants = (await Enfant.find(filtre).sort({ neLe: -1 }).limit(500)).map(resume);
  if (req.query.retard === 'true') enfants = enfants.filter((e) => e.vaccination?.enRetard > 0);
  const meres = await Patiente.find({ _id: { $in: [...new Set(enfants.map((e) => String(e.mereId)))] } }).select('numero nom prenom');
  const parId = new Map(meres.map((m) => [m.id, m]));
  res.json(enfants.slice(0, 100).map((e) => {
    const m = parId.get(String(e.mereId));
    return { ...e, mere: m ? { id: m.id, numero: m.numero, nom: m.nom, prenom: m.prenom } : null };
  }));
};

exports.obtenir = async (req, res) => {
  const e = await trouverEnfant(req.params.id);
  await journaliser(req, { action: 'enfant.lecture', patienteId: e.mereId, ressource: { type: 'enfant', id: e.numero } });
  res.json(await vue(e));
};

/**
 * Identité et statut (tout le personnel) ; données de naissance (médecins et sages-femmes).
 * Les champs modifiés, sans leurs valeurs, sont journalisés.
 */
exports.modifier = async (req, res) => {
  const e = await trouverEnfant(req.params.id);
  const d = req.body || {};
  for (const k of ['nom', 'postnom', 'prenom']) if (d[k] !== undefined) e[k] = texte(d[k], 120);
  if (d.sexe !== undefined) {
    if (!acc.SEXES.includes(d.sexe)) throw erreur(400, 'Sexe inconnu.');
    e.sexe = d.sexe;
  }
  if (d.statut !== undefined) {
    if (!Enfant.STATUTS_ENFANT.includes(d.statut)) throw erreur(400, 'Statut inconnu.');
    e.statut = d.statut;
  }
  if (d.naissance !== undefined || d.neLe !== undefined || d.etatNaissance !== undefined || d.rang !== undefined) {
    if (!ROLES_MATERNITE.includes(req.soignant.role)) {
      throw erreur(403, 'Les données de naissance sont modifiables par les médecins et les sages-femmes.');
    }
    if (d.naissance !== undefined) e.naissance = fusionner(e.naissance?.toObject?.() ?? {}, lire(SPEC_NAISSANCE, d.naissance));
    if (d.neLe !== undefined) e.neLe = pasDansLeFutur(instant(d.neLe, 'Date et heure de naissance'), 'La naissance');
    if (d.etatNaissance !== undefined) {
      if (!acc.ETATS_NAISSANCE.includes(d.etatNaissance)) throw erreur(400, 'État à la naissance inconnu.');
      e.etatNaissance = d.etatNaissance;
    }
    if (d.rang !== undefined) e.rang = nombre(d.rang);
  }
  const modifies = e.modifiedPaths().filter((p) => !p.includes('.'));
  if (!modifies.length) return res.json(await vue(e));
  e.modifiePar = auteurDe(req.soignant);
  await valider(e);
  await e.save();
  await journaliser(req, { action: 'enfant.modification', patienteId: e.mereId, ressource: { type: 'enfant', id: e.numero }, details: { champs: modifies } });
  res.json(await vue(e));
};

/**
 * Doses administrées (une ou plusieurs d'une même séance) : le rendez-vous de vaccination du jour
 * passe « Effectué » et la séance suivante du calendrier est programmée.
 */
exports.vacciner = async (req, res) => {
  const e = await trouverEnfant(req.params.id);
  if (!e.estSuivi()) throw erreur(409, 'Cet enfant n’est pas (ou plus) suivi : aucune vaccination ne peut être enregistrée.');
  const saisies = Array.isArray(req.body?.doses) ? req.body.doses : [req.body || {}];
  if (!saisies.length || saisies.length > 10) throw erreur(400, 'Indiquez entre 1 et 10 doses.');
  const aujourdhui = vaccination.jourKinshasa();
  const auteur = auteurDe(req.soignant);
  const dejaFaites = new Set(e.vaccinationsValides().map((v) => v.code));
  for (const s of saisies) {
    const dose = vaccination.PAR_CODE.get(s?.code);
    if (!dose) throw erreur(400, 'Vaccin ou supplémentation inconnu du calendrier.');
    if (dejaFaites.has(dose.code)) throw erreur(409, `${dose.libelle} est déjà enregistré pour cet enfant.`);
    const date = jour(s.date, 'Date d’administration') ?? aujourdhui;
    if (date > aujourdhui) throw erreur(400, 'La date d’administration ne peut pas être dans le futur.');
    if (date < e.dateNaissance) throw erreur(400, 'La date d’administration précède la naissance.');
    e.vaccinations.push({
      code: dose.code, date, lot: texte(s.lot, 60), site: texte(s.site, 120), lieu: texte(s.lieu, 200),
      observations: texte(s.observations, 1000), etablissementId: req.etablissementId, administreePar: auteur, le: new Date(),
    });
    dejaFaites.add(dose.code);
  }
  await valider(e);
  await e.save();
  await marquerSeancesEffectuees(e, auteur);
  await journaliser(req, { action: 'enfant.vaccination', patienteId: e.mereId, ressource: { type: 'enfant', id: e.numero }, details: { codes: saisies.map((s) => s.code) } });
  await planifierProchaineVaccination(e, auteur, req.etablissementId);
  res.status(201).json(await vue(e));
};

/** Rendez-vous attendus de l'enfant jusqu'à aujourd'hui inclus : honorés par la séance saisie. */
async function marquerSeancesEffectuees(e, auteur) {
  const finDuJour = new Date(debutDuJour().getTime() + 86400000);
  const rdvs = await RendezVous.find({ enfantId: e._id, statut: { $in: STATUTS_ACTIFS }, date: { $lt: finDuJour } });
  for (const r of rdvs) {
    r.historique.push({ action: 'Effectué', ancienStatut: r.statut, nouveauStatut: 'Effectué', motif: 'Vaccination enregistrée', par: auteur, le: new Date() });
    r.statut = 'Effectué';
    r.modifiePar = auteur;
    await r.save();
  }
}
exports.marquerSeancesEffectuees = marquerSeancesEffectuees;

/** Dose saisie par erreur : annulée avec motif (la saisie reste visible), le calendrier est recalculé. */
exports.annulerVaccination = async (req, res) => {
  const e = await trouverEnfant(req.params.id);
  const v = e.vaccinations.id(req.params.vaccinationId);
  if (!v) throw erreur(404, 'Administration introuvable.');
  if (v.annulation) throw erreur(409, 'Cette administration est déjà annulée.');
  const motif = texte(req.body?.motif, 500);
  if (!motif) throw erreur(400, 'Le motif d’annulation est obligatoire.');
  v.annulation = { motif, par: auteurDe(req.soignant), le: new Date() };
  await e.save();
  await journaliser(req, { action: 'enfant.vaccination', patienteId: e.mereId, ressource: { type: 'enfant', id: e.numero }, details: { annulation: v.code } });
  res.json(await vue(e));
};

/** Visite de suivi : croissance (poids, taille, PC, PB), alimentation et développement. */
exports.ajouterSuivi = async (req, res) => {
  const e = await trouverEnfant(req.params.id);
  const champs = lire(SPEC_SUIVI, req.body);
  if (![champs.poidsG, champs.tailleCm, champs.perimetreCranienCm, champs.perimetreBrachialCm, champs.temperature].some((x) => x != null)
      && !champs.observations && !champs.developpement) {
    throw erreur(400, 'Saisissez au moins une mesure ou une observation.');
  }
  const date = jour(req.body?.date, 'Date de la visite') ?? vaccination.jourKinshasa();
  if (date > vaccination.jourKinshasa()) throw erreur(400, 'La date de la visite ne peut pas être dans le futur.');
  e.suivis.push({ ...champs, date, auteur: auteurDe(req.soignant), le: new Date() });
  await valider(e);
  await e.save();
  await journaliser(req, { action: 'enfant.suivi', patienteId: e.mereId, ressource: { type: 'enfant', id: e.numero } });
  res.status(201).json(await vue(e));
};

exports.listerRendezVous = async (req, res) => {
  const e = await trouverEnfant(req.params.id);
  res.json(await RendezVous.find({ enfantId: e._id }).sort({ date: -1 }));
};

/** Rendez-vous de l'enfant (vaccination de rattrapage, suivi) : visible dans l'espace de sa mère. */
exports.creerRendezVous = async (req, res) => {
  const e = await trouverEnfant(req.params.id);
  const date = instant(req.body?.date, 'Date et heure du rendez-vous');
  if (!date) throw erreur(400, 'Date et heure du rendez-vous invalides.');
  await verifierDoublon(e.mereId, date, null, e._id);
  const auteur = auteurDe(req.soignant);
  const rdv = await RendezVous.create({
    patienteId: e.mereId, grossesseId: e.grossesseId, enfantId: e._id, date,
    motif: texte(req.body.motif, 200) || 'Suivi de l’enfant',
    lieu: texte(req.body.lieu, 200), consignes: texte(req.body.consignes, 500),
    canalRappel: CANAUX_RAPPEL.includes(req.body.canalRappel) ? req.body.canalRappel : 'Aucun',
    etablissementId: req.etablissementId, creePar: auteur,
    historique: [{ action: 'Planifié', nouvelleDate: date, nouveauStatut: 'Planifié', par: auteur, le: new Date() }],
  });
  await journaliser(req, { action: 'rdv.creation', patienteId: e.mereId, ressource: { type: 'rendezvous', id: rdv.id } });
  res.status(201).json(rdv);
};

/** Avant une action sur un rendez-vous de l'enfant (confirmer, reporter…) : il doit bien être le sien. */
exports.verifierRendezVousEnfant = async (req, res, next) => {
  const e = await trouverEnfant(req.params.enfantId);
  if (!mongoose.isValidObjectId(req.params.id) || !(await RendezVous.exists({ _id: req.params.id, enfantId: e._id }))) {
    throw erreur(404, 'Rendez-vous introuvable pour cet enfant.');
  }
  next();
};
