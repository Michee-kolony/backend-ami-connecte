// Urgences : alerte de détresse de la patiente (application mobile) → prise en charge par la
// régulation (personnel) → envoi d'un chauffeur et d'une ambulance → course suivie en temps réel
// (application chauffeur) → clôture. Chaque étape est horodatée dans la chronologie de l'urgence
// et diffusée aussitôt aux trois applications (socket.io).
const mongoose = require('mongoose');
const Urgence = require('../models/Urgence');
const Ambulance = require('../models/Ambulance');
const Chauffeur = require('../models/Chauffeur');
const Soignant = require('../models/Soignant');
const Patiente = require('../models/Patiente');
const Etablissement = require('../models/Etablissement');
const { auteurDe } = require('../models/commun');
const { journaliser } = require('../config/audit');
const presence = require('../config/presence');
const suiviAmbulances = require('../config/suiviAmbulances');
const notifications = require('../config/notifications');
const messagesUrgence = require('./messagesUrgence');
const { urlSignee } = require('../config/r2');
const u = require('../config/urgences');
const { erreur, texte, nombre } = require('./saisie');

const MOTIFS = new Map(u.MOTIFS.map((m) => [m.code, m]));
const libelleMotif = (code) => MOTIFS.get(code)?.libelle ?? code;

