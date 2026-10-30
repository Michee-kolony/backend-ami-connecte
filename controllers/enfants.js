const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const Enfant = require('../models/Enfant');
const Patiente = require('../models/Patiente');
const RendezVous = require('../models/RendezVous');
const { auteurDe } = require('../models/commun');
const { ROLES_MATERNITE } = require('../models/Soignant');
const { journaliser } = require('../config/audit');
const { verifierVersion } = require('../config/conflits');
const acc = require('../config/accouchement');
const vaccination = require('../config/vaccination');
const { envoyerFichier, supprimerFichier, urlSignee } = require('../config/r2');
const { verifierDoublon } = require('./rendezVous');
const { trouverPatiente, verifierAccesPatiente, idsPatientes, champsAdministratifs, chercherDoublons, motDePasseValide } = require('./patientes');
const { erreur, texte, nombre, instant, jour, objet, T, N, B, lire, fusionner, valider, pasDansLeFutur } = require('./saisie');

const { STATUTS_ACTIFS, CANAUX_RAPPEL } = RendezVous;
const echapperRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Heure par défaut des séances de vaccination : 9 h à Kinshasa (8 h UTC). */
const HEURE_SEANCE_UTC = 'T08:00:00Z';
const DOSSIER_PHOTOS = 'enfant';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Âge maximal à l'enregistrement d'un enfant né hors plateforme (suivi jusqu'à l'âge préscolaire). */
const AGE_MAX_ENREGISTREMENT_ANS = 6;

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

/** Dossier de l'enfant : accessible selon l'établissement du dossier de sa mère. */
async function trouverEnfant(req, id) {
  const e = /^AC-ENF-\d+$/.test(id) ? await Enfant.findOne({ numero: id })
    : mongoose.isValidObjectId(id) ? await Enfant.findById(id) : null;
  if (!e) throw erreur(404, 'Dossier de l’enfant introuvable.');
  await verifierAccesPatiente(req, e.mereId);
  return e;
}
exports.trouverEnfant = trouverEnfant;

/** Minuit (heure de Kinshasa) du jour en cours, en instant UTC. */
const debutDuJour = () => new Date(`${vaccination.jourKinshasa()}T00:00:00+01:00`);

/** Résumé d'un enfant pour les listes et le dossier de la mère (photo : lien signé, 15 min). */
function resume(e, photoUrl = null) {
  const carnet = e.carnet();
  return {
    id: e.id, numero: e.numero, nom: e.nom, postnom: e.postnom, prenom: e.prenom, sexe: e.sexe,
    neLe: e.neLe, dateNaissance: e.dateNaissance, rang: e.rang, etatNaissance: e.etatNaissance, statut: e.statut,
    age: e.age(), mereId: e.mereId, accouchementId: e.accouchementId, origine: e.origine, photoUrl,
    vaccination: carnet ? { prochaineSeance: carnet.prochaineSeance, ...carnet.resume } : null,
  };
}
exports.resume = resume;
const resumeAvecPhoto = async (e) => resume(e, await urlSignee(e.photoCle));
exports.resumeAvecPhoto = resumeAvecPhoto;

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
/**
 * Dossier d'un nouveau-né. Photo (req.file) obligatoire pour une naissance vivante : elle
 * identifie le bébé (jumeaux, naissances simultanées) ; facultative pour un mort-né.
 */
