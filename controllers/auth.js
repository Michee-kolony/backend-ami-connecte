const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Soignant = require('../models/Soignant');
const Etablissement = require('../models/Etablissement');
const { ROLES_GESTION } = Soignant;
const { envoyerFichier, supprimerFichier } = require('../config/r2');
const { motDePasseValide } = require('./soignants');
const presence = require('../config/presence');

const { CHAMPS_PROFIL } = Soignant;

exports.connexion = async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const motDePasse = String(req.body.motDePasse || '');
  if (!email || !motDePasse) return res.status(400).json({ message: 'E-mail et mot de passe requis.' });

  const soignant = await Soignant.findOne({ email }).select('+motDePasse');
  // Même message dans tous les cas pour ne pas révéler quels e-mails existent.
  if (!soignant || !(await bcrypt.compare(motDePasse, soignant.motDePasse))) {
    return res.status(401).json({ message: 'E-mail ou mot de passe incorrect.' });
  }
  if (soignant.statut !== 'Actif') return res.status(403).json({ message: 'Ce compte est suspendu.' });

  // Établissement de travail : choisi par le soignant s'il en a plusieurs.
  const etablissements = await Etablissement.actifsParIds(soignant.affectations.map((a) => a.etablissementId));
  let etablissement = null;
  const choix = req.body.etablissementId;
  if (choix) {
    etablissement = etablissements.find((e) => e.id === choix);
    if (!etablissement) return res.status(400).json({ message: 'Vous n’êtes pas rattaché à cet établissement ou il est suspendu.' });
  } else if (etablissements.length === 1) {
    etablissement = etablissements[0];
  } else if (etablissements.length > 1) {
    return res.json({ choixEtablissement: true, etablissements: etablissements.map((e) => e.resume()) });
  } else if (!ROLES_GESTION.includes(soignant.role)) {
    // Le médecin chef peut entrer sans établissement pour pouvoir en créer.
    return res.status(403).json({ message: 'Aucun établissement actif n’est rattaché à votre compte. Contactez le médecin chef.' });
  }

  soignant.derniereConnexion = new Date();
  await soignant.save();

  const jeton = jwt.sign({ sub: soignant.id, role: soignant.role, etablissement: etablissement?.id ?? null }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
  });
  res.json({ jeton, soignant, etablissement: etablissement?.resume() ?? null });
};

exports.moi = (req, res) => {
  res.json(req.soignant);
};

/** Mise à jour du profil du soignant connecté, avec une nouvelle photo facultative. */
exports.modifierProfil = async (req, res) => {
  const soignant = req.soignant;
  for (const champ of CHAMPS_PROFIL) {
    if (req.body[champ] !== undefined) soignant[champ] = req.body[champ];
  }
  // Seul le médecin chef choisit lui-même ses établissements ; les autres sont affectés par lui.
  if (req.body.affectations !== undefined && ROLES_GESTION.includes(soignant.role)) {
    let affectations;
    try {
      affectations = JSON.parse(req.body.affectations);
    } catch {
      return res.status(400).json({ message: 'Affectations invalides.' });
    }
    const probleme = await Etablissement.verifierAffectations(affectations);
    if (probleme) return res.status(400).json({ message: probleme });
    soignant.affectations = affectations;
  }
  if (soignant.isModified('numeroOrdre') && soignant.numeroOrdre
      && await Soignant.exists({ numeroOrdre: soignant.numeroOrdre, _id: { $ne: soignant._id } })) {
    return res.status(409).json({ message: 'Ce numéro d’Ordre est déjà enregistré.' });
  }
  try {
    await soignant.validate();
  } catch (err) {
    return res.status(400).json({ message: Object.values(err.errors || {})[0]?.message || 'Données invalides.' });
  }

  const ancienneCle = soignant.photoCle;
  if (req.file) {
    const { cle, url } = await envoyerFichier(req.file, 'soignant');
    soignant.photo = url;
    soignant.photoCle = cle;
  }
  await soignant.save();
  if (req.file && ancienneCle) await supprimerFichier(ancienneCle).catch(() => {});
  await presence.actualiser(soignant);
  res.json(soignant);
};

exports.changerMotDePasse = async (req, res) => {
  const actuel = String(req.body.actuel || '');
  const nouveau = String(req.body.nouveau || '');
  const soignant = await Soignant.findById(req.soignant._id).select('+motDePasse');
  if (!(await bcrypt.compare(actuel, soignant.motDePasse))) {
    return res.status(400).json({ message: 'Mot de passe actuel incorrect.' });
  }
  if (!motDePasseValide(nouveau)) {
    return res.status(400).json({ message: 'Mot de passe trop faible (10 caractères, majuscules, minuscules, chiffre et caractère spécial).' });
  }
  soignant.motDePasse = await bcrypt.hash(nouveau, 12);
  soignant.doitChangerMotDePasse = false;
  await soignant.save();
  res.json(soignant);
};
