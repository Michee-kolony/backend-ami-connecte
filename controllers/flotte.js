// Flotte de secours : ambulances et comptes des chauffeurs (application ami-connecte-chauffeur).
// Lecture : tout le personnel ; ajout et modification : médecins (voir routes/flotte.js).
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const QRCode = require('qrcode');
const Ambulance = require('../models/Ambulance');
const Chauffeur = require('../models/Chauffeur');
const Urgence = require('../models/Urgence');
const { auteurDe } = require('../models/commun');
const { journaliser } = require('../config/audit');
const presence = require('../config/presence');
const suiviAmbulances = require('../config/suiviAmbulances');
const { envoyerFichier, supprimerFichier } = require('../config/r2');
const u = require('../config/urgences');
const { erreur, texte, nombre, jour, objet, valider } = require('./saisie');

/** Même règle que l'espace administrateur : 10 caractères, majuscules, minuscules, chiffre, caractère spécial. */
function motDePasseValide(m) {
  return typeof m === 'string' && m.length >= 10 && m.length <= 128
    && /[A-Z]/.test(m) && /[a-z]/.test(m) && /\d/.test(m) && /[^A-Za-z0-9]/.test(m);
}
const MESSAGE_MOT_DE_PASSE = 'Mot de passe trop faible (10 caractères, majuscules, minuscules, chiffre et caractère spécial).';

/** Mot de passe temporaire solide (sans caractères ambigus). */
function genererMotDePasse() {
  const groupes = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '!@#$%&*?'];
  const tous = groupes.join('');
  const car = groupes.map((g) => g[crypto.randomInt(g.length)]);
  while (car.length < 12) car.push(tous[crypto.randomInt(tous.length)]);
  for (let i = car.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [car[i], car[j]] = [car[j], car[i]];
  }
  return car.join('');
}

/** Formulaire multipart : données JSON dans « donnees » (ou champs simples), photo dans « photo ». */
function donneesDe(req) {
  if (typeof req.body?.donnees === 'string') {
    try {
      return objet(JSON.parse(req.body.donnees));
    } catch {
      throw erreur(400, 'Données du formulaire invalides.');
    }
  }
  return objet(req.body);
}

async function trouverAmbulance(code) {
  const a = await Ambulance.findOne({ code: String(code) });
  if (!a) throw erreur(404, 'Ambulance introuvable.');
  return a;
}

async function trouverChauffeur(id) {
  const c = mongoose.isValidObjectId(id) ? await Chauffeur.findById(id) : null;
  if (!c) throw erreur(404, 'Chauffeur introuvable.');
  return c;
}

const diffuserAmbulance = (a) => presence.emettrePersonnel('flotte:ambulance', a.toJSON());

/** Chauffeurs avec leur ambulance, leur occupation (mission en cours) et leurs missions du mois. */
async function vuesChauffeurs(liste) {
  const ids = liste.map((c) => c._id);
  const debutMois = new Date();
  debutMois.setUTCDate(1);
  debutMois.setUTCHours(0, 0, 0, 0);
  const [ambulances, enMission, parMois] = await Promise.all([
    Ambulance.find({ chauffeurId: { $in: ids } }).select('code immatriculation statut chauffeurId'),
    Urgence.find({ chauffeurId: { $in: ids }, etat: { $in: u.ETATS_ACTIFS } }).select('numero chauffeurId'),
    Urgence.aggregate([
      { $match: { chauffeurId: { $in: ids }, createdAt: { $gte: debutMois }, etat: { $ne: 'annulée' } } },
      { $group: { _id: '$chauffeurId', n: { $sum: 1 } } },
    ]),
  ]);
  const ambulanceDe = new Map(ambulances.map((a) => [String(a.chauffeurId), a]));
  const missionDe = new Map(enMission.map((x) => [String(x.chauffeurId), x.numero]));
  const nombreDe = new Map(parMois.map((x) => [String(x._id), x.n]));
  return liste.map((c) => {
    const a = ambulanceDe.get(c.id);
    return {
      ...c.toJSON(),
      ambulance: a ? { code: a.code, immatriculation: a.immatriculation, statut: a.statut } : null,
      /** Urgence en cours : le chauffeur est « Occupé ». */
      mission: missionDe.get(c.id) ?? null,
      disponibilite: missionDe.has(c.id) ? 'Occupé' : c.statut === 'Actif' ? 'Disponible' : 'Suspendu',
      missionsMois: nombreDe.get(c.id) ?? 0,
    };
  });
}