async function creerNaissance(dossier, d, req) {
  const mere = await Patiente.findById(dossier.patienteId).select('nom');
  if (!acc.SEXES.includes(d?.sexe)) throw erreur(400, 'Sexe du nouveau-né requis.');
  const etatNaissance = acc.ETATS_NAISSANCE.includes(d.etatNaissance) ? d.etatNaissance : 'Vivant';
  if (etatNaissance === 'Vivant' && !req.file) throw erreur(400, 'La photo du nouveau-né est obligatoire.');
  const neLe = pasDansLeFutur(instant(d.neLe, 'Date et heure de naissance') ?? dossier.accouchement.heure, 'La naissance');
  const auteur = auteurDe(req.soignant);
  const e = new Enfant({
    numero: await Enfant.prochainNumero(),
    mereId: dossier.patienteId, accouchementId: dossier._id, grossesseId: dossier.grossesseId,
    etablissementId: dossier.etablissementId,
    nom: texte(d.nom, 120) || mere?.nom || '', postnom: texte(d.postnom, 120), prenom: texte(d.prenom, 120),
    sexe: d.sexe, neLe,
    rang: nombre(d.rang) ?? (await Enfant.countDocuments({ accouchementId: dossier._id })) + 1,
    etatNaissance,
    naissance: lire(SPEC_NAISSANCE, d.naissance),
    creePar: auteur,
  });
  await valider(e);
  // Photo envoyée après la validation, pour ne pas laisser de fichier orphelin.
  if (req.file) e.photoCle = (await envoyerFichier(req.file, DOSSIER_PHOTOS)).cle;
  try {
    await e.save();
  } catch (err) {
    if (e.photoCle) await supprimerFichier(e.photoCle).catch(() => {});
    if (err.code === 11000) throw erreur(409, 'Identifiant déjà attribué, réessayez.');
    throw err;
  }
  await journaliser(req, { action: 'enfant.creation', patienteId: e.mereId, ressource: { type: 'enfant', id: e.numero } });
  await planifierProchaineVaccination(e, auteur, dossier.etablissementId);
  return e;
}
exports.creerNaissance = creerNaissance;

/**
 * Mère d'un enfant né hors plateforme, sans dossier (ni CPN ni accouchement ici) : dossier minimal,
 * photo d'identification et compte de l'application patiente (suivi des vaccins de son enfant).
 * Renvoie null après avoir répondu 409 si elle semble déjà enregistrée et que le soignant n'a pas confirmé.
 */
async function nouvelleMere(req, res, corps) {
  if (!req.etablissementId) throw erreur(403, 'Connectez-vous à un établissement pour enregistrer une patiente.');
  const d = objet(corps.nouvelleMere);
  const champs = champsAdministratifs({
    nom: d.nom, postnom: d.postnom, prenom: d.prenom, dateNaissance: d.dateNaissance, ageDeclare: d.ageDeclare,
    telephone: d.telephone, contactUrgence: objet(d.contactUrgence), adresse: objet(d.adresse), email: d.email,
  });
  if (!req.files?.photoMere?.[0]) throw erreur(400, 'La photo de la mère est obligatoire.');
  if (!champs.nom) throw erreur(400, 'Le nom de la mère est obligatoire.');
  if (!champs.dateNaissance && champs.ageDeclare == null) throw erreur(400, 'Date de naissance ou âge de la mère obligatoire.');
  if (!champs.email || !EMAIL.test(champs.email)) throw erreur(400, 'Adresse e-mail de la mère obligatoire et valide (application patiente).');
  const motDePasse = objet(corps.compte).motDePasse;
  if (!motDePasseValide(motDePasse)) throw erreur(400, 'Mot de passe de la mère trop faible : 8 caractères au moins, avec des lettres et des chiffres.');
  const memeEmail = await Patiente.findOne({ email: champs.email });
  if (memeEmail) {
    res.status(409).json({
      message: `Cette adresse e-mail appartient déjà au dossier ${memeEmail.numero} : si c’est la même mère, choisissez son dossier.`,
      emailExistant: true,
      doublons: [{
        id: memeEmail.id, numero: memeEmail.numero, nom: memeEmail.nom, postnom: memeEmail.postnom, prenom: memeEmail.prenom,
        age: memeEmail.age(), telephoneMasque: memeEmail.telephoneMasque(), commune: memeEmail.adresse?.commune ?? '',
      }],
    });
    return null;
  }
  const doublons = await chercherDoublons(champs);
  if (doublons.length && corps.confirmerMalgreDoublons !== true) {
    res.status(409).json({ message: 'Dossier(s) existant(s) possiblement identique(s) : si c’est la même mère, choisissez son dossier.', doublons });
    return null;
  }
  return new Patiente({
    ...champs,
    ageDeclareLe: champs.ageDeclare != null ? new Date().toISOString().slice(0, 10) : null,
    etablissementId: req.etablissementId,
    enregistreeVia: 'Enregistrement enfant',
    statut: 'Suivi postnatal',
    motDePasse: await bcrypt.hash(motDePasse, 12),
    espaceEnLigne: 'Activé',
    creePar: auteurDe(req.soignant),
    numero: await Patiente.prochainNumero(),
  });
}

