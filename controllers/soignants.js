const bcrypt = require('bcrypt');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Soignant = require('../models/Soignant');
const Etablissement = require('../models/Etablissement');
const { envoyerFichier, supprimerFichier, cleDepuisUrl } = require('../config/r2');
const presence = require('../config/presence');
const { messageValidation } = require('../config/erreursFr');

const DOSSIER_PHOTOS = 'soignant';

exports.motDePasseValide = motDePasseValide;
function motDePasseValide(m) {
  return m.length >= 10 && /[A-Z]/.test(m) && /[a-z]/.test(m) && /\d/.test(m) && /[^A-Za-z0-9]/.test(m);
}

/** Mot de passe temporaire solide (sans caractères ambigus). */
function genererMotDePasse() {
  const groupes = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '!@#$%&*?'];
  const tous = groupes.join('');
  const car = groupes.map((g) => g[crypto.randomInt(g.length)]);
  while (car.length < 12) car.push(tous[crypto.randomInt(tous.length)]);
  for (let i = car.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [car[i], car[j]] = [car[j], car[i]];
  }
  return car.join('');
}

exports.lister = async (req, res) => {
  const soignants = await Soignant.find().sort({ createdAt: -1 }).populate('creePar', Soignant.CHAMPS_AUTEUR);
  res.json(soignants);
};

exports.obtenir = async (req, res) => {
  const soignant = mongoose.isValidObjectId(req.params.id)
    && await Soignant.findById(req.params.id).populate('creePar', Soignant.CHAMPS_AUTEUR);
  if (!soignant) return res.status(404).json({ message: 'Soignant introuvable.' });
  res.json(soignant);
};

exports.creer = async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'La photo d’identité est obligatoire.' });

  const d = req.body;
  const motDePasse = String(d.motDePasse || '');
  if (!motDePasseValide(motDePasse)) {
    return res.status(400).json({ message: 'Mot de passe trop faible (10 caractères, majuscules, minuscules, chiffre et caractère spécial).' });
  }

  let affectations;
  try {
    affectations = JSON.parse(d.affectations || '[]');
  } catch {
    return res.status(400).json({ message: 'Affectations invalides.' });
  }
  const probleme = await Etablissement.verifierAffectations(affectations);
  if (probleme) return res.status(400).json({ message: probleme });

  const email = String(d.email || '').trim().toLowerCase();
  const numeroOrdre = String(d.numeroOrdre || '').trim().toUpperCase();
  if (await Soignant.exists({ email })) return res.status(409).json({ message: 'Cet e-mail est déjà utilisé.' });
  if (numeroOrdre && await Soignant.exists({ numeroOrdre })) return res.status(409).json({ message: 'Ce numéro d’Ordre est déjà enregistré.' });

  // Validation complète avant l'envoi de la photo, pour ne pas laisser de fichier orphelin.
  const soignant = new Soignant({
    matricule: await Soignant.prochainMatricule(d.role),
    prenom: d.prenom,
    nom: d.nom,
    postnom: d.postnom,
    sexe: d.sexe,
    dateNaissance: d.dateNaissance,
    lieuNaissance: d.lieuNaissance,
    nationalite: d.nationalite,
    pieceType: d.pieceType,
    pieceNumero: d.pieceNumero,
    adresse: d.adresse,
    telephone: d.telephone,
    numeroOrdre,
    grade: d.grade,
    specialite: d.specialite,
    affectations,
    email,
    motDePasse: await bcrypt.hash(motDePasse, 12),
    role: d.role,
    doitChangerMotDePasse: d.doitChangerMotDePasse !== 'false',
    creePar: req.soignant._id,
    auteurAjout: Soignant.instantaneAuteur(req.soignant),
  });
  try {
    await soignant.validate();
  } catch (err) {
    return res.status(400).json({ message: messageValidation(err) });
  }

  const { cle, url } = await envoyerFichier(req.file, DOSSIER_PHOTOS);
  soignant.photo = url;
  soignant.photoCle = cle;
  try {
    await soignant.save();
  } catch (err) {
    await supprimerFichier(cle).catch(() => {});
    if (err.code === 11000) return res.status(409).json({ message: 'Ce soignant existe déjà (e-mail, matricule ou numéro d’Ordre).' });
    throw err;
  }
  res.status(201).json(soignant);
};

/**
 * Le médecin chef modifie le profil d'un soignant : identité, profession, rôle, e-mail,
 * établissements d'affectation (actifs uniquement) et photo facultative.
 */
