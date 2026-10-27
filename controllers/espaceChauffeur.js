// Application ami-connecte-chauffeur : connexion par matricule, profil, ambulance attitrée.
// Missions, statut de la course et position GPS : controllers/urgences.js.
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Chauffeur = require('../models/Chauffeur');
const Ambulance = require('../models/Ambulance');
const { journaliser } = require('../config/audit');
const { motDePasseValide } = require('./flotte');
const { erreur, texte } = require('./saisie');

async function profil(c) {
  const a = await Ambulance.findOne({ chauffeurId: c._id });
  return {
    id: c.id, matricule: c.matricule, prenom: c.prenom, nom: c.nom, postnom: c.postnom, telephone: c.telephone,
    photo: c.photo, permis: c.permis ?? '', permisExpire: c.permisExpire, statut: c.statut,
    doitChangerMotDePasse: c.doitChangerMotDePasse,
    ambulance: a ? { code: a.code, immatriculation: a.immatriculation, modele: a.modele, type: a.type, statut: a.statut, infirmier: a.infirmier } : null,
  };
}

exports.connexion = async (req, res) => {
  const matricule = texte(req.body?.matricule, 20).toUpperCase();
  const motDePasse = String(req.body?.motDePasse || '');
  if (!matricule || !motDePasse) throw erreur(400, 'Matricule et mot de passe requis.');
  const c = await Chauffeur.findOne({ matricule }).select('+motDePasse');
  // Même message dans tous les cas pour ne pas révéler quels matricules existent.
  if (!c || !(await bcrypt.compare(motDePasse, c.motDePasse))) throw erreur(401, 'Matricule ou mot de passe incorrect.');
  if (c.statut !== 'Actif') throw erreur(403, 'Votre compte est suspendu. Contactez la régulation.');
  c.derniereConnexion = new Date();
  await c.save();
  const jeton = jwt.sign({ sub: c.id, typ: 'chauffeur' }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_CHAUFFEUR_EXPIRES_IN || '30d' });
  req.chauffeur = c;
  await journaliser(req, { action: 'chauffeur.connexion', ressource: { type: 'chauffeur', id: c.matricule } });
  res.json({ jeton, chauffeur: await profil(c) });
};

exports.moi = async (req, res) => {
  res.json(await profil(req.chauffeur));
};

exports.changerMotDePasse = async (req, res) => {
  const c = await Chauffeur.findById(req.chauffeur._id).select('+motDePasse');
  if (!(await bcrypt.compare(String(req.body?.actuel || ''), c.motDePasse))) throw erreur(400, 'Mot de passe actuel incorrect.');
  const nouveau = req.body?.nouveau;
  if (!motDePasseValide(nouveau)) throw erreur(400, 'Mot de passe trop faible (10 caractères, majuscules, minuscules, chiffre et caractère spécial).');
  c.motDePasse = await bcrypt.hash(nouveau, 12);
  c.doitChangerMotDePasse = false;
  await c.save();
  res.json(await profil(c));
};