const FORMAT_LOCAL = new Intl.DateTimeFormat('fr-CA', {
  timeZone: 'Africa/Kinshasa', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
/** « AAAA-MM-JJ HH:mm », heure de Kinshasa. */
function heureLocale(d) {
  const p = Object.fromEntries(FORMAT_LOCAL.formatToParts(new Date(d)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

const nomPatiente = (p) => (p ? `${p.prenom} ${p.nom}`.trim() : 'Patiente');
const nomChauffeur = (c) => `${c.prenom} ${c.nom}`.trim();

async function trouver(numero) {
  const urgence = /^URG-\d+$/.test(String(numero)) ? await Urgence.findOne({ numero }) : null;
  if (!urgence) throw erreur(404, 'Urgence introuvable.');
  return urgence;
}

/** Urgence traitée par la régulation : celles de l'établissement de connexion (voir config/urgences.js). */
async function trouverPourRegulation(req, numero) {
  const x = await trouver(numero);
  if (!u.urgenceVisible(x, req.etablissementId)) throw erreur(404, 'Urgence introuvable.');
  return x;
}

function lireCoordonnees(d) {
  const lat = nombre(d?.lat);
  const lng = nombre(d?.lng);
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const precision = nombre(d?.precision);
  return { lat, lng, precisionM: precision != null && precision >= 0 ? Math.round(precision) : null };
}

// --- Vues ---------------------------------------------------------------------------

const evenements = (x) => x.evenements.map((e) => ({ date: heureLocale(e.le), le: e.le, type: e.type, auteur: e.auteur, detail: e.detail || undefined }));

/** Vues de la régulation (espace administrateur), patientes et photos chargées par lot. */
async function vuesRegulation(liste) {
  const patientes = await Patiente.find({ _id: { $in: [...new Set(liste.map((x) => String(x.patienteId)))] } })
    .select('numero nom postnom prenom photoCle telephone adresse');
  const parId = new Map(await Promise.all(patientes.map(async (p) => [p.id, { p, photo: await urlSignee(p.photoCle) }])));
  return liste.map((x) => {
    const { p, photo } = parId.get(String(x.patienteId)) ?? {};
    const local = heureLocale(x.createdAt);
    return {
      id: x.numero,
      patienteId: String(x.patienteId),
      patienteNumero: p?.numero ?? null,
      patiente: nomPatiente(p),
      photo: photo ?? undefined,
      telephone: x.telephone || p?.telephone || '',
      motif: libelleMotif(x.motif),
      motifCode: x.motif,
      precisions: x.precisions,
      gravite: x.gravite,
      etat: x.etat,
      statutCourse: x.statutCourse,
      date: local.slice(0, 10),
      heure: local.slice(11),
      creeLe: x.createdAt,
      lat: x.lat,
      lng: x.lng,
      precisionM: x.precisionM,
      quartier: p?.adresse?.quartier || '',
      commune: p?.adresse?.commune || '',
      ambulanceId: x.ambulance ?? undefined,
      chauffeurId: x.chauffeurId ? String(x.chauffeurId) : undefined,
      chauffeur: x.chauffeurNom || undefined,
      infirmier: x.infirmier ? { id: x.infirmier.id, nom: x.infirmier.nom, role: x.infirmier.role, photo: x.infirmier.photo ?? null } : null,
      prisEnChargePar: x.prisEnChargePar?.nom ?? null,
      evenements: evenements(x),
    };
  });
}

async function vueRegulation(x) {
  return (await vuesRegulation([x]))[0];
}

/** Hôpital de destination : l'établissement de suivi de la patiente (ou de la régulation). */
async function destination(x) {
  if (!x.etablissementId || !mongoose.isValidObjectId(x.etablissementId)) return null;
  const e = await Etablissement.findById(x.etablissementId).select('nom adresse telephone latitude longitude');
  return e ? { nom: e.nom, adresse: e.adresse, telephone: e.telephone, lat: e.latitude, lng: e.longitude } : null;
}

const vueAmbulanceCourte = (a) => (a ? {
  code: a.code, immatriculation: a.immatriculation, modele: a.modele, type: a.type,
  position: a.position?.lat != null ? { lat: a.position.lat, lng: a.position.lng, cap: a.position.cap, vitesse: a.position.vitesse, le: a.position.le } : null,
} : null);

/** Vue de la patiente : son alerte, l'ambulance envoyée (position) et le chauffeur. */
async function vuePatiente(x) {
  const [ambulance, chauffeur] = await Promise.all([
    x.ambulance ? Ambulance.findOne({ code: x.ambulance }) : null,
    x.chauffeurId ? Chauffeur.findById(x.chauffeurId) : null,
  ]);
  return {
    id: x.numero, motif: libelleMotif(x.motif), motifCode: x.motif, gravite: x.gravite, etat: x.etat, statutCourse: x.statutCourse,
    creeLe: x.createdAt, lat: x.lat, lng: x.lng,
    ambulance: vueAmbulanceCourte(ambulance),
    chauffeur: chauffeur ? {
      prenom: chauffeur.prenom, nom: chauffeur.nom, postnom: chauffeur.postnom, matricule: chauffeur.matricule,
      telephone: chauffeur.telephone, photo: chauffeur.photo,
    } : null,
    infirmier: x.infirmier ? { nom: x.infirmier.nom, role: x.infirmier.role, telephone: x.infirmier.telephone, photo: x.infirmier.photo ?? null } : null,
    destination: await destination(x),
    evenements: x.evenements.map((e) => ({ le: e.le, type: e.type })),
  };
}

/** Vue du chauffeur : la patiente à secourir, où la trouver et où l'emmener. */
async function vueMission(x) {
  const p = await Patiente.findById(x.patienteId).select('numero nom postnom prenom photoCle telephone adresse');
  return {
    id: x.numero, motif: libelleMotif(x.motif), precisions: x.precisions, gravite: x.gravite, etat: x.etat, statutCourse: x.statutCourse,
    creeLe: x.createdAt, lat: x.lat, lng: x.lng, precisionM: x.precisionM, ambulance: x.ambulance,
    patiente: p ? {
      prenom: p.prenom, nom: p.nom, postnom: p.postnom, telephone: x.telephone || p.telephone, photo: await urlSignee(p.photoCle),
      adresse: { commune: p.adresse?.commune ?? '', quartier: p.adresse?.quartier ?? '', avenue: p.adresse?.avenue ?? '' },
    } : null,
    destination: await destination(x),
    infirmier: x.infirmier ? { nom: x.infirmier.nom, role: x.infirmier.role, telephone: x.infirmier.telephone } : null,
    evenements: evenements(x),
  };
}

/** Diffuse l'urgence à jour : personnel, patiente et chauffeur engagé. */
async function diffuser(x, { nouvelle = false } = {}) {
  try {
    presence.emettreEtablissement(x.etablissementId, nouvelle ? 'urgence:nouvelle' : 'urgence:maj', await vueRegulation(x));
    presence.emettrePatiente(String(x.patienteId), 'urgence:maj', await vuePatiente(x));
    if (x.chauffeurId) presence.emettreChauffeur(String(x.chauffeurId), 'mission:maj', await vueMission(x));
  } catch (err) {
    console.error('Diffusion de l’urgence impossible :', err.message);
  }
}

async function diffuserAmbulance(code) {
  const a = await Ambulance.findOne({ code });
  if (a) presence.emettreEtablissement(a.etablissementId, 'flotte:ambulance', a.toJSON());
}

/** Fin de mission : l'ambulance redevient disponible (si elle est encore sur cette urgence). */
async function libererAmbulance(x) {
  if (!x.ambulance) return;
  await Ambulance.updateOne({ code: x.ambulance, urgence: x.numero }, { statut: 'Disponible', urgence: null });
  suiviAmbulances.invalider(x.chauffeurId);
  await diffuserAmbulance(x.ambulance);
}

/**
 * Fin de mission (terminée, clôturée ou annulée) : l'ambulance est libérée et la conversation
 * de l'urgence est supprimée définitivement ; les trois applications vident leur fil.
 */
async function finMission(x) {
  await libererAmbulance(x);
  await messagesUrgence.supprimerConversation(x);
}

async function creerAvecNumero(donnees) {
  for (let essai = 0; ; essai += 1) {
    try {
      return await Urgence.create({ ...donnees, numero: await Urgence.prochainNumero() });
    } catch (err) {
      if (err.code !== 11000 || essai >= 4) throw err;
    }
  }
}

// --- Application patiente -----------------------------------------------------------

/** Motifs proposés à la patiente. */
exports.motifs = (req, res) => {
  res.json(u.MOTIFS.map(({ code, libelle }) => ({ code, libelle })));
};

/**
 * Alerte de détresse. Une seule alerte active à la fois : si la patiente en a déjà une,
 * elle est renvoyée telle quelle (double appui, réseau qui renvoie la requête).
 */
exports.declencher = async (req, res) => {
  const motif = MOTIFS.get(String(req.body?.motif || ''));
  if (!motif) throw erreur(400, 'Choisissez le motif de l’urgence.');
  const position = lireCoordonnees(req.body);
  if (!position) throw erreur(400, 'Position GPS requise : activez la localisation du téléphone.');

  const existante = await Urgence.findOne({ patienteId: req.patiente._id, etat: { $in: u.ETATS_ACTIFS } });
  if (existante) return res.status(200).json(await vuePatiente(existante));

  const x = await creerAvecNumero({
    patienteId: req.patiente._id, motif: motif.code, gravite: motif.gravite, precisions: texte(req.body?.precisions, 500),
    ...position, telephone: req.patiente.telephone || '', etablissementId: req.patiente.etablissementId ?? null,
    evenements: [{ le: new Date(), type: 'Alerte reçue', auteur: 'Application patiente', detail: motif.libelle }],
  });
  await journaliser(req, { action: 'urgence.alerte', patienteId: req.patiente._id, ressource: { type: 'urgence', id: x.numero }, details: { motif: x.motif } });
  await diffuser(x, { nouvelle: true });
  res.status(201).json(await vuePatiente(x));
};

/** Alerte en cours de la patiente (null si aucune). */
exports.alerteActive = async (req, res) => {
  const x = await Urgence.findOne({ patienteId: req.patiente._id, etat: { $in: u.ETATS_ACTIFS } }).sort({ createdAt: -1 });
  res.json({ urgence: x ? await vuePatiente(x) : null });
};

/** La patiente s'est déplacée : sa nouvelle position est transmise à la régulation et au chauffeur. */
exports.deplacerPatiente = async (req, res) => {
  const x = await trouver(req.params.numero);
  if (String(x.patienteId) !== req.patiente.id) throw erreur(404, 'Urgence introuvable.');
  if (!x.estActive()) throw erreur(409, 'Cette urgence est terminée.');
  const position = lireCoordonnees(req.body);
  if (!position) throw erreur(400, 'Position invalide.');
  Object.assign(x, position);
  await x.save();
  const message = { urgence: x.numero, lat: x.lat, lng: x.lng, precisionM: x.precisionM };
  presence.emettreEtablissement(x.etablissementId, 'urgence:position', message);
  if (x.chauffeurId) presence.emettreChauffeur(String(x.chauffeurId), 'urgence:position', message);
  res.json({ ok: true });
};

/** Annulation par la patiente, tant qu'elle n'est pas à bord de l'ambulance. */
exports.annulerParPatiente = async (req, res) => {
  const x = await trouver(req.params.numero);
  if (String(x.patienteId) !== req.patiente.id) throw erreur(404, 'Urgence introuvable.');
  if (!x.estActive()) throw erreur(409, 'Cette urgence est déjà terminée.');
  if (['Patiente à bord', 'Arrivée à l’hôpital', 'Terminée'].includes(x.statutCourse)) {
    throw erreur(409, 'Vous êtes déjà prise en charge par l’ambulance : l’alerte ne peut plus être annulée.');
  }
  x.etat = 'annulée';
  x.clotureLe = new Date();
  x.journaliser('Annulée', 'Application patiente', texte(req.body?.motif, 300) || 'Annulée par la patiente');
  await x.save();
  await finMission(x);
  await journaliser(req, { action: 'urgence.annulation.patiente', patienteId: x.patienteId, ressource: { type: 'urgence', id: x.numero } });
  await diffuser(x);
  res.json(await vuePatiente(x));
};

/** Ambulances visibles sur la carte de la patiente : code, position et disponibilité. */
exports.ambulancesVisibles = async (req, res) => {
  // Ambulances de l'établissement de la patiente seulement.
  const liste = await Ambulance.find({ ...u.filtreFlotte(req.patiente.etablissementId), statut: { $in: ['Disponible', 'En mission'] }, 'position.lat': { $ne: null } })
    .select('code statut position');
  res.json(liste.map((a) => ({ code: a.code, disponible: a.statut === 'Disponible', lat: a.position.lat, lng: a.position.lng })));
};

// --- Régulation (espace administrateur) -----------------------------------------------

/** Urgences actives (par défaut) ou toutes celles des `jours` derniers jours. */
exports.lister = async (req, res) => {
  const filtre = u.filtreRegulation(req.etablissementId);
  if (req.query.etat === 'toutes') {
    const jours = Math.min(Math.max(parseInt(req.query.jours, 10) || 30, 1), 365);
    filtre.$or = [{ createdAt: { $gte: new Date(Date.now() - jours * 86400000) } }, { etat: { $in: u.ETATS_ACTIFS } }];
  } else {
    filtre.etat = { $in: u.ETATS_ACTIFS };
  }
  const liste = await Urgence.find(filtre).sort({ createdAt: -1 }).limit(500);
  res.json(await vuesRegulation(liste));
};

exports.obtenir = async (req, res) => {
  res.json(await vueRegulation(await trouverPourRegulation(req, req.params.numero)));
};

function prendreEnChargeSiNouvelle(x, soignant) {
  if (x.etat !== 'nouvelle') return;
  x.etat = 'prise en charge';
  x.prisEnChargePar = auteurDe(soignant);
  x.journaliser('Prise en charge', `${soignant.prenom} ${soignant.nom}`);
}

exports.prendreEnCharge = async (req, res) => {
  const x = await trouverPourRegulation(req, req.params.numero);
  if (x.etat !== 'nouvelle') throw erreur(409, x.estActive() ? 'Cette urgence est déjà prise en charge.' : 'Cette urgence est terminée.');
  prendreEnChargeSiNouvelle(x, req.soignant);
  await x.save();
  await journaliser(req, { action: 'urgence.prise_en_charge', patienteId: x.patienteId, ressource: { type: 'urgence', id: x.numero } });
  await diffuser(x);
  res.json(await vueRegulation(x));
};

/**
 * Envoi d'un chauffeur et d'une ambulance. L'ambulance doit être disponible et le chauffeur
 * actif, sans autre mission. Avant le départ (course « Assignée »), on peut encore changer.
 */
exports.affecter = async (req, res) => {
  const x = await trouverPourRegulation(req, req.params.numero);
  if (!x.estActive()) throw erreur(409, 'Cette urgence est terminée.');
  if (x.statutCourse && x.statutCourse !== 'Assignée') throw erreur(409, 'L’ambulance est déjà partie : la course ne peut plus être réaffectée.');

  const chauffeurId = String(req.body?.chauffeurId || '');
  // Chauffeur, ambulance et accompagnant : ceux de l'établissement de connexion seulement.
  const flotte = u.filtreFlotte(req.etablissementId);
  const chauffeur = mongoose.isValidObjectId(chauffeurId) ? await Chauffeur.findOne({ _id: chauffeurId, ...flotte }) : null;
  if (!chauffeur) throw erreur(400, 'Choisissez le chauffeur.');
  if (chauffeur.statut !== 'Actif') throw erreur(409, 'Ce chauffeur est suspendu.');
  const autreMission = await Urgence.exists({ chauffeurId: chauffeur._id, etat: { $in: u.ETATS_ACTIFS }, numero: { $ne: x.numero } });
  if (autreMission) throw erreur(409, `${nomChauffeur(chauffeur)} est occupé sur une autre urgence.`);

  const ambulance = await Ambulance.findOne({ code: String(req.body?.ambulance || ''), ...flotte });
  if (!ambulance) throw erreur(400, 'Choisissez l’ambulance.');

  // Infirmier·ère ou sage-femme qui accompagne l'ambulance (facultatif).
  const infirmierId = String(req.body?.infirmierId || '');
  let infirmier = null;
  if (infirmierId) {
    const s = mongoose.isValidObjectId(infirmierId) ? await Soignant.findById(infirmierId) : null;
    if (!s || s.statut !== 'Actif') throw erreur(400, 'Infirmier·ère introuvable ou suspendu·e.');
    if (!s.affectations.some((a) => a.etablissementId === req.etablissementId)) throw erreur(400, 'Choisissez un·e infirmier·ère de votre établissement.');
    if (!/^(Infirmier|Sage-femme)/.test(s.role)) throw erreur(400, 'Choisissez un·e infirmier·ère ou une sage-femme.');
    infirmier = { id: s.id, nom: `${s.prenom} ${s.nom}`.trim(), role: s.role, telephone: s.telephone, photo: s.photo ?? null };
  }
  const memeAmbulance = ambulance.urgence === x.numero;
  if (!memeAmbulance && ambulance.statut !== 'Disponible') {
    throw erreur(409, ambulance.statut === 'En mission' ? `${ambulance.code} est occupée sur une autre urgence.` : `${ambulance.code} est en ${ambulance.statut.toLowerCase()}.`);
  }

  // Réaffectation : l'ambulance et le chauffeur précédents sont libérés.
  const ancienneAmbulance = x.ambulance && x.ambulance !== ambulance.code ? x.ambulance : null;
  const ancienChauffeur = x.chauffeurId && String(x.chauffeurId) !== chauffeur.id ? String(x.chauffeurId) : null;
  if (ancienneAmbulance) await Ambulance.updateOne({ code: ancienneAmbulance, urgence: x.numero }, { statut: 'Disponible', urgence: null });

  // Le chauffeur conduit cette ambulance : il est retiré de celle qu'il conduisait avant.
  await Ambulance.updateMany({ chauffeurId: chauffeur._id, code: { $ne: ambulance.code } }, { chauffeurId: null });
  ambulance.chauffeurId = chauffeur._id;
  ambulance.statut = 'En mission';
  ambulance.urgence = x.numero;
  await ambulance.save();

  prendreEnChargeSiNouvelle(x, req.soignant);
  x.ambulance = ambulance.code;
  x.chauffeurId = chauffeur._id;
  x.chauffeurNom = nomChauffeur(chauffeur);
  x.statutCourse = 'Assignée';
  x.infirmier = infirmier ?? undefined;
  if (!x.etablissementId && req.etablissementId) x.etablissementId = req.etablissementId;
  x.journaliser('Ambulance envoyée', `${req.soignant.prenom} ${req.soignant.nom}`,
    `${ambulance.code} — ${x.chauffeurNom}${infirmier ? ` · ${infirmier.nom} (${infirmier.role})` : ''}`);
  await x.save();

  suiviAmbulances.invalider(chauffeur.id);
  if (ancienChauffeur) {
    suiviAmbulances.invalider(ancienChauffeur);
    presence.emettreChauffeur(ancienChauffeur, 'mission:retiree', { urgence: x.numero });
  }
  await journaliser(req, {
    action: 'urgence.affectation', patienteId: x.patienteId, ressource: { type: 'urgence', id: x.numero },
    details: { ambulance: ambulance.code, chauffeur: chauffeur.matricule, infirmier: infirmier?.id ?? null },
  });
  presence.emettreChauffeur(chauffeur.id, 'mission:nouvelle', await vueMission(x));
  await diffuser(x);
  presence.emettreEtablissement(ambulance.etablissementId, 'flotte:ambulance', ambulance.toJSON());
  if (ancienneAmbulance) await diffuserAmbulance(ancienneAmbulance);
  notifications.notifierPatiente(x.patienteId, {
    titre: 'Une ambulance arrive',
    corps: `${ambulance.code} (${ambulance.immatriculation}) conduite par ${x.chauffeurNom} est envoyée vers vous. Suivez-la en direct dans l’application.`,
    donnees: { type: 'urgence', urgence: x.numero },
  });
  res.json(await vueRegulation(x));
};

exports.cloturer = async (req, res) => {
  const x = await trouverPourRegulation(req, req.params.numero);
  if (!x.estActive()) throw erreur(409, 'Cette urgence est déjà terminée.');
  x.etat = 'résolue';
  x.clotureLe = new Date();
  if (x.statutCourse) x.statutCourse = 'Terminée';
  x.journaliser('Clôturée', `${req.soignant.prenom} ${req.soignant.nom}`, texte(req.body?.detail, 500));
  await x.save();
  await finMission(x);
  await journaliser(req, { action: 'urgence.cloture', patienteId: x.patienteId, ressource: { type: 'urgence', id: x.numero } });
  await diffuser(x);
  res.json(await vueRegulation(x));
};

exports.annuler = async (req, res) => {
  const x = await trouverPourRegulation(req, req.params.numero);
  if (!x.estActive()) throw erreur(409, 'Cette urgence est déjà terminée.');
  const motif = texte(req.body?.motif, 500);
  if (!motif) throw erreur(400, 'Indiquez le motif de l’annulation.');
  x.etat = 'annulée';
  x.clotureLe = new Date();
  x.journaliser('Annulée', `${req.soignant.prenom} ${req.soignant.nom}`, motif);
  await x.save();
  await finMission(x);
  await journaliser(req, { action: 'urgence.annulation', patienteId: x.patienteId, ressource: { type: 'urgence', id: x.numero } });
  await diffuser(x);
  res.json(await vueRegulation(x));
};

// --- Application chauffeur -------------------------------------------------------------

/** Mission en cours du chauffeur connecté (null si aucune). */
exports.missionEnCours = async (req, res) => {
  const x = await Urgence.findOne({ chauffeurId: req.chauffeur._id, etat: { $in: u.ETATS_ACTIFS } }).sort({ createdAt: -1 });
  res.json({ mission: x ? await vueMission(x) : null });
};

/** Dernières missions du chauffeur (terminées ou annulées comprises). */
exports.historiqueMissions = async (req, res) => {
  const liste = await Urgence.find({ chauffeurId: req.chauffeur._id }).sort({ createdAt: -1 }).limit(30);
  res.json(liste.map((x) => ({
    id: x.numero, motif: libelleMotif(x.motif), gravite: x.gravite, etat: x.etat, statutCourse: x.statutCourse,
    ambulance: x.ambulance, creeLe: x.createdAt, clotureLe: x.clotureLe,
  })));
};

/** Moyenne arrondie (minutes) ; null sans valeur. */
const moyenne = (liste) => (liste.length ? Math.round(liste.reduce((s, v) => s + v, 0) / liste.length) : null);
const minutesEntre = (a, b) => (a && b ? (new Date(b) - new Date(a)) / 60000 : null);

/**
 * Tableau de bord du chauffeur : courses effectuées (aujourd'hui, semaine, mois, total),
 * annulations, délais moyens, répartition par gravité et activité des 7 derniers jours.
 * Jours comptés à l'heure de Kinshasa. Une mission qui lui a été retirée n'est pas comptée.
 */
exports.statistiquesChauffeur = async (req, res) => {
  const liste = await Urgence.find({ chauffeurId: req.chauffeur._id }).select('etat statutCourse gravite evenements createdAt clotureLe').lean();
  const jourDe = (d) => heureLocale(d).slice(0, 10);
  const aujourdhui = jourDe(new Date());
  const jours = Array.from({ length: 7 }, (_, i) => jourDe(new Date(Date.now() - (6 - i) * 86400000)));
  const debutSemaine = jours[0];
  const mois = aujourdhui.slice(0, 7);

  const effectuees = liste.filter((x) => x.etat === 'résolue');
  const evenement = (x, type) => x.evenements.find((e) => e.type === type)?.le;
  // Délai d'arrivée : de l'envoi de l'ambulance à l'arrivée sur place ; durée : de l'envoi à la clôture.
  const delais = effectuees.map((x) => minutesEntre(evenement(x, 'Ambulance envoyée'), evenement(x, 'Arrivée sur place'))).filter((v) => v != null && v >= 0);
  const durees = effectuees.map((x) => minutesEntre(evenement(x, 'Ambulance envoyée'), x.clotureLe)).filter((v) => v != null && v >= 0);

  res.json({
    courses: {
      total: effectuees.length,
      aujourdhui: effectuees.filter((x) => jourDe(x.createdAt) === aujourdhui).length,
      semaine: effectuees.filter((x) => jourDe(x.createdAt) >= debutSemaine).length,
      mois: effectuees.filter((x) => jourDe(x.createdAt).startsWith(mois)).length,
    },
    patientesTransportees: effectuees.filter((x) => x.evenements.some((e) => e.type === 'Patiente à bord')).length,
    annulees: liste.filter((x) => x.etat === 'annulée').length,
    enCours: liste.filter((x) => u.ETATS_ACTIFS.includes(x.etat)).length,
    delaiArriveeMoyenMin: moyenne(delais),
    dureeMoyenneMin: moyenne(durees),
    parGravite: Object.fromEntries(u.GRAVITES.map((g) => [g, effectuees.filter((x) => x.gravite === g).length])),
    septJours: jours.map((jour) => ({ jour, courses: effectuees.filter((x) => jourDe(x.createdAt) === jour).length })),
    derniereCourse: effectuees.reduce((d, x) => (!d || x.clotureLe > d ? x.clotureLe : d), null),
  });
};

/**
 * Statut de la course, dans l'ordre (une étape peut être sautée, jamais reprise en arrière).
 * « Terminée » clôt l'urgence et libère l'ambulance.
 */
exports.changerStatutCourse = async (req, res) => {
  const x = await trouver(req.params.numero);
  if (String(x.chauffeurId) !== req.chauffeur.id) throw erreur(404, 'Mission introuvable.');
  if (!x.estActive()) throw erreur(409, 'Cette mission est terminée.');
  const statut = String(req.body?.statut || '');
  const rang = u.STATUTS_COURSE.indexOf(statut);
  if (rang <= 0) throw erreur(400, 'Statut de course inconnu.');
  if (rang <= u.STATUTS_COURSE.indexOf(x.statutCourse)) throw erreur(409, `La course est déjà à l’étape « ${x.statutCourse} ».`);
  if (statut === 'Terminée' && u.STATUTS_COURSE.indexOf(x.statutCourse) < u.STATUTS_COURSE.indexOf('Arrivée sur place')) {
    throw erreur(409, 'Indiquez d’abord votre arrivée sur place.');
  }
  const auteur = nomChauffeur(req.chauffeur);
  x.statutCourse = statut;
  if (statut === 'Terminée') {
    x.etat = 'résolue';
    x.clotureLe = new Date();
    x.journaliser('Clôturée', auteur, texte(req.body?.detail, 500) || 'Mission terminée par le chauffeur');
  } else {
    x.journaliser(statut, auteur, texte(req.body?.detail, 500));
  }
  await x.save();
  if (statut === 'Terminée') await finMission(x);
  await journaliser(req, { action: 'urgence.course', patienteId: x.patienteId, ressource: { type: 'urgence', id: x.numero }, details: { statut } });
  await diffuser(x);
  if (statut === 'Arrivée sur place') {
    notifications.notifierPatiente(x.patienteId, { titre: 'L’ambulance est arrivée', corps: `${x.chauffeurNom} est sur place.`, donnees: { type: 'urgence', urgence: x.numero } });
  }
  res.json({ mission: await vueMission(x) });
};

/** Position GPS par HTTP (secours quand le socket est coupé). */
exports.position = async (req, res) => {
  const m = await suiviAmbulances.enregistrerPosition(req.chauffeur.id, req.body);
  res.json({ ok: !!m });
};

module.exports.vueMission = vueMission;