// --- Ambulances ---------------------------------------------------------------------

exports.listerAmbulances = async (req, res) => {
  const liste = await Ambulance.find().sort({ code: 1 });
  res.json(liste.map((a) => a.toJSON()));
};

const CHAMPS_AMBULANCE = (d) => ({
  ...(d.immatriculation !== undefined && { immatriculation: texte(d.immatriculation, 30).toUpperCase() }),
  ...(d.modele !== undefined && { modele: texte(d.modele, 80) }),
  ...(d.annee !== undefined && { annee: nombre(d.annee) }),
  ...(d.type !== undefined && { type: u.TYPES_AMBULANCE.includes(d.type) ? d.type : undefined }),
  ...(d.infirmier !== undefined && { infirmier: texte(d.infirmier, 120) }),
  ...(d.kilometrage !== undefined && { kilometrage: nombre(d.kilometrage) ?? 0 }),
  ...(d.carburant !== undefined && { carburant: nombre(d.carburant) ?? 100 }),
  ...(d.prochaineRevision !== undefined && { prochaineRevision: jour(d.prochaineRevision, 'Date de révision') }),
});

/** Le chauffeur passe sur cette ambulance : retiré de la précédente (sauf si elle est en mission). */
async function attribuerChauffeur(ambulance, chauffeurId) {
  if (ambulance.statut === 'En mission') throw erreur(409, `${ambulance.code} est en mission : changez de chauffeur à la fin de la course.`);
  if (!chauffeurId) {
    suiviAmbulances.invalider(ambulance.chauffeurId);
    ambulance.chauffeurId = null;
    return null;
  }
  const chauffeur = await trouverChauffeur(chauffeurId);
  if (chauffeur.statut !== 'Actif') throw erreur(409, 'Ce chauffeur est suspendu.');
  const precedente = await Ambulance.findOne({ chauffeurId: chauffeur._id, code: { $ne: ambulance.code } });
  if (precedente?.statut === 'En mission') throw erreur(409, `${chauffeur.prenom} ${chauffeur.nom} conduit ${precedente.code}, actuellement en mission.`);
  if (precedente) {
    precedente.chauffeurId = null;
    await precedente.save();
    diffuserAmbulance(precedente);
  }
  suiviAmbulances.invalider(ambulance.chauffeurId);
  suiviAmbulances.invalider(chauffeur.id);
  ambulance.chauffeurId = chauffeur._id;
  return chauffeur;
}

exports.creerAmbulance = async (req, res) => {
  const d = objet(req.body);
  const champs = CHAMPS_AMBULANCE(d);
  if (!champs.immatriculation || !champs.modele || !champs.type) throw erreur(400, 'Immatriculation, modèle et type sont obligatoires.');
  if (await Ambulance.exists({ immatriculation: champs.immatriculation })) throw erreur(409, 'Cette immatriculation est déjà enregistrée.');
  const a = new Ambulance({ ...champs, code: await Ambulance.prochainCode(), creePar: auteurDe(req.soignant) });
  if (d.chauffeurId) await attribuerChauffeur(a, String(d.chauffeurId));
  await valider(a);
  await a.save();
  await journaliser(req, { action: 'flotte.ambulance.creation', ressource: { type: 'ambulance', id: a.code } });
  diffuserAmbulance(a);
  res.status(201).json(a.toJSON());
};

/** Modification : caractéristiques, statut (Disponible, Maintenance, Hors service) et chauffeur attitré. */
exports.modifierAmbulance = async (req, res) => {
  const a = await trouverAmbulance(req.params.code);
  const d = objet(req.body);
  const champs = CHAMPS_AMBULANCE(d);
  if (champs.immatriculation && champs.immatriculation !== a.immatriculation
    && await Ambulance.exists({ immatriculation: champs.immatriculation })) {
    throw erreur(409, 'Cette immatriculation est déjà enregistrée.');
  }
  Object.assign(a, Object.fromEntries(Object.entries(champs).filter(([, v]) => v !== undefined)));
  if (d.statut !== undefined) {
    if (!['Disponible', 'Maintenance', 'Hors service'].includes(d.statut)) throw erreur(400, 'Statut inconnu.');
    if (a.statut === 'En mission') throw erreur(409, `${a.code} est en mission : statut modifiable à la fin de la course.`);
    a.statut = d.statut;
  }
  if (d.chauffeurId !== undefined) await attribuerChauffeur(a, d.chauffeurId ? String(d.chauffeurId) : null);
  await valider(a);
  await a.save();
  await journaliser(req, { action: 'flotte.ambulance.modification', ressource: { type: 'ambulance', id: a.code }, details: { champs: Object.keys(d) } });
  diffuserAmbulance(a);
  res.json(a.toJSON());
};