/**
 * Enfant né hors plateforme (sa mère n'a pas suivi ses CPN ni accouché ici) enregistré pour sa
 * vaccination : rattaché à sa mère (dossier existant `mereId`, ou créé : `nouvelleMere` + `compte`),
 * photo obligatoire, doses déjà reçues recopiées du carnet (`vaccinationsAnterieures`), puis la
 * prochaine séance du calendrier est programmée. Tout le personnel soignant.
 */
exports.enregistrer = async (req, res) => {
  let corps;
  try {
    corps = objet(typeof req.body?.donnees === 'string' ? JSON.parse(req.body.donnees) : req.body);
  } catch {
    throw erreur(400, 'Données du formulaire invalides.');
  }
  const d = objet(corps.enfant);
  const photo = req.files?.photo?.[0];
  if (!photo) throw erreur(400, 'La photo de l’enfant est obligatoire.');
  if (!acc.SEXES.includes(d.sexe)) throw erreur(400, 'Sexe de l’enfant requis.');
  const dateNaissance = jour(d.dateNaissance, 'Date de naissance de l’enfant');
  if (!dateNaissance) throw erreur(400, 'Date de naissance de l’enfant obligatoire.');
  const heure = texte(d.heureNaissance, 5);
  if (heure && !/^([01]\d|2[0-3]):[0-5]\d$/.test(heure)) throw erreur(400, 'Heure de naissance invalide (HH:MM attendu).');
  // Sans heure connue : midi à Kinshasa, pour garder le bon jour civil (base du calendrier vaccinal).
  const neLe = pasDansLeFutur(new Date(`${dateNaissance}T${heure || '12:00'}:00+01:00`), 'La naissance');
  const [an, mois, j] = vaccination.jourKinshasa().split('-');
  if (dateNaissance < `${Number(an) - AGE_MAX_ENREGISTREMENT_ANS}-${mois}-${j}`) {
    throw erreur(400, `Enfant de plus de ${AGE_MAX_ENREGISTREMENT_ANS} ans : le suivi vaccinal s’arrête à l’âge préscolaire.`);
  }
  const anterieures = Array.isArray(corps.vaccinationsAnterieures) ? corps.vaccinationsAnterieures : [];
  if (anterieures.length > vaccination.CODES.length) throw erreur(400, 'Trop de doses antérieures.');

  let mere;
  if (corps.mereId) mere = await trouverPatiente(req, String(corps.mereId));
  else if (corps.nouvelleMere) {
    mere = await nouvelleMere(req, res, corps);
    if (!mere) return; // 409 déjà envoyée (dossiers possiblement identiques)
  } else throw erreur(400, 'Choisissez le dossier de la mère ou enregistrez-la.');
  const prenom = texte(d.prenom, 120);
  if (!mere.isNew && corps.confirmerMalgreDoublons !== true) {
    const meme = await Enfant.findOne({ mereId: mere._id, dateNaissance, ...(prenom ? { prenom: new RegExp(`^${echapperRegex(prenom)}$`, 'i') } : {}) }).select('numero');
    if (meme) return res.status(409).json({ message: `Cet enfant semble déjà enregistré (${meme.numero}).`, enfantExistant: { id: meme.id, numero: meme.numero } });
  }

  const auteur = auteurDe(req.soignant);
  const e = new Enfant({
    numero: await Enfant.prochainNumero(),
    mereId: mere._id, etablissementId: req.etablissementId ?? null,
    origine: 'Né hors plateforme', lieuNaissance: texte(d.lieuNaissance, 200),
    nom: texte(d.nom, 120) || mere.nom || '', postnom: texte(d.postnom, 120), prenom,
    sexe: d.sexe, neLe, dateNaissance, rang: nombre(d.rang) ?? 1,
    naissance: lire({ poidsG: N, tailleCm: N, perimetreCranienCm: N }, objet(d.naissance)),
    creePar: auteur,
  });
  ajouterDoses(e, anterieures, auteur, { reportee: true });
  if (mere.isNew) await valider(mere);
  await valider(e);
  // Photos envoyées après toutes les validations, pour ne pas laisser de fichier orphelin.
  const nouvelle = mere.isNew;
  e.photoCle = (await envoyerFichier(photo, DOSSIER_PHOTOS)).cle;
  if (nouvelle) mere.photoCle = (await envoyerFichier(req.files.photoMere[0], 'patiente')).cle;
  // Sans transaction (MongoDB autonome) : en cas d'échec, les documents et fichiers créés ici sont retirés.
  try {
    if (nouvelle) await mere.save();
    await e.save();
  } catch (err) {
    await Promise.all([
      nouvelle && Patiente.deleteOne({ _id: mere._id }),
      supprimerFichier(e.photoCle),
      nouvelle && supprimerFichier(mere.photoCle),
    ]).catch(() => {});
    if (err.code === 11000) throw erreur(409, 'Identifiant ou e-mail déjà utilisé, réessayez.');
    throw err;
  }
  if (nouvelle) await journaliser(req, { action: 'patiente.creation', patienteId: mere._id, ressource: { type: 'patiente', id: mere.numero }, details: { via: 'Enregistrement enfant' } });
  await journaliser(req, { action: 'enfant.enregistrement', patienteId: mere._id, ressource: { type: 'enfant', id: e.numero }, details: { dosesAnterieures: anterieures.length } });
  await planifierProchaineVaccination(e, auteur, req.etablissementId);
  res.status(201).json(await vue(e));
};