exports.modifier = async (req, res) => {
  const soignant = mongoose.isValidObjectId(req.params.id) && await Soignant.findById(req.params.id).select('+photoCle');
  if (!soignant) return res.status(404).json({ message: 'Soignant introuvable.' });
  const d = req.body;

  for (const champ of Soignant.CHAMPS_PROFIL) {
    if (d[champ] !== undefined) soignant[champ] = d[champ];
  }
  if (d.role !== undefined && d.role !== soignant.role) {
    // Évite qu'un médecin chef se retire lui-même ses droits de gestion.
    if (soignant.id === req.soignant.id) return res.status(400).json({ message: 'Vous ne pouvez pas modifier votre propre rôle.' });
    soignant.role = d.role;
  }
  if (d.email !== undefined) {
    const email = String(d.email).trim().toLowerCase();
    if (email !== soignant.email && await Soignant.exists({ email, _id: { $ne: soignant._id } })) {
      return res.status(409).json({ message: 'Cet e-mail est déjà utilisé.' });
    }
    soignant.email = email;
  }
  if (d.affectations !== undefined) {
    let affectations;
    try {
      // Formulaire multipart (avec photo) : chaîne JSON ; corps JSON : tableau.
      affectations = typeof d.affectations === 'string' ? JSON.parse(d.affectations) : d.affectations;
    } catch {
      return res.status(400).json({ message: 'Affectations invalides.' });
    }
    const probleme = await Etablissement.verifierAffectations(affectations);
    if (probleme) return res.status(400).json({ message: probleme });
    soignant.affectations = affectations.map((a) => ({ etablissementId: String(a.etablissementId), service: String(a.service || '').trim() }));
  }
  if (soignant.isModified('numeroOrdre') && soignant.numeroOrdre
      && await Soignant.exists({ numeroOrdre: soignant.numeroOrdre, _id: { $ne: soignant._id } })) {
    return res.status(409).json({ message: 'Ce numéro d’Ordre est déjà enregistré.' });
  }
  try {
    await soignant.validate();
  } catch (err) {
    return res.status(400).json({ message: messageValidation(err) });
  }

  const ancienneCle = soignant.photoCle || cleDepuisUrl(soignant.photo);
  if (req.file) {
    const { cle, url } = await envoyerFichier(req.file, DOSSIER_PHOTOS);
    soignant.photo = url;
    soignant.photoCle = cle;
  }
  await soignant.save();
  if (req.file && ancienneCle) await supprimerFichier(ancienneCle).catch(() => {});
  await presence.actualiser(soignant);
  await soignant.populate('creePar', Soignant.CHAMPS_AUTEUR);
  res.json(soignant);
};

exports.basculerStatut = async (req, res) => {
  const soignant = await Soignant.findById(req.params.id);
  if (!soignant) return res.status(404).json({ message: 'Soignant introuvable.' });
  if (soignant.id === req.soignant.id) return res.status(400).json({ message: 'Vous ne pouvez pas suspendre votre propre compte.' });
  soignant.statut = soignant.statut === 'Actif' ? 'Suspendu' : 'Actif';
  await soignant.save();
  // Un compte suspendu quitte aussitôt la liste des soignants en ligne.
  if (soignant.statut === 'Suspendu') presence.expulser(soignant.id);
  res.json(soignant);
};

/** Suppression définitive du compte et de sa photo dans R2. */
exports.supprimer = async (req, res) => {
  const soignant = await Soignant.findById(req.params.id).select('+photoCle');
  if (!soignant) return res.status(404).json({ message: 'Soignant introuvable.' });
  if (soignant.id === req.soignant.id) return res.status(400).json({ message: 'Vous ne pouvez pas supprimer votre propre compte.' });
  await soignant.deleteOne();
  presence.expulser(soignant.id);
  // La photo est retirée du bucket en même temps que le compte.
  const cle = soignant.photoCle || cleDepuisUrl(soignant.photo);
  if (cle) {
    await supprimerFichier(cle).catch((err) => console.error(`Photo ${cle} non supprimée de R2 :`, err.message));
  }
  res.status(204).end();
};

/** Nouveau mot de passe temporaire, renvoyé une seule fois pour être remis en personne. */
exports.reinitialiserMotDePasse = async (req, res) => {
  const soignant = await Soignant.findById(req.params.id);
  if (!soignant) return res.status(404).json({ message: 'Soignant introuvable.' });
  const motDePasse = genererMotDePasse();
  soignant.motDePasse = await bcrypt.hash(motDePasse, 12);
  soignant.doitChangerMotDePasse = true;
  await soignant.save();
  res.json({ soignant, motDePasse });
};