// --- Chauffeurs ---------------------------------------------------------------------

exports.listerChauffeurs = async (req, res) => {
  const liste = await Chauffeur.find().sort({ createdAt: -1 });
  res.json(await vuesChauffeurs(liste));
};

exports.obtenirChauffeur = async (req, res) => {
  res.json((await vuesChauffeurs([await trouverChauffeur(req.params.id)]))[0]);
};

/** Matricule attribué au prochain chauffeur (proposé dans le formulaire). */
exports.prochainMatricule = async (req, res) => {
  res.json({ matricule: await Chauffeur.prochainMatricule() });
};

const CHAMPS_CHAUFFEUR = (d) => ({
  ...(d.prenom !== undefined && { prenom: texte(d.prenom, 80) }),
  ...(d.nom !== undefined && { nom: texte(d.nom, 80) }),
  ...(d.postnom !== undefined && { postnom: texte(d.postnom, 80) }),
  ...(d.telephone !== undefined && { telephone: texte(d.telephone, 30) }),
  ...(d.permis !== undefined && { permis: texte(d.permis, 40).toUpperCase() }),
  ...(d.permisExpire !== undefined && { permisExpire: jour(d.permisExpire, 'Date d’expiration du permis') }),
});

/**
 * Création du compte : nom complet, photo de profil (obligatoire), matricule (proposé, ou saisi)
 * et mot de passe. Le chauffeur peut être placé directement sur une ambulance disponible.
 */
exports.creerChauffeur = async (req, res) => {
  if (!req.file) throw erreur(400, 'La photo de profil du chauffeur est obligatoire.');
  const d = donneesDe(req);
  const champs = CHAMPS_CHAUFFEUR(d);
  if (!champs.prenom || !champs.nom || !champs.telephone) throw erreur(400, 'Prénom, nom et téléphone sont obligatoires.');
  const motDePasse = String(d.motDePasse || '');
  if (!motDePasseValide(motDePasse)) throw erreur(400, MESSAGE_MOT_DE_PASSE);

  let matricule = texte(d.matricule, 20).toUpperCase();
  if (matricule && !/^[A-Z0-9][A-Z0-9-]{2,19}$/.test(matricule)) throw erreur(400, 'Matricule invalide (lettres, chiffres et tirets).');
  if (matricule && await Chauffeur.exists({ matricule })) throw erreur(409, 'Ce matricule est déjà attribué.');
  matricule ||= await Chauffeur.prochainMatricule();
  if (champs.permis && await Chauffeur.exists({ permis: champs.permis })) throw erreur(409, 'Ce numéro de permis est déjà enregistré.');

  const c = new Chauffeur({
    ...champs, matricule, motDePasse: await bcrypt.hash(motDePasse, 12),
    doitChangerMotDePasse: d.doitChangerMotDePasse !== false && d.doitChangerMotDePasse !== 'false',
    creePar: auteurDe(req.soignant),
  });
  await valider(c);
  const ambulance = d.ambulance ? await trouverAmbulance(d.ambulance) : null;
  if (ambulance?.statut === 'En mission') throw erreur(409, `${ambulance.code} est en mission.`);

  const { cle, url } = await envoyerFichier(req.file, 'chauffeurs');
  c.photo = url;
  c.photoCle = cle;
  await c.save();
  if (ambulance) {
    await attribuerChauffeur(ambulance, c.id);
    await ambulance.save();
    diffuserAmbulance(ambulance);
  }
  await journaliser(req, { action: 'flotte.chauffeur.creation', ressource: { type: 'chauffeur', id: c.matricule } });
  res.status(201).json((await vuesChauffeurs([c]))[0]);
};