/** Dossier complet de l'enfant (carnet vaccinal, croissance, rendez-vous, mère). */
async function vue(e) {
  const [mere, rendezVous] = await Promise.all([
    Patiente.findById(e.mereId).select('numero nom postnom prenom telephone'),
    RendezVous.find({ enfantId: e._id }).sort({ date: -1 }),
  ]);
  return {
    ...e.toJSON(),
    photoUrl: await urlSignee(e.photoCle),
    age: e.age(),
    carnet: e.carnet(),
    mere: mere ? { id: mere.id, numero: mere.numero, nom: mere.nom, postnom: mere.postnom, prenom: mere.prenom, telephone: mere.telephone } : null,
    rendezVous,
  };
}
exports.vue = vue;

/** Recherche : identifiant, nom, prénom, ou enfants d'une mère ; `retard=true` : vaccins en retard. */
exports.rechercher = async (req, res) => {
  const filtre = { mereId: { $in: await idsPatientes(req) } };
  const q = texte(req.query.q, 100);
  if (q) {
    const mots = q.split(/\s+/).filter(Boolean).slice(0, 4).map((m) => new RegExp(echapperRegex(m), 'i'));
    filtre.$and = mots.map((r) => ({ $or: [{ numero: r }, { nom: r }, { postnom: r }, { prenom: r }] }));
  }
  if (req.query.mereId) {
    if (!mongoose.isValidObjectId(req.query.mereId)) throw erreur(400, 'Identifiant de la mère invalide.');
    await verifierAccesPatiente(req, req.query.mereId);
    filtre.mereId = req.query.mereId;
  }
  let enfants = (await Enfant.find(filtre).sort({ neLe: -1 }).limit(500)).map((e) => ({ ...resume(e), photoCle: e.photoCle }));
  if (req.query.retard === 'true') enfants = enfants.filter((e) => e.vaccination?.enRetard > 0);
  enfants = await Promise.all(enfants.slice(0, 100).map(async ({ photoCle, ...e }) => ({ ...e, photoUrl: await urlSignee(photoCle) })));
  const meres = await Patiente.find({ _id: { $in: [...new Set(enfants.map((e) => String(e.mereId)))] } }).select('numero nom prenom');
  const parId = new Map(meres.map((m) => [m.id, m]));
  res.json(enfants.map((e) => {
    const m = parId.get(String(e.mereId));
    return { ...e, mere: m ? { id: m.id, numero: m.numero, nom: m.nom, prenom: m.prenom } : null };
  }));
};

/**
 * Photo de l'enfant : ajout ou remplacement (médecins et sages-femmes, qui l'ont identifié à la
 * naissance). L'ancienne photo est retirée du bucket une fois la nouvelle enregistrée.
 */
exports.changerPhoto = async (req, res) => {
  if (!ROLES_MATERNITE.includes(req.soignant.role)) throw erreur(403, 'Réservé aux médecins et aux sages-femmes.');
  const e = await trouverEnfant(req, req.params.id);
  if (!req.file) throw erreur(400, 'Choisissez une photo.');
  const ancienne = e.photoCle;
  e.photoCle = (await envoyerFichier(req.file, DOSSIER_PHOTOS)).cle;
  e.modifiePar = auteurDe(req.soignant);
  await e.save();
  if (ancienne) await supprimerFichier(ancienne).catch((err) => console.error(`Fichier ${ancienne} non supprimé de R2 :`, err.message));
  await journaliser(req, { action: 'enfant.photo', patienteId: e.mereId, ressource: { type: 'enfant', id: e.numero } });
  res.json(await vue(e));
};