exports.modifierChauffeur = async (req, res) => {
  const c = await trouverChauffeur(req.params.id);
  const d = donneesDe(req);
  const champs = CHAMPS_CHAUFFEUR(d);
  if (champs.permis && champs.permis !== c.permis && await Chauffeur.exists({ permis: champs.permis })) {
    throw erreur(409, 'Ce numéro de permis est déjà enregistré.');
  }
  Object.assign(c, champs);
  await valider(c);
  const anciennePhoto = req.file ? c.photoCle : null;
  if (req.file) {
    const { cle, url } = await envoyerFichier(req.file, 'chauffeurs');
    c.photo = url;
    c.photoCle = cle;
  }
  await c.save();
  if (anciennePhoto) supprimerFichier(anciennePhoto).catch(() => {});
  await journaliser(req, { action: 'flotte.chauffeur.modification', ressource: { type: 'chauffeur', id: c.matricule }, details: { champs: Object.keys(champs) } });
  res.json((await vuesChauffeurs([c]))[0]);
};

/** Suspension (impossible pendant une mission) : le chauffeur est retiré de son ambulance et déconnecté. */
exports.changerStatutChauffeur = async (req, res) => {
  const c = await trouverChauffeur(req.params.id);
  const statut = String(req.body?.statut || '');
  if (!u.STATUTS_CHAUFFEUR.includes(statut)) throw erreur(400, 'Statut inconnu.');
  if (statut === 'Suspendu') {
    if (await Urgence.exists({ chauffeurId: c._id, etat: { $in: u.ETATS_ACTIFS } })) {
      throw erreur(409, `${c.prenom} ${c.nom} est en mission : suspension possible à la fin de la course.`);
    }
    const ambulances = await Ambulance.find({ chauffeurId: c._id });
    for (const a of ambulances) {
      a.chauffeurId = null;
      await a.save();
      diffuserAmbulance(a);
    }
    suiviAmbulances.invalider(c.id);
    presence.expulserChauffeur(c.id);
  }
  c.statut = statut;
  await c.save();
  await journaliser(req, { action: 'flotte.chauffeur.statut', ressource: { type: 'chauffeur', id: c.matricule }, details: { statut } });
  res.json((await vuesChauffeurs([c]))[0]);
};

/** Nouveau mot de passe temporaire (généré si absent), renvoyé une seule fois. */
exports.reinitialiserMotDePasse = async (req, res) => {
  const c = await trouverChauffeur(req.params.id);
  const motDePasse = req.body?.motDePasse ? String(req.body.motDePasse) : genererMotDePasse();
  if (!motDePasseValide(motDePasse)) throw erreur(400, MESSAGE_MOT_DE_PASSE);
  await Chauffeur.updateOne({ _id: c._id }, { motDePasse: await bcrypt.hash(motDePasse, 12), doitChangerMotDePasse: true });
  presence.expulserChauffeur(c.id);
  await journaliser(req, { action: 'flotte.chauffeur.mot_de_passe', ressource: { type: 'chauffeur', id: c.matricule } });
  res.json({ matricule: c.matricule, motDePasse });
};

/**
 * Carte de service du chauffeur : identité, ambulance attitrée et QR code de vérification
 * (texte signé lisible par n'importe quel lecteur). Le rendu imprimable est fait par l'admin.
 */
exports.carteService = async (req, res) => {
  const c = await trouverChauffeur(req.params.id);
  const [vue] = await vuesChauffeurs([c]);
  const emiseLe = new Date().toISOString().slice(0, 10);
  const empreinte = crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${c.id}:${c.matricule}`).digest('hex').slice(0, 12).toUpperCase();
  const contenu = [
    'AMI SANTÉ CONNECT — CARTE DE SERVICE',
    'Chauffeur ambulancier',
    `Matricule : ${c.matricule}`,
    `Nom : ${c.nomComplet()}`,
    `Téléphone : ${c.telephone}`,
    `Statut : ${c.statut}`,
    `Contrôle : ${empreinte}`,
  ].join('\n');
  const qr = await QRCode.toDataURL(contenu, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
  res.json({ chauffeur: vue, emiseLe, controle: empreinte, qr });
};

module.exports.motDePasseValide = motDePasseValide;
module.exports.genererMotDePasse = genererMotDePasse;
module.exports.donneesDe = donneesDe;