exports.obtenir = async (req, res) => {
  const e = await trouverEnfant(req, req.params.id);
  await journaliser(req, { action: 'enfant.lecture', patienteId: e.mereId, ressource: { type: 'enfant', id: e.numero } });
  res.json(await vue(e));
};

/**
 * Identité et statut (tout le personnel) ; données de naissance (médecins et sages-femmes).
 * Les champs modifiés, sans leurs valeurs, sont journalisés.
 */
exports.modifier = async (req, res) => {
  const e = await trouverEnfant(req, req.params.id);
  verifierVersion(req, e, 'le dossier de l’enfant');
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
 * Doses du calendrier ajoutées au dossier (contrôles : dose connue, pas déjà faite, date entre la
 * naissance et aujourd'hui). `reportee` : doses reçues ailleurs, recopiées du carnet papier.
 */
function ajouterDoses(e, saisies, auteur, { etablissementId = null, reportee = false } = {}) {
  const aujourdhui = vaccination.jourKinshasa();
  const dejaFaites = new Set(e.vaccinationsValides().map((v) => v.code));
  for (const s of saisies.map(objet)) {
    const dose = vaccination.PAR_CODE.get(s.code);
    if (!dose) throw erreur(400, 'Vaccin ou supplémentation inconnu du calendrier.');
    if (dejaFaites.has(dose.code)) throw erreur(409, `${dose.libelle} est déjà enregistré pour cet enfant.`);
    const date = jour(s.date, 'Date d’administration') ?? (reportee ? null : aujourdhui);
    if (!date) throw erreur(400, `Date de la dose ${dose.libelle} obligatoire (voir le carnet de l’enfant).`);
    if (date > aujourdhui) throw erreur(400, 'La date d’administration ne peut pas être dans le futur.');
    if (date < e.dateNaissance) throw erreur(400, 'La date d’administration précède la naissance.');
    e.vaccinations.push({
      code: dose.code, date, lot: texte(s.lot, 60), site: texte(s.site, 120), lieu: texte(s.lieu, 200),
      observations: texte(s.observations, 1000), etablissementId: reportee ? null : etablissementId, reportee,
      administreePar: auteur, le: new Date(),
    });
    dejaFaites.add(dose.code);
  }
}

/**
 * Doses administrées (une ou plusieurs d'une même séance) : le rendez-vous de vaccination du jour
 * passe « Effectué » et la séance suivante du calendrier est programmée.
 */
exports.vacciner = async (req, res) => {
  const e = await trouverEnfant(req, req.params.id);
  if (!e.estSuivi()) throw erreur(409, 'Cet enfant n’est pas (ou plus) suivi : aucune vaccination ne peut être enregistrée.');
  const saisies = Array.isArray(req.body?.doses) ? req.body.doses : [req.body || {}];
  if (!saisies.length || saisies.length > 10) throw erreur(400, 'Indiquez entre 1 et 10 doses.');
  const auteur = auteurDe(req.soignant);
  ajouterDoses(e, saisies, auteur, { etablissementId: req.etablissementId });
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
  const e = await trouverEnfant(req, req.params.id);
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
  const e = await trouverEnfant(req, req.params.id);
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
  const e = await trouverEnfant(req, req.params.id);
  res.json(await RendezVous.find({ enfantId: e._id }).sort({ date: -1 }));
};

/** Rendez-vous de l'enfant (vaccination de rattrapage, suivi) : visible dans l'espace de sa mère. */
exports.creerRendezVous = async (req, res) => {
  const e = await trouverEnfant(req, req.params.id);
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
  const e = await trouverEnfant(req, req.params.enfantId);
  if (!mongoose.isValidObjectId(req.params.id) || !(await RendezVous.exists({ _id: req.params.id, enfantId: e._id }))) {
    throw erreur(404, 'Rendez-vous introuvable pour cet enfant.');
  }
  next();
};
